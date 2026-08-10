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
      fail(`Element capture failed: ${element?.error ?? (element?.cancelled ? 'picker cancelled' : 'unknown')}`);
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

    /* ---- element, fixed position --------------------------------- */
    // A fixed element does not live at a document coordinate, so turning its
    // viewport rect into one by adding the scroll offset names a place it is
    // not. Scrolling to that place then leaves the element exactly where it
    // already was and the capture takes whatever the viewport now shows there.
    // The cookie banner is 90px down and bright yellow, so a capture of the
    // wrong strip is unmistakable.
    await scrollTo(1400);

    const bannerExpr = `(() => {
      const el = document.getElementById('cookie-banner');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               width: Math.round(r.width), height: Math.round(r.height) };
    })()`;

    const { result: banner, point: bannerPoint } = await captureWithPick('element', bannerExpr);
    if (!banner?.ok) {
      fail(`Fixed element capture failed: ${banner?.error ?? (banner?.cancelled ? 'picker cancelled' : 'unknown')}`);
    } else {
      const bShot = await cdp.evaluate(control, INSPECT(banner.id));
      console.log(`fixed element: ${bShot.width}x${bShot.height}, banner is ${bannerPoint.width}x${bannerPoint.height} css`);

      // #facc15. Sample inside the banner's padding, away from its rounded
      // corners and its text.
      const samples = await Promise.all(
        [0.25, 0.5, 0.75].map((f) =>
          cdp.evaluate(control, SAMPLE(Math.floor(bShot.width * 0.5), Math.floor(bShot.height * f)))
        )
      );
      const yellow = samples.filter((s) => s[0] === 250 && s[1] === 204 && s[2] === 21).length;
      check(
        yellow >= 2,
        `Fixed element capture is the banner itself (rgb ${samples[1]})`,
        `Fixed element capture shows the wrong part of the page: got ${JSON.stringify(samples)}, expected rgb 250,204,21`
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

    /* ---- area, pane TALLER than the window ------------------------ */
    // The pane above is smaller than the viewport, so its own scrollTop can
    // reach every row. A pane taller than the window cannot: once scrollTop is
    // at its maximum the last screenful of content is sitting at the bottom of
    // the pane's box, off screen below, and asking for more simply clamps. Runs
    // last, and on its own page, so it cannot disturb anything above.
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${fixturePort}/tall-pane.html` }, page);
    await waitFor('tall pane fixture', async () => cdp.evaluate(page, `window.__tallPane ?? null`));
    const tall = await cdp.evaluate(page, `window.__tallPane`);
    console.log(`tall pane: client ${tall.clientHeight}, scrollHeight ${tall.scrollHeight}, rows ${tall.rows}`);
    await scrollTo(0);

    const tallExpr = `(() => {
      const el = document.getElementById('pane');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + 20) };
    })()`;

    const { result: tallArea } = await captureWithPick('area', tallExpr);
    if (!tallArea?.ok) {
      fail(`Tall panel capture failed: ${tallArea?.error ?? (tallArea?.cancelled ? 'picker cancelled' : 'unknown')}`);
    } else {
      const tShot = await cdp.evaluate(control, INSPECT(tallArea.id));
      const expTH = Math.round(tall.scrollHeight * geometry.dpr);
      console.log(`tall area: ${tShot.width}x${tShot.height}, expected height ~${expTH}`);

      const tallRows = [];
      for (let i = 0; i < tall.rows; i++) {
        const y = (i * tall.rowHeight + tall.rowHeight / 2) * geometry.dpr;
        if (y >= tShot.height) {
          tallRows.push({ i, missing: true });
          continue;
        }
        const [r, g, b] = await cdp.evaluate(control, SAMPLE(8, y));
        tallRows.push({ i, r, g, b, ok: r === i * 8 && g === 90 && b === 160 });
      }
      const badTall = tallRows.filter((s) => !s.ok);
      check(
        badTall.length === 0,
        `Every row of a pane taller than the window was captured (${tall.rows} rows, pane box ${tall.clientHeight}px)`,
        `${badTall.length} row(s) of the tall pane wrong: ` +
          badTall
            .slice(0, 6)
            .map((s) => (s.missing ? `#${s.i} missing` : `#${s.i} rgb(${s.r},${s.g},${s.b}) want rgb(${s.i * 8},90,160)`))
            .join(', ')
      );
    }

    /* ---- element mode INSIDE a scrolling panel --------------------- */
    // The wrapper holding the rows is 3000px tall and the panel only ever
    // shows 1088px of it. The rest of that box is drawn nowhere, so capturing
    // it as measured walked the document past the panel and photographed the
    // page background as though it were the element: right size, wrong
    // picture. Runs on the same fixture, which is already loaded.
    await cdp.evaluate(page, `document.getElementById('pane').scrollTop = 0; true`);
    await scrollTo(0);

    const rowsExpr = `(() => {
      const pane = document.getElementById('pane');
      const rows = document.getElementById('rows');
      const pr = pane.getBoundingClientRect();
      const rr = rows.getBoundingClientRect();
      return {
        x: Math.round(rr.right - 30),
        y: Math.round(pr.top + 60),
        wrapperHeight: Math.round(rr.height),
        paneClientHeight: pane.clientHeight,
      };
    })()`;

    const { result: inPane, point: rowsPoint } = await captureWithPick('element', rowsExpr);
    if (!inPane?.ok) {
      fail(`Element inside a panel failed: ${inPane?.error ?? (inPane?.cancelled ? 'picker cancelled' : 'unknown')}`);
    } else {
      const pShot = await cdp.evaluate(control, INSPECT(inPane.id));
      const expectVisible = Math.round(rowsPoint.paneClientHeight * geometry.dpr);
      const wholeBox = Math.round(rowsPoint.wrapperHeight * geometry.dpr);
      console.log(
        `element in panel: ${pShot.width}x${pShot.height}, panel shows ${expectVisible}px of a ${wholeBox}px element`
      );

      check(
        Math.abs(pShot.height - expectVisible) <= 12,
        `An element taller than its panel was captured at the height the panel shows (${pShot.height}px, not the element's full ${wholeBox}px)`,
        `Element in a panel is ${pShot.height}px, expected ~${expectVisible}px (its whole box is ${wholeBox}px)`
      );

      // Size alone is not proof. Every row the panel shows has to be present,
      // in order, with no page background stitched in behind it.
      const visibleRows = Math.floor(rowsPoint.paneClientHeight / tall.rowHeight);
      const paneRows = [];
      for (let i = 0; i < visibleRows; i++) {
        const y = (i * tall.rowHeight + tall.rowHeight / 2) * geometry.dpr;
        if (y >= pShot.height) {
          paneRows.push({ i, missing: true });
          continue;
        }
        const [r, g, b] = await cdp.evaluate(control, SAMPLE(8, y));
        paneRows.push({ i, r, g, b, ok: r === i * 8 && g === 90 && b === 160 });
      }
      // The bottom of the image is where the old behaviour showed itself: past
      // the panel's edge there is nothing but the page's own dark background,
      // and it was being stitched in as though it were part of the element.
      const [br, bg, bb] = await cdp.evaluate(control, SAMPLE(8, pShot.height - 4));
      check(
        bg === 90 && bb === 160,
        `The last row of the element capture is panel content, not the page behind it (rgb ${br},${bg},${bb})`,
        `The bottom of the element capture is rgb(${br},${bg},${bb}), which is not a panel row`
      );

      const badPaneRows = paneRows.filter((s) => !s.ok);
      check(
        badPaneRows.length === 0,
        `Every row the panel shows is in the element capture, with no page behind it (${visibleRows} rows)`,
        `${badPaneRows.length} row(s) wrong in the panelled element capture: ` +
          badPaneRows
            .slice(0, 6)
            .map((s) => (s.missing ? `#${s.i} missing` : `#${s.i} rgb(${s.r},${s.g},${s.b}) want rgb(${s.i * 8},90,160)`))
            .join(', ')
      );
    }

    /* ---- wide pages, left to right and right to left -------------- */
    // Nothing else in test-pages is wider than the viewport, so the multi-column
    // tile grid and the horizontal scroll read-back had no coverage at all. The
    // right-to-left run is the interesting one: such a page scrolls from a
    // negative offset up to zero, not from zero up to a positive one.
    for (const rtl of [false, true]) {
      const label = rtl ? 'right to left' : 'left to right';
      await cdp.send(
        'Page.navigate',
        { url: `http://127.0.0.1:${fixturePort}/wide-page.html${rtl ? '?rtl=1' : ''}` },
        page
      );
      await waitFor(`wide fixture (${label})`, async () => cdp.evaluate(page, `window.__widePage ?? null`));
      const wide = await cdp.evaluate(page, `window.__widePage`);
      console.log(`wide page (${label}): ${wide.pageWidth}px across a ${wide.clientWidth}px viewport`);

      const capture = await cdp.evaluate(sw, `FS.startCapture('full', ${tabId})`);
      if (!capture?.ok) {
        fail(`Wide ${label} capture failed: ${capture?.error ?? 'unknown'}`);
        continue;
      }
      const wShot = await cdp.evaluate(control, INSPECT(capture.id));
      console.log(`wide ${label}: ${wShot.width}x${wShot.height}, expected width ~${Math.round(wide.pageWidth * geometry.dpr)}`);

      // Sample the middle of every column, a quarter of the way down. Not
      // halfway: each column's label is a single line centred vertically, so
      // the midpoint lands on white glyphs rather than on the column's colour.
      const sampleY = Math.floor(wShot.height * 0.25);
      const cols = [];
      for (let i = 0; i < wide.columns; i++) {
        const x = (i * wide.columnWidth + wide.columnWidth / 2) * geometry.dpr;
        if (x >= wShot.width) {
          cols.push({ i, missing: true });
          continue;
        }
        // A screenshot has to look like the page. The columns are flex items, so
        // laying the page out right to left puts column 0 at the RIGHT: the
        // correct image is the mirrored order, not the source order.
        const want = (rtl ? wide.columns - 1 - i : i) * 8;
        const [r, g, b] = await cdp.evaluate(control, SAMPLE(x, sampleY));
        cols.push({ i, want, r, g, b, ok: r === want && g === 120 && b === 60 });
      }
      const badCols = cols.filter((c) => !c.ok);
      check(
        badCols.length === 0,
        `Every column of a ${label} page wider than the viewport was captured (${wide.columns} columns)`,
        `${badCols.length} column(s) wrong on the ${label} page: ` +
          badCols
            .slice(0, 6)
            .map((c) => (c.missing ? `#${c.i} missing` : `#${c.i} rgb(${c.r},${c.g},${c.b}) want rgb(${c.want},120,60)`))
            .join(', ')
      );
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
