/**
 * Regression test for the "only scrolls down" bug.
 *
 * Reported symptom: starting at the bottom of a page, a full page capture did
 * not return to the top, so everything above where the user was came out
 * blank.
 *
 * Cause: window.scrollTo is a request, not a guarantee. Nothing verified that
 * it landed, and slices are placed at the MEASURED offset, so a page that
 * ignored or undid the scroll produced an image filled only from the user's
 * position downward.
 *
 * The fixture fights the first two attempts to reach the top, which a single
 * unverified scrollTo loses outright.
 *
 *   node tools/e2e-scroll.mjs
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, buildTestVariant, httpJson, launch, shutdown, waitFor, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9341;
// How many times the fixture undoes a scroll to the top. The agent retries a
// bounded number of times, so a high value here is expected to FAIL: that is
// how this harness proves it can still detect the original bug.
const FIGHT = process.env.FIGHT ?? '2';

const results = [];
const check = (ok, good, bad) => results.push({ ok, msg: ok ? good : bad });

function serveFixtures() {
  const dir = path.join(ROOT, 'test-pages');
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    try {
      const body = await fs.readFile(path.join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

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

async function run() {
  const { dir, extensionId } = await buildTestVariant(ROOT, 'e2e-scroll');
  const { server, port: fixturePort } = await serveFixtures();
  const browser = await launch(dir, { port: PORT, headless: true, window: '1280,900' });

  try {
    const version = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    const { targetId: pageTarget } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${fixturePort}/hostile-scroll.html?fight=${FIGHT}`,
    });
    const page = await cdp.attach(pageTarget);

    const { targetId: controlTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options/options.html`,
    });
    const control = await cdp.attach(controlTarget);
    await waitFor('extension page', async () =>
      String(await cdp.evaluate(control, 'location.href')).includes(extensionId)
    );
    await cdp.evaluate(
      control,
      `new Promise((res, rej) => { if (globalThis.FS && FS.store) return res(1);
         const s=document.createElement('script'); s.src=chrome.runtime.getURL('lib/store.js');
         s.onload=()=>res(1); s.onerror=rej; document.head.append(s); })`
    );

    await waitFor('fixture', async () =>
      (await cdp.evaluate(page, `document.readyState === 'complete' && !!window.__hostile`)) === true
    );

    const tabId = await waitFor('tab', () =>
      cdp.evaluate(
        control,
        `(async () => {
           await chrome.storage.local.set({ settings: {
             openEditor: false, primeLazyContent: true, freezeMotion: true,
             retina: false, floatingPolicy: 'once', settleMs: 120, imageWaitMs: 800,
           }});
           const tabs = await chrome.tabs.query({});
           const t = tabs.find((x) => (x.url || '').includes('hostile-scroll'));
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
        (t) => t.type === 'service_worker' && t.url.endsWith(`${extensionId}/background.js`)
      );
    });
    const sw = await cdp.attach(worker.targetId);

    const geo = await cdp.evaluate(
      page,
      `(() => ({ dpr: devicePixelRatio, pageH: document.documentElement.scrollHeight,
                 blockCount: window.__hostile.blockCount }))()`
    );

    // Park at the bottom, which is the reported starting condition.
    await cdp.evaluate(page, `window.scrollTo(0, ${geo.pageH}); true`);
    await sleep(500);
    const startedAt = await cdp.evaluate(page, `window.scrollY`);
    console.log(`page ${geo.pageH}px, started at scrollY=${startedAt}`);

    const cap = await cdp.evaluate(sw, `FS.startCapture('full', ${tabId})`);
    if (!cap?.ok) throw new Error(`capture failed: ${cap?.error}`);

    const yanks = await cdp.evaluate(page, `window.__hostile.yanks`);
    console.log(`page fought the scroll ${yanks} time(s)`);
    check(
      yanks > 0,
      `The fixture really did fight the scroll (${yanks} times), so this test means something`,
      'The fixture never fought the scroll, so this test proves nothing'
    );

    const shot = await cdp.evaluate(control, INSPECT(cap.id));
    const expected = Math.round(geo.pageH * geo.dpr);
    console.log(`capture: ${shot.width}x${shot.height}, expected height ${expected}`);
    check(
      Math.abs(shot.height - expected) <= 6,
      `Capture is the full page height (${shot.height}px)`,
      `Capture is ${shot.height}px, expected ${expected}px`
    );

    // The decisive check. If the scroll had not been forced back to the top,
    // the upper blocks would be blank white instead of their own colour.
    const bad = [];
    for (let i = 0; i < geo.blockCount; i++) {
      const y = (i * 200 + 100) * geo.dpr;
      if (y >= shot.height) { bad.push(`#${i} missing`); continue; }
      const [r, g, b] = await cdp.evaluate(control, SAMPLE(5, y));
      if (!(r === i * 10 && g === 100 && b === 200)) bad.push(`#${i} rgb(${r},${g},${b})`);
    }
    check(
      bad.length === 0,
      `All ${geo.blockCount} blocks captured from the top down, despite the page resisting`,
      `${bad.length} block(s) wrong: ${bad.slice(0, 6).join(', ')}`
    );

    if (shot.warnings?.length) console.log(`warnings: ${shot.warnings.join(' | ')}`);
  } finally {
    server.close();
    await shutdown(browser);
  }

  console.log('\n--- scroll regression ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
