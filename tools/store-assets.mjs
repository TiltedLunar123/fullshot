/**
 * Generate Chrome Web Store artwork from the real product.
 *
 * Every product shot here is a genuine screenshot of the extension running,
 * not a mockup. The sticky-header comparison is produced by capturing the same
 * page twice with the floating-element policy off and on, so the "before" is
 * a real failure rather than an illustration of one.
 *
 * Outputs to store/assets:
 *   icon-128.png              store icon
 *   screenshot-1..5.png       1280x800, 24 bit, no alpha
 *   small-tile-440x280.png
 *   marquee-1400x560.png
 *   raw/*.png                 the underlying product shots, for the video
 *
 *   node tools/store-assets.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CDP, buildTestVariant, httpJson, launch, shutdown, waitFor, sleep } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store', 'assets');
const RAW = path.join(OUT, 'raw');
const PORT = 9338;

const BRAND = {
  rose: '#e11d48',
  roseDeep: '#9f1239',
  ink: '#0f172a',
  slate: '#475569',
  mist: '#f8fafc',
  line: '#e2e8f0',
};

function serveFixtures() {
  const dir = path.join(ROOT, 'test-pages');
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname) || 'demo.html';
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

/* ------------------------------------------------------------------ */
/* Marketing templates                                                 */
/* ------------------------------------------------------------------ */

const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

const shell = (width, height, body) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${width}px; height:${height}px; overflow:hidden; }
  body { font-family:${FONT}; color:${BRAND.ink}; background:#fff; }
  .shot { border-radius:10px; box-shadow:0 24px 60px rgba(15,23,42,.22); border:1px solid ${BRAND.line}; }
  .kicker { color:${BRAND.rose}; font-weight:800; font-size:15px; letter-spacing:.1em; text-transform:uppercase; }
  h1 { font-size:46px; line-height:1.08; letter-spacing:-.03em; font-weight:800; }
  h2 { font-size:38px; line-height:1.12; letter-spacing:-.03em; font-weight:800; }
  p.lede { font-size:20px; line-height:1.5; color:${BRAND.slate}; }
  ul { list-style:none; display:flex; flex-direction:column; gap:12px; }
  li { font-size:19px; color:${BRAND.slate}; display:flex; gap:11px; align-items:flex-start; }
  li b { color:${BRAND.ink}; font-weight:700; }
  .tick { flex:none; width:22px; height:22px; margin-top:2px; border-radius:50%;
          background:${BRAND.rose}; color:#fff; font-size:13px; font-weight:800;
          display:flex; align-items:center; justify-content:center; }
</style></head><body>${body}</body></html>`;

/** Split layout: copy on the left, product shot bleeding off the right. */
const splitSlide = (o) =>
  shell(
    1280,
    800,
    `<div style="display:grid;grid-template-columns:496px 1fr;height:100%;">
       <div style="padding:76px 0 76px 68px;display:flex;flex-direction:column;justify-content:center;gap:22px;">
         <div class="kicker">${o.kicker}</div>
         <h2>${o.title}</h2>
         ${o.lede ? `<p class="lede">${o.lede}</p>` : ''}
         ${o.bullets ? `<ul>${o.bullets.map((b) => `<li><span class="tick">&#10003;</span><span>${b}</span></li>`).join('')}</ul>` : ''}
       </div>
       <div style="position:relative;overflow:hidden;background:${BRAND.mist};border-left:1px solid ${BRAND.line};">
         <img class="shot" src="${o.image}"
              style="position:absolute;top:${o.top ?? 64}px;left:${o.left ?? 40}px;width:${o.width}px;${o.height ? `height:${o.height}px;object-fit:cover;object-position:top;` : ''}">
       </div>
     </div>`
  );

/** Centred hero with a tall page shot underneath. */
const heroSlide = (o) =>
  shell(
    1280,
    800,
    `<div style="height:100%;display:grid;grid-template-columns:560px 1fr;">
       <div style="padding:0 0 0 72px;display:flex;flex-direction:column;justify-content:center;gap:24px;">
         <div style="display:flex;align-items:center;gap:14px;">
           <img src="${o.icon}" width="60" height="60">
           <span style="font-size:30px;font-weight:800;letter-spacing:-.02em;">Fullshot</span>
         </div>
         <h1>${o.title}</h1>
         <p class="lede">${o.lede}</p>
         <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
           ${o.chips
             .map(
               (c) =>
                 `<span style="padding:8px 15px;border:1px solid ${BRAND.line};border-radius:999px;font-size:15px;font-weight:600;color:${BRAND.slate};background:${BRAND.mist};">${c}</span>`
             )
             .join('')}
         </div>
       </div>
       <div style="position:relative;overflow:hidden;background:linear-gradient(160deg,#fff1f2,#f8fafc);">
         <img class="shot" src="${o.image}" style="position:absolute;top:56px;left:52px;width:660px;">
       </div>
     </div>`
  );

/** Side by side before and after. */
const compareSlide = (o) =>
  shell(
    1280,
    800,
    `<div style="height:100%;padding:56px 60px 60px;display:flex;flex-direction:column;">
       <div class="kicker" style="margin-bottom:10px;">${o.kicker}</div>
       <h2 style="margin-bottom:8px;">${o.title}</h2>
       <p class="lede" style="margin-bottom:30px;">${o.lede}</p>
       <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:34px;min-height:0;">
         ${[
           { label: o.leftLabel, img: o.left, bad: true },
           { label: o.rightLabel, img: o.right, bad: false },
         ]
           .map(
             (c) => `
           <div style="display:flex;flex-direction:column;min-height:0;">
             <div style="display:flex;align-items:center;gap:9px;margin-bottom:12px;">
               <span style="width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                            font-size:14px;font-weight:800;color:#fff;background:${c.bad ? '#94a3b8' : BRAND.rose};">${c.bad ? '&#10005;' : '&#10003;'}</span>
               <span style="font-size:18px;font-weight:700;">${c.label}</span>
             </div>
             <div style="flex:1;overflow:hidden;border-radius:10px;border:1px solid ${BRAND.line};
                         box-shadow:0 16px 40px rgba(15,23,42,.16);background:#fff;">
               <img src="${c.img}" style="width:100%;display:block;">
             </div>
           </div>`
           )
           .join('')}
       </div>
     </div>`
  );

const smallTile = (icon) =>
  shell(
    440,
    280,
    `<div style="height:100%;background:linear-gradient(150deg,${BRAND.roseDeep},${BRAND.rose});
                color:#fff;padding:30px 32px;display:flex;flex-direction:column;justify-content:space-between;">
       <img src="${icon}" width="58" height="58" style="filter:drop-shadow(0 6px 14px rgba(0,0,0,.28));">
       <div>
         <div style="font-size:31px;font-weight:800;letter-spacing:-.02em;line-height:1.1;">Fullshot</div>
         <div style="font-size:15.5px;opacity:.92;margin-top:7px;line-height:1.35;">
           Full page screenshots that<br>get the hard pages right.
         </div>
       </div>
     </div>`
  );

const marquee = (icon, image) =>
  shell(
    1400,
    560,
    `<div style="height:100%;display:grid;grid-template-columns:1fr 620px;background:#fff;">
       <div style="padding:0 0 0 74px;display:flex;flex-direction:column;justify-content:center;gap:20px;">
         <div style="display:flex;align-items:center;gap:14px;">
           <img src="${icon}" width="56" height="56">
           <span style="font-size:29px;font-weight:800;letter-spacing:-.02em;">Fullshot</span>
         </div>
         <div style="font-size:48px;font-weight:800;letter-spacing:-.03em;line-height:1.08;">
           The whole page,<br>not just the screen.
         </div>
         <p class="lede" style="max-width:560px;">
           Sticky menus once. Lazy images loaded. Scrolling panels too.
           Free editor and PDF export, no account.
         </p>
       </div>
       <div style="position:relative;overflow:hidden;background:linear-gradient(160deg,#fff1f2,#f8fafc);">
         <img class="shot" src="${image}" style="position:absolute;top:44px;left:44px;width:530px;">
       </div>
     </div>`
  );

/* ------------------------------------------------------------------ */

async function render(cdp, session, html, width, height, outFile) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    session
  );
  const { frameTree } = await cdp.send('Page.getFrameTree', {}, session);
  await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, session);
  await sleep(700);
  const { data } = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    session
  );
  await fs.writeFile(outFile, Buffer.from(data, 'base64'));
  return outFile;
}

/** Store artwork must be 24 bit with no alpha channel. */
async function flatten(file) {
  await run('magick', [file, '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
    '-strip', '-define', 'png:color-type=2', file]);
}

const dataUri = async (file) =>
  `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;

async function main() {
  await fs.mkdir(RAW, { recursive: true });
  const { dir, extensionId } = await buildTestVariant(ROOT, 'e2e-assets');
  const { server, port: fixturePort } = await serveFixtures();
  const browser = await launch(dir, { port: PORT, headless: true, window: '1400,1000' });

  try {
    const version = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    // Demo page
    const { targetId: pageTarget } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${fixturePort}/demo.html`,
    });
    const page = await cdp.attach(pageTarget);

    // Extension control page
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

    const tabId = await waitFor('demo tab', () =>
      cdp.evaluate(
        control,
        `(async () => {
           const tabs = await chrome.tabs.query({});
           const t = tabs.find((x) => (x.url || '').includes('demo.html'));
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
    console.log('extension ready');

    /* ---- real captures, policy off then on --------------------- */
    const captureWith = async (policy) => {
      await cdp.evaluate(
        control,
        `chrome.storage.local.set({ settings: { openEditor:false, primeLazyContent:true,
           freezeMotion:true, retina:false, floatingPolicy:'${policy}', settleMs:150, imageWaitMs:1200 }})`
      );
      await sleep(300);
      const r = await cdp.evaluate(sw, `FS.startCapture('full', ${tabId})`);
      if (!r?.ok) throw new Error(`capture (${policy}) failed: ${r?.error}`);
      const file = path.join(RAW, `page-${policy}.png`);
      const b64 = await cdp.evaluate(
        control,
        `(async () => {
           const rec = await FS.store.get(${JSON.stringify(r.id)});
           const bmp = await createImageBitmap(rec.blob);
           const c = new OffscreenCanvas(bmp.width, bmp.height);
           c.getContext('2d').drawImage(bmp, 0, 0);
           const blob = await c.convertToBlob({ type: 'image/png' });
           return await new Promise((res) => { const fr = new FileReader();
             fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
         })()`
      );
      await fs.writeFile(file, Buffer.from(b64, 'base64'));
      console.log(`captured ${policy} -> ${path.basename(file)}`);
      return { file, id: r.id };
    };

    const before = await captureWith('keep');
    const after = await captureWith('once');

    // Show the WHOLE page in the comparison. Cropping to the top would hide
    // the repeats, which only occur at each viewport boundary further down.
    for (const [src, name] of [[before.file, 'compare-before.png'], [after.file, 'compare-after.png']]) {
      await run('magick', [src, '-resize', '520x', path.join(RAW, name)]);
    }

    /* ---- product UI shots -------------------------------------- */
    const { targetId: shotTarget } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const shot = await cdp.attach(shotTarget);

    const grab = async (url, w, h, out, settle = 1400) => {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: w, height: h, deviceScaleFactor: 1, mobile: false }, shot);
      // Headless reports a dark colour scheme by default, which would clash
      // with the light marketing slides these shots sit inside.
      await cdp.send('Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, shot);
      await cdp.send('Page.navigate', { url }, shot);
      await sleep(settle);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, shot);
      await fs.writeFile(out, Buffer.from(data, 'base64'));
      console.log(`shot ${path.basename(out)}`);
      return out;
    };

    const editorShot = await grab(
      `chrome-extension://${extensionId}/editor/editor.html?id=${after.id}`,
      1280, 800, path.join(RAW, 'editor.png'), 2600
    );
    const popupShot = await grab(
      `chrome-extension://${extensionId}/popup/popup.html`,
      336, 372, path.join(RAW, 'popup.png')
    );
    const optionsShot = await grab(
      `chrome-extension://${extensionId}/options/options.html`,
      1280, 900, path.join(RAW, 'options.png')
    );

    /* ---- compose ------------------------------------------------ */
    const iconUri = await dataUri(path.join(ROOT, 'src', 'icons', 'icon-128.png'));
    const pageUri = await dataUri(path.join(RAW, 'compare-after.png'));
    const editorUri = await dataUri(editorShot);
    const popupUri = await dataUri(popupShot);
    const optionsUri = await dataUri(optionsShot);
    const beforeUri = await dataUri(path.join(RAW, 'compare-before.png'));
    const afterUri = await dataUri(path.join(RAW, 'compare-after.png'));

    const slides = [
      heroSlide({
        icon: iconUri,
        image: pageUri,
        title: 'The whole page, not just the screen.',
        lede: 'One click captures everything below the fold, stitched into a single image.',
        chips: ['No account', 'No tracking', 'Free editor', 'PDF export'],
      }),
      compareSlide({
        kicker: 'The difference',
        title: 'Sticky menus appear once.',
        lede: 'The same page captured twice, with the sticky handling turned off and on.',
        leftLabel: 'Handling off: menu repeats',
        rightLabel: 'Fullshot default: once',
        left: beforeUri,
        right: afterUri,
      }),
      splitSlide({
        kicker: 'Four ways to capture',
        title: 'Whole page, or exactly the part you meant.',
        image: popupUri,
        width: 420,
        top: 190,
        left: 180,
        bullets: [
          '<b>Full page</b> from top to bottom',
          '<b>Visible area</b> for what is on screen',
          '<b>Pick an element</b> by clicking it',
          '<b>Scrolling panel</b> for chats and mailboxes',
        ],
      }),
      splitSlide({
        kicker: 'Editor included',
        title: 'Crop, redact and annotate. Nothing locked.',
        image: editorUri,
        width: 742,
        top: 168,
        left: 22,
        bullets: [
          'Blur or black out anything private',
          'Arrows, boxes and text with undo',
          'Save PNG, JPEG, WebP or multi page PDF',
          'Copy to the clipboard with Ctrl+C',
        ],
      }),
      splitSlide({
        kicker: 'Privacy',
        title: 'It cannot phone home. There is no code to do it.',
        image: optionsUri,
        width: 742,
        top: 150,
        left: 22,
        bullets: [
          'No analytics, no error reporting, no version check',
          'Three permissions, and no access to your websites',
          'Screenshots stay on your machine',
          'Open source, so you can check all of that',
        ],
      }),
    ];

    for (let i = 0; i < slides.length; i++) {
      const out = path.join(OUT, `screenshot-${i + 1}.png`);
      await render(cdp, shot, slides[i], 1280, 800, out);
      await flatten(out);
      console.log(`built ${path.basename(out)}`);
    }

    const tile = path.join(OUT, 'small-tile-440x280.png');
    await render(cdp, shot, smallTile(iconUri), 440, 280, tile);
    await flatten(tile);

    const marqueeOut = path.join(OUT, 'marquee-1400x560.png');
    await render(cdp, shot, marquee(iconUri, pageUri), 1400, 560, marqueeOut);
    await flatten(marqueeOut);

    await fs.copyFile(path.join(ROOT, 'src', 'icons', 'icon-128.png'), path.join(OUT, 'icon-128.png'));
    console.log('built tiles and icon');
  } finally {
    server.close();
    await shutdown(browser);
  }

  console.log(`\nassets in ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error('asset build failed:', err.message);
  process.exit(1);
});
