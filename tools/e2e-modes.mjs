/**
 * End-to-end verification of the four capture modes.
 *
 * Full page is covered by tools/e2e.mjs. This one covers the three that are
 * easy to get subtly wrong and hard to eyeball:
 *
 *   visible  - must be viewport sized, NOT the page stretched to fit
 *   element  - must capture the element wherever it sits on the page
 *   area     - must scroll an inner pane and stitch its whole content
 *
 * The fixture encodes indices in the red channel (blocks i*10, pane rows i*8),
 * so a wrong offset shows up as the wrong colour at a known height.
 *
 *   node tools/e2e-modes.mjs
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, buildTestVariant, httpJson, launch, shutdown, waitFor, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9337;

const results = [];
const pass = (msg) => results.push({ ok: true, msg });
const fail = (msg) => results.push({ ok: false, msg });
const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

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
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  );
}

/** Read back a stored capture and sample it. Runs in an extension page. */
const INSPECT = (id) => `(async () => {
  const record = await FS.store.get(${JSON.stringify(id)});
  if (!record) return { error: 'capture record missing' };
  const bitmap = await createImageBitmap(record.blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  globalThis.__shot = { bitmap, ctx };
  return { width: bitmap.width, height: bitmap.height, warnings: record.warnings ?? [] };
})()`;

const SAMPLE = (x, y) => `(() => {
  const d = globalThis.__shot.ctx.getImageData(${Math.round(x)}, ${Math.round(y)}, 1, 1).data;
  return [d[0], d[1], d[2]];
})()`;

/** Height of the leading run of a colour down a column, in pixels. */
const BAND = (colour, column) => `(() => {
  const { bitmap, ctx } = globalThis.__shot;
  const d = ctx.getImageData(${column}, 0, 1, bitmap.height).data;
  const [r, g, b] = ${JSON.stringify(colour)};
  let n = 0;
  for (let y = 0; y < bitmap.height; y++) {
    const i = y * 4;
    if (d[i] === r && d[i + 1] === g && d[i + 2] === b) n++;
    else if (n > 0) break;
  }
  return n;
})()`;

async function run() {
  console.log('building throwaway test variant...');
  const { dir, extensionId } = await buildTestVariant(ROOT, 'e2e-modes');
  const { server: fixtureServer, port: fixturePort } = await serveFixtures();

  console.log('launching browser...');
  const session = await launch(dir, { port: PORT, headless: true, window: '1280,900' });

  try {
    const version = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    const { targetId: pageTarget } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${fixturePort}/torture.html`,
    });
    const page = await cdp.attach(pageTarget);

    const { targetId: controlTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options/options.html`,
    });
    const control = await cdp.attach(controlTarget);
    await waitFor('extension page', async () => {
      const href = await cdp.evaluate(control, 'location.href');
      return typeof href === 'string' && href.includes(extensionId);
    });
    await cdp.evaluate(
      control,
      `new Promise((res, rej) => {
         if (globalThis.FS && FS.store) return res(true);
         const s = document.createElement('script');
         s.src = chrome.runtime.getURL('lib/store.js');
         s.onload = () => res(true); s.onerror = rej;
         document.head.append(s);
       })`
    );

    await waitFor('fixture to load', async () =>
      (await cdp.evaluate(page, `document.readyState === 'complete' && !!window.__torture`)) === true
    );

    const tabId = await waitFor('fixture tab', () =>
      cdp.evaluate(
        control,
        `(async () => {
           await chrome.storage.local.set({ settings: {
             openEditor: false, primeLazyContent: true, freezeMotion: true,
             retina: true, floatingPolicy: 'once', settleMs: 140, imageWaitMs: 1200,
           }});
           const tabs = await chrome.tabs.query({});
           const t = tabs.find((x) => (x.url || '').includes('torture.html'));
           if (!t) return 0;
           await chrome.tabs.update(t.id, { active: true });
           try { await chrome.runtime.sendMessage({ type: 'FS_WAKE' }); } catch {}
           return t.id;
         })()`
      )
    );

    const worker = await waitFor('service worker', async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find(
        (t) => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`
      );
    });
    const sw = await cdp.attach(worker.targetId);
    pass('extension loaded and reachable');

    const geometry = await cdp.evaluate(
      page,
      `(() => ({
         dpr: window.devicePixelRatio,
         innerWidth: window.innerWidth,
         innerHeight: window.innerHeight,
         clientWidth: document.documentElement.clientWidth,
         clientHeight: document.documentElement.clientHeight,
         pageHeight: document.documentElement.scrollHeight,
         blockCount: window.__torture.blockCount,
         paneRows: window.__torture.paneRows,
         paneRowHeight: window.__torture.paneRowHeight,
       }))()`
    );
    const usableW = geometry.clientWidth;
    const usableH = geometry.clientHeight;
    console.log(
      `viewport ${geometry.innerWidth}x${geometry.innerHeight}, usable ${usableW}x${usableH}, ` +
        `page ${geometry.pageHeight}, dpr ${geometry.dpr}`
    );

    /**
     * Kick off a capture that needs a picker click, then click, then await.
     *
     * `pointExpr` is evaluated in the page AFTER the picker is up, not before.
     * The fixture sets scroll-behavior: smooth, so any coordinate measured
     * before a scrollIntoView has settled is stale by the time it is clicked.
     */
    const captureWithPick = async (mode, pointExpr) => {
      await cdp.evaluate(sw, `globalThis.__pending = FS.startCapture('${mode}', ${tabId}); true`);

      // Wait for the picker overlay to actually exist before aiming at it.
      await waitFor(`${mode} picker`, async () =>
        (await cdp.evaluate(page, `!!document.getElementById('fullshot-overlay') ||
           !!document.querySelector('div[style*="2147483646"]')`)) === true
      ).catch(() => null);
      await sleep(600);

      const point = await cdp.evaluate(page, pointExpr);
      if (!point) throw new Error(`could not resolve a click point for ${mode}`);

      // The picker tracks the pointer, so it needs a move before the click.
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 },
        page
      );
      await sleep(300);

      // What the picker would resolve to, for diagnostics if this goes wrong.
      const under = await cdp.evaluate(
        page,
        `(() => {
           const el = document.elementFromPoint(${point.x}, ${point.y});
           return el ? (el.tagName + '.' + (el.className || '') + '#' + (el.id || '')) : 'none';
         })()`
      );
      console.log(`  ${mode}: clicking (${point.x}, ${point.y}) over ${under}`);

      await cdp.click(page, point);
      const result = await cdp.evaluate(sw, `globalThis.__pending`);
      if (!result?.ok) console.log(`  ${mode} raw result: ${JSON.stringify(result)}`);
      return { result, point };
    };

    /** Scroll instantly; the fixture's smooth scrolling makes waits unreliable. */
    const scrollTo = async (y) => {
      await cdp.evaluate(
        page,
        `(() => {
           document.documentElement.style.scrollBehavior = 'auto';
           window.scrollTo(0, ${y});
           return true;
         })()`
      );
      await sleep(400);
    };

    /* ---- full page, starting from the BOTTOM ---------------------- */
    // Every other harness starts at the top of the page, so the "user is
    // already scrolled down" path was never covered. Reported symptom: the
    // capture only goes downward from wherever you are.
    const blocksTop = await cdp.evaluate(page, `window.__torture.blocksTop`);
    await scrollTo(geometry.pageHeight);
    const startedAt = await cdp.evaluate(page, `window.scrollY`);
    console.log(`scrolled to bottom: scrollY=${startedAt}`);

    const fromBottom = await cdp.evaluate(sw, `FS.startCapture('full', ${tabId})`);
    if (!fromBottom?.ok) throw new Error(`capture failed: ${fromBottom?.error}`);
    const fbShot = await cdp.evaluate(control, INSPECT(fromBottom.id));
    const expectedFull = Math.round(geometry.pageHeight * geometry.dpr);
    console.log(`from bottom: ${fbShot.width}x${fbShot.height}, expected height ${expectedFull}`);

    check(
      Math.abs(fbShot.height - expectedFull) <= 6,
      `Full capture from the bottom is the whole page (${fbShot.height}px)`,
      `Full capture from the bottom is ${fbShot.height}px, expected ${expectedFull}px`
    );

    const fbBad = [];
    for (let i = 0; i < geometry.blockCount; i++) {
      const y = (blocksTop + i * 200 + 100) * geometry.dpr;
      if (y >= fbShot.height) { fbBad.push(`#${i} missing`); continue; }
      const [r, g, b] = await cdp.evaluate(control, SAMPLE(5, y));
      if (!(r === i * 10 && g === 100 && b === 200)) fbBad.push(`#${i} rgb(${r},${g},${b})`);
    }
    check(
      fbBad.length === 0,
      `All ${geometry.blockCount} blocks correct when starting from the bottom`,
      `${fbBad.length} block(s) wrong from the bottom: ${fbBad.slice(0, 5).join(', ')}`
    );

    /* ---- visible ------------------------------------------------- */
    // Scroll somewhere non-trivial so a page-origin bug cannot pass by luck.
    await cdp.evaluate(page, `window.scrollTo(0, 900); true`);
    await sleep(400);

    const before = await cdp.evaluate(page, `(() => ({
      innerH: window.innerHeight,
      clientH: document.documentElement.clientHeight,
      innerW: window.innerWidth,
      clientW: document.documentElement.clientWidth,
      scrollY: window.scrollY,
      pageH: document.documentElement.scrollHeight,
      leftovers: document.querySelectorAll('#fullshot-overlay, #fullshot-capture-style, [data-fullshot-hide], [data-fullshot-sticky]').length,
      htmlStyle: document.documentElement.getAttribute('style') || '',
      bodyOverflow: getComputedStyle(document.body).overflow,
    }))()`);
    console.log('pre-visible state:', JSON.stringify(before));

    const visible = await cdp.evaluate(sw, `FS.startCapture('visible', ${tabId})`);
    if (!visible?.ok) throw new Error(`visible capture failed: ${visible?.error}`);

    const vShot = await cdp.evaluate(control, INSPECT(visible.id));
    const expectedVW = Math.round(before.clientW * geometry.dpr);
    const expectedVH = Math.round(before.clientH * geometry.dpr);
    console.log(`visible: ${vShot.width}x${vShot.height}, expected ~${expectedVW}x${expectedVH}`);

    check(
      Math.abs(vShot.height - expectedVH) <= 4,
      `Visible capture is viewport height (${vShot.height}px, not the ${Math.round(before.pageH * geometry.dpr)}px page)`,
      `Visible capture is ${vShot.height}px but the viewport is ${expectedVH}px (page is ${Math.round(before.pageH * geometry.dpr)}px)`
    );
    check(
      Math.abs(vShot.width - expectedVW) <= 4,
      `Visible capture is viewport width (${vShot.width}px)`,
      `Visible capture is ${vShot.width}px wide, expected ${expectedVW}px`
    );

    // Aspect ratio is the direct test for stretching: a viewport-shaped image
    // squeezed onto a page-shaped canvas would be wildly taller than wide.
    const vAspect = vShot.width / vShot.height;
    const trueAspect = before.clientW / before.clientH;
    check(
      Math.abs(vAspect - trueAspect) < 0.02,
      `Visible capture is not stretched (aspect ${vAspect.toFixed(3)} vs ${trueAspect.toFixed(3)})`,
      `Visible capture is stretched (aspect ${vAspect.toFixed(3)} vs true ${trueAspect.toFixed(3)})`
    );

    /* ---- element ------------------------------------------------- */
    // Block 6 sits well down the page, so capturing the page's top-left
    // instead of the element would be obvious.
    const blockIndex = 6;
    // Put block 6 on screen. It starts at 60 + 6*200 = 1260 down the page, so
    // capturing the page origin instead of the element would be unmistakable.
    await scrollTo(blockIndex * 200 + 60 - 200);

    const blockExpr = `(() => {
      const el = document.querySelector('.block[data-index="${blockIndex}"]');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2),
               width: Math.round(r.width), height: Math.round(r.height) };
    })()`;

    const { result: element, point: blockPoint } = await captureWithPick('element', blockExpr);
    if (!element?.ok) {
      fail(`Element capture failed: ${element?.error ?? element?.cancelled ? 'picker cancelled' : 'unknown'}`);
    } else {
      const eShot = await cdp.evaluate(control, INSPECT(element.id));
      const expEH = Math.round(blockPoint.height * geometry.dpr);
      const expEW = Math.round(blockPoint.width * geometry.dpr);
      console.log(`element: ${eShot.width}x${eShot.height}, expected ~${expEW}x${expEH}`);

      check(
        Math.abs(eShot.height - expEH) <= 6,
        `Element capture is the element's height (${eShot.height}px)`,
        `Element capture is ${eShot.height}px, expected ${expEH}px`
      );
      check(
        Math.abs(eShot.width - expEW) <= 6,
        `Element capture is the element's width (${eShot.width}px)`,
        `Element capture is ${eShot.width}px, expected ${expEW}px`
      );

      // The whole image must be THAT block's colour. If the region offset were
      // dropped, this would be the page header or block 0 instead.
      const expected = [blockIndex * 10, 100, 200];
      const samples = await Promise.all(
        [0.15, 0.5, 0.85].map((f) =>
          cdp.evaluate(control, SAMPLE(6, Math.floor(eShot.height * f)))
        )
      );
      const allMatch = samples.every(
        (s) => s[0] === expected[0] && s[1] === expected[1] && s[2] === expected[2]
      );
      check(
        allMatch,
        `Element capture contains block ${blockIndex} and nothing else (rgb ${samples[0]})`,
        `Element capture shows the wrong content: got ${JSON.stringify(samples)}, expected rgb ${expected}`
      );
    }

    /* ---- area (scrolling panel) ---------------------------------- */
    // The pane sits below all twenty blocks, so scroll near the bottom.
    await cdp.evaluate(page, `document.getElementById('inner-pane').scrollTop = 0; true`);
    await scrollTo(geometry.pageHeight);

    const paneExpr = `(() => {
      const el = document.getElementById('inner-pane');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + 20),
               clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
               clientWidth: el.clientWidth };
    })()`;

    const { result: area, point: panePoint } = await captureWithPick('area', paneExpr);
    console.log(
      `pane: client ${panePoint?.clientWidth}x${panePoint?.clientHeight}, scrollHeight ${panePoint?.scrollHeight}`
    );

    if (!area?.ok) {
      fail(`Scrolling panel capture failed: ${area?.error ?? (area?.cancelled ? 'picker cancelled' : 'unknown')}`);
    } else {
      const aShot = await cdp.evaluate(control, INSPECT(area.id));
      const expAH = Math.round(panePoint.scrollHeight * geometry.dpr);
      console.log(`area: ${aShot.width}x${aShot.height}, expected height ~${expAH}`);

      check(
        Math.abs(aShot.height - expAH) <= 8,
        `Scrolling panel captured its full scroll height (${aShot.height}px, pane is only ${Math.round(panePoint.clientHeight * geometry.dpr)}px on screen)`,
        `Scrolling panel is ${aShot.height}px, expected ${expAH}px`
      );

      // Every row, in order. This is what proves the pane really scrolled and
      // stitched rather than repeating the first screenful.
      const rowSamples = [];
      for (let i = 0; i < geometry.paneRows; i++) {
        const y = (i * geometry.paneRowHeight + geometry.paneRowHeight / 2) * geometry.dpr;
        if (y >= aShot.height) {
          rowSamples.push({ i, missing: true });
          continue;
        }
        const [r, g, b] = await cdp.evaluate(control, SAMPLE(8, y));
        rowSamples.push({ i, r, g, b, ok: r === i * 8 && g === 60 && b === 120 });
      }
      const badRows = rowSamples.filter((s) => !s.ok);
      check(
        badRows.length === 0,
        `All ${geometry.paneRows} panel rows landed at the correct height`,
        `${badRows.length} panel row(s) wrong: ` +
          badRows
            .slice(0, 6)
            .map((s) => (s.missing ? `#${s.i} missing` : `#${s.i} rgb(${s.r},${s.g},${s.b}) want rgb(${s.i * 8},60,120)`))
            .join(', ')
      );

      if (aShot.warnings?.length) console.log(`area warnings: ${aShot.warnings.join(' | ')}`);
    }
  } finally {
    fixtureServer.close();
    await shutdown(session);
  }

  console.log('\n--- mode results ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
