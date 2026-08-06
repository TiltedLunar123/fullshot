/**
 * End-to-end check that Fullshot never photographs its own progress card.
 *
 * The card is fixed to the top right of the viewport while a capture runs, so
 * any photograph taken while it is up paints extension UI into the user's
 * screenshot. Two things are asserted, because either one alone can pass on a
 * broken build:
 *
 *   1. At the instant of EVERY captureVisibleTab call, the overlay host is
 *      hidden. This catches paths that photograph without asking the page
 *      first, including ones whose result is later discarded.
 *   2. The finished image of a flat-coloured page contains nothing but that
 *      colour. This catches anything else the extension might leave on screen.
 *
 * Check 1 is the one that matters: the Firefox one-shot path took its
 * photograph before the agent had ever been told to put the card away, and
 * because that photograph is thrown away when the engine ignores the rect, a
 * pixel check on Chromium alone would have called that build clean.
 *
 *   node tools/e2e-overlay.mjs
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, buildTestVariant, httpJson, launch, shutdown, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9336;

function serveFixtures() {
  const dir = path.join(ROOT, 'test-pages');
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname) || 'plain.html';
    try {
      const body = await fs.readFile(path.join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Wrap captureVisibleTab so every photograph records what the page looked like
 * at that moment. Asking the page directly is the only honest way to know: the
 * background's own idea of whether it hid the card is exactly what is under
 * test.
 */
const INSTALL_SPY = (tabId) => `(() => {
  globalThis.__shots = [];
  if (globalThis.__spyInstalled) return true;
  globalThis.__spyInstalled = true;
  const real = FS.api.tabs.captureVisibleTab.bind(FS.api.tabs);
  FS.api.tabs.captureVisibleTab = async (...args) => {
    let state = 'unknown';
    try {
      const [hit] = await FS.api.scripting.executeScript({
        target: { tabId: ${tabId} },
        func: () => {
          const host = document.getElementById('fullshot-overlay');
          if (!host) return 'absent';
          const cs = getComputedStyle(host);
          if (cs.display === 'none' || cs.visibility === 'hidden') return 'hidden';
          return 'VISIBLE';
        },
      });
      state = hit?.result ?? 'unknown';
    } catch (err) {
      state = 'probe-failed: ' + String(err && err.message);
    }
    globalThis.__shots.push(state);
    return real(...args);
  };
  return true;
})()`;

const VERIFY_PIXELS = (id, colour) => `(async () => {
  const record = await FS.store.get(${JSON.stringify(id)});
  if (!record) return { error: 'capture record missing' };

  const bitmap = await createImageBitmap(record.blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);

  const want = ${JSON.stringify(colour)};
  // Ignore a hairline frame: the scrollbar gutter crop and the bottom clamp can
  // leave a blended pixel at the very edge, and that is not what is under test.
  const inset = 3;
  const w = bitmap.width - inset * 2;
  const h = bitmap.height - inset * 2;
  if (w <= 0 || h <= 0) return { error: 'image too small to inspect' };
  const data = ctx.getImageData(inset, inset, w, h).data;

  let foreign = 0;
  let firstAt = null;
  const samples = [];
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - want[0]) <= 2 &&
      Math.abs(data[i + 1] - want[1]) <= 2 &&
      Math.abs(data[i + 2] - want[2]) <= 2
    ) continue;
    foreign++;
    if (!firstAt) {
      const p = i / 4;
      firstAt = { x: (p % w) + inset, y: Math.floor(p / w) + inset };
    }
    if (samples.length < 4) samples.push([data[i], data[i + 1], data[i + 2]]);
  }

  return {
    width: bitmap.width,
    height: bitmap.height,
    sliceCount: record.sliceCount,
    foreign,
    firstAt,
    samples,
  };
})()`;

async function run() {
  const results = [];
  const fail = (msg) => results.push({ ok: false, msg });
  const pass = (msg) => results.push({ ok: true, msg });

  console.log('building throwaway test variant...');
  const { dir: extensionDir, extensionId } = await buildTestVariant(ROOT, 'e2e-overlay');

  const { server: fixtureServer, port: fixturePort } = await serveFixtures();
  console.log(`serving fixtures on 127.0.0.1:${fixturePort}`);

  let session;
  for (const headless of [true, false]) {
    try {
      console.log(`launching browser (${headless ? 'headless' : 'headed'})...`);
      session = await launch(extensionDir, { headless, port: PORT });
      break;
    } catch (err) {
      try {
        session?.child.kill();
      } catch {
        /* already gone */
      }
      session = null;
      console.log(`  ${headless ? 'headless' : 'headed'} launch failed: ${err.message}`);
    }
  }
  if (!session) throw new Error('Could not start a browser with the extension loaded.');

  try {
    const version = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    const pageUrl = `http://127.0.0.1:${fixturePort}/plain.html`;
    const shortUrl = `http://127.0.0.1:${fixturePort}/plain-short.html`;
    const { targetId: pageTarget } = await cdp.send('Target.createTarget', { url: pageUrl });
    const pageSession = await cdp.attach(pageTarget);

    const { targetId: controlTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options/options.html`,
    });
    const controlSession = await cdp.attach(controlTarget);
    await waitFor('extension page to load', async () => {
      const href = await cdp.evaluate(controlSession, 'location.href');
      return typeof href === 'string' && href.includes(extensionId);
    });

    await waitFor('fixture page to finish loading', async () => {
      const ready = await cdp.evaluate(
        pageSession,
        `document.readyState === 'complete' && !!window.__plain`
      );
      return ready === true;
    });

    const tabId = await waitFor('fixture tab to be visible to the extension', () =>
      cdp.evaluate(
        controlSession,
        `(async () => {
           await chrome.storage.local.set({ settings: {
             openEditor: false, primeLazyContent: true, freezeMotion: true,
             retina: false, floatingPolicy: 'once', settleMs: 120, imageWaitMs: 800,
           }});
           const tabs = await chrome.tabs.query({});
           const target = tabs.find((t) => (t.url || '').includes('plain.html'));
           if (!target) return 0;
           await chrome.tabs.update(target.id, { active: true });
           try { await chrome.runtime.sendMessage({ type: 'FS_WAKE' }); } catch {}
           return target.id;
         })()`
      )
    );

    const worker = await waitFor('extension service worker', async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find(
        (t) =>
          t.type === 'service_worker' &&
          t.url === `chrome-extension://${extensionId}/background.js`
      );
    });
    const workerSession = await cdp.attach(worker.targetId);

    await cdp.evaluate(workerSession, INSTALL_SPY(tabId));
    pass('capture spy installed');

    // This harness only ever drives Chromium, so a build that thinks it is on
    // Gecko here is misdetecting the engine and will take the Firefox-only
    // capture path on everybody's machine.
    const engine = await cdp.evaluate(
      workerSession,
      `({ browserGlobal: typeof browser, hasOffscreen: !!globalThis.chrome?.offscreen, isFirefox: FS.isFirefox })`
    );
    if (engine.isFirefox) fail(`engine misdetected as Firefox on Chromium: ${JSON.stringify(engine)}`);
    else pass(`engine detected as Chromium (browser global is "${engine.browserGlobal}")`);

    const colour = await cdp.evaluate(pageSession, 'window.__plain.colour');

    /* -------------------------------------------------------------- */
    /* Full page, the ordinary scroll-and-stitch path                  */
    /* -------------------------------------------------------------- */

    console.log('capturing full page...');
    await cdp.evaluate(workerSession, 'globalThis.__shots = []');

    // Hiding the card for the photograph is only half of it. If it never comes
    // back the user gets no progress and no way to cancel, so sample what the
    // page actually shows while the capture runs.
    await cdp.evaluate(
      pageSession,
      `(() => {
         window.__seen = {};
         window.__poll = setInterval(() => {
           const host = document.getElementById('fullshot-overlay');
           window.__seen[host ? getComputedStyle(host).display : 'absent'] = true;
         }, 25);
         return true;
       })()`
    );
    const capture = await cdp.evaluate(workerSession, `FS.startCapture('full', ${tabId})`);
    if (!capture?.ok) throw new Error(`capture failed: ${capture?.error ?? 'unknown'}`);

    const seen = await cdp.evaluate(
      pageSession,
      `(() => { clearInterval(window.__poll); return Object.keys(window.__seen); })()`
    );
    if (seen.includes('contents')) pass('the card was on screen between photographs');
    else fail(`the card was never shown during the capture (saw ${JSON.stringify(seen)})`);

    const shots = await cdp.evaluate(workerSession, 'globalThis.__shots');
    if (!shots.length) fail('no captures were observed, so the spy proved nothing');
    else if (shots.every((s) => s === 'hidden' || s === 'absent')) {
      pass(`full page: overlay was down for all ${shots.length} photographs`);
    } else {
      fail(`full page: overlay was up for a photograph (${JSON.stringify(shots)})`);
    }

    await cdp.evaluate(
      controlSession,
      `new Promise((resolve, reject) => {
         if (typeof FS !== 'undefined' && FS.store) return resolve(true);
         const s = document.createElement('script');
         s.src = chrome.runtime.getURL('lib/store.js');
         s.onload = () => resolve(true);
         s.onerror = () => reject(new Error('could not load store.js'));
         document.head.append(s);
       })`
    );
    const pixels = await cdp.evaluate(controlSession, VERIFY_PIXELS(capture.id, colour));
    if (pixels.error) fail(`could not inspect the image: ${pixels.error}`);
    else if (pixels.foreign === 0) pass(`image is ${pixels.width}x${pixels.height} and entirely page`);
    else
      fail(
        `image contains ${pixels.foreign} pixels that are not the page, first at ` +
          `${pixels.firstAt.x},${pixels.firstAt.y} (${JSON.stringify(pixels.samples)})`
      );

    /* -------------------------------------------------------------- */
    /* The one-shot path                                               */
    /* -------------------------------------------------------------- */

    // Only Gecko honours a full-page rect, and this harness drives Chromium, so
    // the branch is forced on. Chromium ignores the rect and the result is
    // discarded, but the photograph is still taken, which is exactly the
    // moment being inspected.
    console.log('capturing full page with the one-shot path forced on...');
    await cdp.evaluate(workerSession, 'globalThis.__shots = []; FS.isFirefox = true;');
    const oneShot = await cdp.evaluate(workerSession, `FS.startCapture('full', ${tabId})`);
    await cdp.evaluate(workerSession, 'FS.isFirefox = false');
    if (!oneShot?.ok) throw new Error(`forced one-shot capture failed: ${oneShot?.error}`);

    const oneShotShots = await cdp.evaluate(workerSession, 'globalThis.__shots');
    if (oneShotShots.length < 2) {
      fail(`one-shot: expected the one-shot attempt plus stitching, saw ${oneShotShots.length}`);
    } else if (oneShotShots.every((s) => s === 'hidden' || s === 'absent')) {
      pass(`one-shot: overlay was down for all ${oneShotShots.length} photographs`);
    } else {
      fail(`one-shot: overlay was up for a photograph (${JSON.stringify(oneShotShots)})`);
    }

    /* -------------------------------------------------------------- */
    /* A one-shot result that is actually accepted                     */
    /* -------------------------------------------------------------- */

    // A page that fits in one viewport is the case where Chromium's answer is
    // the right size despite the rect being ignored, so the one-shot image is
    // kept and becomes the entire screenshot. That is the Firefox bug exactly,
    // reproduced on a browser this harness can drive.
    console.log('capturing a short page through an accepted one-shot...');
    await cdp.evaluate(pageSession, `location.href = ${JSON.stringify(shortUrl)}`);
    await waitFor('short fixture to load', async () => {
      const ready = await cdp.evaluate(
        pageSession,
        `location.href.includes('plain-short.html') && document.readyState === 'complete' && !!window.__plain`
      );
      return ready === true;
    });

    await cdp.evaluate(workerSession, 'globalThis.__shots = []; FS.isFirefox = true;');
    const shortShot = await cdp.evaluate(workerSession, `FS.startCapture('full', ${tabId})`);
    await cdp.evaluate(workerSession, 'FS.isFirefox = false');
    if (!shortShot?.ok) throw new Error(`short page capture failed: ${shortShot?.error}`);

    // Not a count assertion: a quota rejection makes the scheduler retry, and
    // each retry is a real photograph the spy is right to record.
    const shortShots = await cdp.evaluate(workerSession, 'globalThis.__shots');
    if (!shortShots.length) fail('short page: no photographs were observed');
    else if (shortShots.every((s) => s === 'hidden')) {
      pass(`short page: overlay was down for all ${shortShots.length} photographs`);
    } else {
      fail(`short page: overlay was up for a photograph (${JSON.stringify(shortShots)})`);
    }

    const shortPixels = await cdp.evaluate(controlSession, VERIFY_PIXELS(shortShot.id, colour));
    if (shortPixels.error) fail(`could not inspect the one-shot image: ${shortPixels.error}`);
    else if (shortPixels.sliceCount !== 1) {
      fail(
        `short page: the one-shot result was not the image under test ` +
          `(${shortPixels.sliceCount} slices, so it fell through to stitching)`
      );
    } else if (shortPixels.foreign === 0) pass('one-shot image is entirely page');
    else
      fail(
        `one-shot image contains ${shortPixels.foreign} pixels that are not the page, first at ` +
          `${shortPixels.firstAt.x},${shortPixels.firstAt.y} (${JSON.stringify(shortPixels.samples)})`
      );

    /* -------------------------------------------------------------- */
    /* Visible area, which has no card at all                          */
    /* -------------------------------------------------------------- */

    await cdp.evaluate(workerSession, 'globalThis.__shots = []');
    const visible = await cdp.evaluate(workerSession, `FS.startCapture('visible', ${tabId})`);
    if (!visible?.ok) throw new Error(`visible capture failed: ${visible?.error}`);
    const visibleShots = await cdp.evaluate(workerSession, 'globalThis.__shots');
    // A capture that photographed nothing at all would satisfy `every` on an
    // empty array, so the count has to be asserted before the contents are.
    if (!visibleShots.length) {
      fail('visible area: the spy recorded no photographs, so this proves nothing');
    } else if (visibleShots.every((s) => s === 'hidden' || s === 'absent')) {
      pass(`visible area: overlay was down for all ${visibleShots.length} photographs`);
    } else {
      fail(`visible area: overlay was up for a photograph (${JSON.stringify(visibleShots)})`);
    }

    /* -------------------------------------------------------------- */
    /* And the page is handed back without our furniture               */
    /* -------------------------------------------------------------- */

    const leftovers = await cdp.evaluate(
      pageSession,
      `(() => ({
         overlay: !!document.getElementById('fullshot-overlay'),
         style: !!document.getElementById('fullshot-capture-style'),
         hidden: document.querySelectorAll('[data-fullshot-hide]').length,
       }))()`
    );
    if (!leftovers.overlay && !leftovers.style && leftovers.hidden === 0) {
      pass('page was handed back with nothing of ours left on it');
    } else {
      fail(`extension furniture left on the page: ${JSON.stringify(leftovers)}`);
    }
  } finally {
    fixtureServer.close();
    await shutdown(session);
  }

  console.log('');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
