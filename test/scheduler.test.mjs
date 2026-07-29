import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helper.mjs';

// scheduler.js depends on FS.sleep, which normally comes from browser.js.
// browser.js touches the extension globals, so seed a fast fake instead: the
// tests care about the adaptation logic, not about real elapsed time.
globalThis.FS = globalThis.FS ?? {};
globalThis.FS.sleep = () => Promise.resolve();

const FS = await loadLibs(['scheduler']);

const quotaError = () =>
  new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');

test('recognises the browser quota rejection', () => {
  const { CaptureScheduler } = FS;
  assert.ok(CaptureScheduler.isQuotaError(quotaError()));
  assert.ok(CaptureScheduler.isQuotaError(new Error('Too many requests')));
  assert.ok(!CaptureScheduler.isQuotaError(new Error('Cannot access a chrome:// URL')));
});

test('returns the result and counts a success', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 0, minInterval: 0 });
  assert.equal(await scheduler.run(async () => 'bitmap'), 'bitmap');
});

test('retries a quota rejection instead of losing the slice', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 0 });
  let attempts = 0;

  const result = await scheduler.run(async () => {
    attempts++;
    if (attempts < 3) throw quotaError();
    return 'captured';
  });

  assert.equal(result, 'captured', 'the slice must survive a quota rejection');
  assert.equal(attempts, 3);
  assert.equal(scheduler.stats().quotaHits, 2);
});

test('backs off after a quota rejection', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 500 });
  const before = scheduler.interval;
  let first = true;

  await scheduler.run(async () => {
    if (first) {
      first = false;
      throw quotaError();
    }
    return 'ok';
  });

  assert.ok(scheduler.interval > before, 'interval should grow after being throttled');
});

test('backoff is capped so a bad page cannot stall forever', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 500, maxInterval: 1200, maxRetries: 20 });
  let attempts = 0;

  await scheduler.run(async () => {
    attempts++;
    if (attempts < 15) throw quotaError();
    return 'ok';
  });

  assert.equal(scheduler.interval, 1200, 'interval must stop growing at the ceiling');
});

test('speeds up on a sustained run of successes', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 500, minInterval: 220, speedUpAfter: 4 });
  const before = scheduler.interval;

  for (let i = 0; i < 4; i++) await scheduler.run(async () => 'ok');

  assert.ok(
    scheduler.interval < before,
    'a browser that does not enforce the documented limit should be discovered'
  );
});

test('never speeds up past the floor', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 240, minInterval: 220, speedUpAfter: 1 });
  for (let i = 0; i < 40; i++) await scheduler.run(async () => 'ok');
  assert.equal(scheduler.interval, 220);
});

test('gives up after maxRetries rather than looping forever', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 0, maxRetries: 3 });
  let attempts = 0;

  await assert.rejects(
    scheduler.run(async () => {
      attempts++;
      throw quotaError();
    })
  );
  // The initial attempt plus maxRetries.
  assert.equal(attempts, 4);
});

test('propagates a non-quota error immediately', async () => {
  const scheduler = new FS.CaptureScheduler({ startInterval: 0 });
  let attempts = 0;

  await assert.rejects(
    scheduler.run(async () => {
      attempts++;
      throw new Error('Cannot access contents of the page');
    }),
    /Cannot access/
  );
  assert.equal(attempts, 1, 'a permission error must not be retried six times');
});
