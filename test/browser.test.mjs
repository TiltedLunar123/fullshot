import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helper.mjs';

// lib/browser.js reads whichever namespace the engine provides, so a stand-in
// has to exist before it runs. This one is Chromium shaped: a `chrome` with no
// Gecko-only `runtime.getBrowserInfo` next to it.
globalThis.chrome = { runtime: {} };
const FS = await loadLibs(['browser']);

const LOCAL_FILE = 'file:///C:/Users/someone/Documents/invoice.html';

/** Stand in for the extension namespace for the length of one assertion. */
async function withApi(api, fn) {
  const previous = FS.api;
  FS.api = api;
  try {
    return await fn();
  } finally {
    FS.api = previous;
  }
}

test('a local file is capturable once the browser has granted file access', () => {
  // The regression: this used to refuse every file:// URL outright, including
  // for the users who had gone and ticked "Allow access to file URLs", which
  // left no way whatsoever to capture a local file.
  assert.equal(FS.restrictionFor(LOCAL_FILE, true), null);
});

test('a local file is refused, with the fix, when file access is off', () => {
  const message = FS.restrictionFor(LOCAL_FILE, false);
  assert.ok(message, 'a file:// URL with no file access must be refused');
  // The refusal has to name the switch, because it is the whole remedy.
  assert.match(message, /Allow access to file URLs/);
});

test('file access is assumed absent when the caller does not say', () => {
  // Refusing is the safe default: a caller that forgets to probe gets a
  // sentence the user can act on, not a capture that dies inside the browser.
  assert.ok(FS.restrictionFor(LOCAL_FILE));
});

test('file access changes nothing for ordinary and blocked pages', () => {
  for (const granted of [true, false]) {
    assert.equal(FS.restrictionFor('https://example.com/page', granted), null);
    assert.match(FS.restrictionFor('chrome://settings', granted), /Browsers block/);
    assert.match(FS.restrictionFor('', granted), /no address/);
  }
});

test('isFileUrl spots a local file and nothing else', () => {
  assert.equal(FS.isFileUrl('file:///tmp/page.html'), true);
  assert.equal(FS.isFileUrl('FILE:///tmp/page.html'), true);
  assert.equal(FS.isFileUrl('https://example.com/file://not-really'), false);
  assert.equal(FS.isFileUrl(undefined), false);
});

test('canAccessFiles reports whatever the browser answers', async () => {
  for (const allowed of [true, false]) {
    const api = { extension: { isAllowedFileSchemeAccess: (cb) => cb(allowed) } };
    assert.equal(await withApi(api, () => FS.canAccessFiles()), allowed);
  }
});

test('canAccessFiles answers no rather than throwing', async () => {
  // No such API on this engine.
  assert.equal(await withApi({}, () => FS.canAccessFiles()), false);

  // Present but unhappy. Refusing beats letting the capture start.
  const angry = {
    extension: {
      isAllowedFileSchemeAccess() {
        throw new Error('nope');
      },
    },
  };
  assert.equal(await withApi(angry, () => FS.canAccessFiles()), false);
});

test('canAccessFiles accepts a promise instead of a callback', async () => {
  const api = { extension: { isAllowedFileSchemeAccess: () => Promise.resolve(true) } };
  assert.equal(await withApi(api, () => FS.canAccessFiles()), true);
});

// Must stay last: it reloads the library against Gecko-shaped globals, and
// FS.isFirefox is worked out once, when the file runs.
test('Firefox is told the truth instead of being sent to a switch it lacks', async () => {
  let asked = 0;
  globalThis.browser = {
    runtime: { getBrowserInfo: () => Promise.resolve({ name: 'Firefox' }) },
    extension: {
      isAllowedFileSchemeAccess: (cb) => {
        asked++;
        cb(true);
      },
    },
  };
  await loadLibs(['browser']);
  assert.equal(FS.isFirefox, true, 'the Gecko stand-in should be detected as Firefox');

  // Firefox has no per-extension file access switch. Reaching file:// there
  // needs the file:///* host permission, which Fullshot does not request, so
  // there is nothing to ask and nowhere to send the user.
  assert.equal(await FS.canAccessFiles(), false);
  assert.equal(asked, 0, 'Firefox has no such setting to interrogate');
  assert.match(FS.restrictionFor(LOCAL_FILE, await FS.canAccessFiles()), /on Firefox/);
});
