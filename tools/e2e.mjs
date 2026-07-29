/**
 * End-to-end verification against real Chrome.
 *
 * Loads the built extension, captures test-pages/torture.html, and checks the
 * stitched image pixel by pixel. The fixture encodes each block's index in its
 * red channel, so a misplaced, duplicated or dropped slice shows up as the
 * wrong colour at a known height rather than as a screenshot that merely
 * "looks fine".
 *
 * Note on permissions: the shipping build uses activeTab, which is granted only
 * by a real toolbar click or keyboard shortcut, and neither can be synthesised
 * over CDP. So this harness builds a THROWAWAY variant with host access purely
 * to reach the capture engine. That variant is written to dist/e2e, is never
 * zipped, and is never gated as a release artefact. The shipping permission set
 * is verified separately by `node tools/build.mjs --check`.
 *
 *   node tools/e2e.mjs
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CDP,
  buildTestVariant,
  httpJson,
  launch,
  shutdown,
  waitFor,
} from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;

function serveFixtures() {
  const dir = path.join(ROOT, 'test-pages');
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname) || 'torture.html';
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


const VERIFY_SCRIPT = (id, fixture) => `(async () => {
  const record = await FS.store.get(${JSON.stringify(id)});
  if (!record) return { error: 'capture record missing' };

  const bitmap = await createImageBitmap(record.blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);

  const fixture = ${JSON.stringify(fixture)};
  const scale = bitmap.width / fixture.pageWidthCss;
  const column = Math.max(2, Math.round(5 * scale));
  const pixels = ctx.getImageData(column, 0, 1, bitmap.height).data;

  const at = (y) => {
    const i = Math.round(y) * 4;
    return [pixels[i], pixels[i + 1], pixels[i + 2]];
  };
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

  // Count contiguous runs of a colour, ignoring stray antialiased pixels.
  const runs = (colour, minRun) => {
    let count = 0, current = 0;
    for (let y = 0; y < bitmap.height; y++) {
      if (same(at(y), colour)) {
        current++;
      } else {
        if (current >= minRun) count++;
        current = 0;
      }
    }
    if (current >= minRun) count++;
    return count;
  };

  const minRun = Math.max(4, Math.round(20 * scale));
  const stickyBands = runs([255, 0, 255], minRun);
  const fixedBands = runs([0, 255, 255], minRun);

  // Each block encodes its index in the red channel, so the colour found at a
  // block's midpoint proves the slice covering it landed at the right offset.
  const blocks = [];
  for (let i = 0; i < fixture.blockCount; i++) {
    const centreCss = fixture.blocksTop + i * fixture.blockHeight + fixture.blockHeight / 2;
    const y = centreCss * scale;
    if (y >= bitmap.height) { blocks.push({ i, missing: true }); continue; }
    const [r, g, b] = at(y);
    blocks.push({ i, expectedRed: i * 10, red: r, ok: r === i * 10 && g === 100 && b === 200 });
  }

  // A scaled-down copy of the real capture, so the run can be eyeballed and not
  // just asserted on. Pixel checks cannot tell you that something looks wrong.
  const thumbWidth = 380;
  const thumbHeight = Math.round((bitmap.height / bitmap.width) * thumbWidth);
  const thumb = new OffscreenCanvas(thumbWidth, thumbHeight);
  thumb.getContext('2d').drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
  const thumbBlob = await thumb.convertToBlob({ type: 'image/png' });
  const thumbBase64 = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(thumbBlob);
  });

  return {
    width: bitmap.width,
    height: bitmap.height,
    scale,
    stickyBands,
    fixedBands,
    blocks,
    warnings: record.warnings ?? [],
    sliceCount: record.sliceCount,
    thumbBase64,
  };
})()`;

async function run() {
  const results = [];
  const fail = (msg) => results.push({ ok: false, msg });
  const pass = (msg) => results.push({ ok: true, msg });

  console.log('building throwaway test variant...');
  const { dir: extensionDir, extensionId } = await buildTestVariant(ROOT, 'e2e');
  console.log(`expected extension id: ${extensionId}`);

  const { server: fixtureServer, port: fixturePort } = await serveFixtures();
  console.log(`serving fixtures on 127.0.0.1:${fixturePort}`);

  let session;
  for (const headless of [true, false]) {
    try {
      console.log(`launching Chrome (${headless ? 'headless' : 'headed'})...`);
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
  if (!session) throw new Error('Could not start Chrome with the extension loaded.');

  try {
    const version = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    // Open the fixture first so it exists before the capture is triggered.
    const pageUrl = `http://127.0.0.1:${fixturePort}/torture.html`;
    const { targetId: pageTarget } = await cdp.send('Target.createTarget', { url: pageUrl });
    const pageSession = await cdp.attach(pageTarget);

    // An extension page gives us the extension's own APIs. Opening it also
    // confirms the extension really loaded under the id we predicted.
    const { targetId: controlTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options/options.html`,
    });
    const controlSession = await cdp.attach(controlTarget);
    await waitFor('extension page to load', async () => {
      const href = await cdp.evaluate(controlSession, 'location.href');
      return typeof href === 'string' && href.includes(extensionId);
    });
    pass(`extension loaded at the expected id (${extensionId})`);

    // A tab that is still loading reports no URL yet, so wait for the fixture
    // to settle before asking the extension to find it.
    await waitFor('fixture page to finish loading', async () => {
      const ready = await cdp.evaluate(
        pageSession,
        `document.readyState === 'complete' && !!window.__torture`
      );
      return ready === true;
    });

    // Configure, find the fixture tab, and focus it. captureVisibleTab
    // photographs whichever tab is active, so this must happen before capture.
    const tabId = await waitFor('fixture tab to be visible to the extension', () =>
      cdp.evaluate(
        controlSession,
        `(async () => {
           await chrome.storage.local.set({ settings: {
             openEditor: false, primeLazyContent: true, freezeMotion: true,
             retina: true, floatingPolicy: 'once', settleMs: 140, imageWaitMs: 1500,
           }});
           const tabs = await chrome.tabs.query({});
           const target = tabs.find((t) => (t.url || '').includes('torture.html'));
           if (!target) return 0;
           await chrome.tabs.update(target.id, { active: true });
           // Any message wakes the (lazy) MV3 service worker so it gets a target.
           try { await chrome.runtime.sendMessage({ type: 'FS_WAKE' }); } catch {}
           return target.id;
         })()`
      )
    );
    console.log(`fixture tab id: ${tabId}`);

    // Now that the worker is awake it has a debuggable target. Match on our own
    // background script: the browser ships component extensions with workers too.
    const worker = await waitFor('extension service worker', async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find(
        (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`
      );
    });
    const workerSession = await cdp.attach(worker.targetId);
    pass('service worker started and is reachable');

    const fixture = await waitFor('fixture geometry', async () =>
      cdp.evaluate(
        pageSession,
        `(() => {
           if (!window.__torture) return null;
           return {
             blockCount: window.__torture.blockCount,
             blockHeight: window.__torture.blockHeight,
             blocksTop: window.__torture.blocksTop,
             pageWidthCss: document.documentElement.clientWidth,
             pageHeightCss: document.documentElement.scrollHeight,
           };
         })()`
      )
    );
    console.log('fixture:', JSON.stringify(fixture));

    console.log('capturing...');
    const capture = await cdp.evaluate(workerSession, `FS.startCapture('full', ${tabId})`);
    if (!capture?.ok) throw new Error(`capture failed: ${capture?.error ?? 'unknown'}`);
    pass(`capture completed (id ${capture.id})`);

    // Verify from the extension page, which shares the extension's IndexedDB.
    // options.html does not load store.js, so inject it first.
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

    const report = await cdp.evaluate(controlSession, VERIFY_SCRIPT(capture.id, fixture));
    if (report?.error) throw new Error(report.error);

    if (report.thumbBase64) {
      const artifact = path.join(ROOT, 'dist', 'e2e-capture.png');
      await fs.writeFile(artifact, Buffer.from(report.thumbBase64, 'base64'));
      console.log(`\nwrote ${path.relative(ROOT, artifact)} for visual inspection`);
    }

    console.log('\n--- capture report ---');
    console.log(`image      : ${report.width} x ${report.height} (scale ${report.scale})`);
    console.log(`slices     : ${report.sliceCount}`);
    console.log(`sticky band: ${report.stickyBands}`);
    console.log(`fixed band : ${report.fixedBands}`);
    if (report.warnings.length) console.log(`warnings   : ${report.warnings.join(' | ')}`);

    // --- assertions -------------------------------------------------
    const expectedHeight = Math.round(fixture.pageHeightCss * report.scale);
    if (Math.abs(report.height - expectedHeight) <= Math.max(4, report.scale * 4)) {
      pass(`image height matches the full page (${report.height}px)`);
    } else {
      fail(`image height ${report.height} but the page is ${expectedHeight} at this scale`);
    }

    if (report.stickyBands === 1) pass('sticky header appears exactly once');
    else fail(`sticky header appears ${report.stickyBands} times, expected exactly 1`);

    if (report.fixedBands <= 1) pass(`fixed footer appears ${report.fixedBands} time(s), not repeated`);
    else fail(`fixed footer repeated ${report.fixedBands} times`);

    const badBlocks = report.blocks.filter((b) => !b.ok);
    if (badBlocks.length === 0) {
      pass(`all ${report.blocks.length} content blocks landed at the correct height`);
    } else {
      fail(
        `${badBlocks.length} block(s) misplaced: ` +
          badBlocks
            .slice(0, 6)
            .map((b) => (b.missing ? `#${b.i} missing` : `#${b.i} red=${b.red} want ${b.expectedRed}`))
            .join(', ')
      );
    }
    /* ---- editor ------------------------------------------------- */
    // Opening the editor consumes the stored capture, so this runs last.
    const { targetId: editorTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/editor/editor.html?id=${capture.id}`,
    });
    const editorSession = await cdp.attach(editorTarget);

    const ready = await waitFor('editor to load the capture', async () => {
      const state = await cdp.evaluate(
        editorSession,
        `(() => {
           const wrap = document.getElementById('wrap');
           const canvas = document.getElementById('canvas');
           if (!wrap || wrap.hidden || !canvas.width) return null;
           return { width: canvas.width, height: canvas.height };
         })()`
      );
      return state;
    });

    if (ready.width === report.width && ready.height === report.height) {
      pass(`editor opened the capture at full size (${ready.width} x ${ready.height})`);
    } else {
      fail(`editor shows ${ready.width}x${ready.height}, capture was ${report.width}x${report.height}`);
    }

    // Sharpening must measurably raise edge energy, or the toggle does nothing.
    const sharpening = await cdp.evaluate(
      editorSession,
      `(async () => {
         const canvas = document.getElementById('canvas');
         const ctx = canvas.getContext('2d', { willReadFrequently: true });
         // Sample a band that crosses the block edges, where text-like
         // transitions live.
         const band = () => {
           const d = ctx.getImageData(0, 0, canvas.width, Math.min(600, canvas.height)).data;
           let energy = 0;
           for (let i = 0; i < d.length - 4; i += 4) energy += Math.abs(d[i] - d[i + 4]);
           return energy;
         };
         const before = band();

         const toggle = document.getElementById('enhance');
         document.getElementById('enhance-level').value = 'strong';
         toggle.checked = true;
         toggle.dispatchEvent(new Event('change'));

         await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
         await new Promise((r) => setTimeout(r, 400));
         const after = band();

         // Also confirm the editor can still encode an image afterwards.
         const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
         return { before, after, exportedBytes: blob ? blob.size : 0 };
       })()`
    );

    if (sharpening.after > sharpening.before) {
      pass(
        `sharpen raised edge definition (${sharpening.before} to ${sharpening.after})`
      );
    } else {
      fail(`sharpen did not increase edge definition (${sharpening.before} to ${sharpening.after})`);
    }

    if (sharpening.exportedBytes > 1000) {
      pass(`editor exported a PNG (${Math.round(sharpening.exportedBytes / 1024)} KB)`);
    } else {
      fail(`editor produced no usable PNG (${sharpening.exportedBytes} bytes)`);
    }
  } finally {
    fixtureServer.close();
    await shutdown(session);
  }

  console.log('\n--- results ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error('\nE2E harness error:', err.message);
  process.exit(1);
});
