/**
 * YouTube thumbnail for the promo video.
 *
 * 1280x720, which YouTube scales down to roughly 168px wide in sidebars and
 * search. Everything here is sized so it still reads at that width: four words
 * of headline, one hard colour contrast, and the before/after strips as the
 * proof rather than as decoration.
 *
 *   node tools/thumbnail.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CDP, launch, httpJson, shutdown, sleep } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'store', 'assets', 'raw');
const OUT = path.join(ROOT, 'store', 'assets');
const PORT = 9340;
const W = 1280;
const H = 720;

const ROSE = '#e11d48';
const DEEP = '#9f1239';
const INK = '#0f172a';
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

const html = (icon, before, after) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  body{font-family:${FONT};background:#fff;color:${INK}}
  .wrap{height:100%;display:grid;grid-template-columns:700px 1fr}
  .left{padding:56px 0 46px 58px;display:flex;flex-direction:column;justify-content:center;gap:0}
  .brand{display:flex;align-items:center;gap:14px;margin-bottom:26px}
  .brand span{font-size:31px;font-weight:800;letter-spacing:-.02em}
  h1{font-size:118px;line-height:.92;letter-spacing:-.045em;font-weight:900;text-transform:uppercase}
  h1 em{font-style:normal;color:${ROSE}}
  .sub{margin-top:24px;font-size:35px;font-weight:600;color:#475569}
  .badge{margin-top:30px;align-self:flex-start;padding:12px 24px;background:${INK};color:#fff;
         border-radius:12px;font-size:23px;font-weight:800;letter-spacing:.04em}
  .right{position:relative;background:linear-gradient(155deg,${DEEP},${ROSE});overflow:hidden;
         display:flex;flex-direction:column;justify-content:center;gap:16px;padding:34px 30px}
  .row{display:flex;align-items:center;gap:16px}
  .mark{flex:none;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;
        justify-content:center;font-size:34px;font-weight:900;color:#fff;
        box-shadow:0 6px 18px rgba(0,0,0,.3)}
  .bad{background:#64748b}
  .good{background:#16a34a}
  /*
    The page cards are drawn as blocks rather than shown as real screenshots.
    A real screenshot is unreadable once YouTube scales this to 168px wide,
    which is exactly where the comparison has to land. Chunky bars survive it:
    the eye reads "striped" against "one stripe" at any size.
  */
  .strip{flex:1;height:252px;overflow:hidden;border-radius:10px;background:#fff;
         border:4px solid rgba(255,255,255,.92);box-shadow:0 14px 34px rgba(0,0,0,.35);
         padding:14px;display:flex;flex-direction:column;gap:13px}
  .bar{height:26px;border-radius:5px;background:${ROSE}}
  .line{height:11px;border-radius:4px;background:#cbd5e1}
  .line.s{width:56%}
  .line.m{width:78%}
</style></head><body>
  <div class="wrap">
    <div class="left">
      <div class="brand"><img src="${icon}" width="62" height="62"><span>Fullshot</span></div>
      <h1>The whole<br><em>page</em>.</h1>
      <div class="sub">Not just the screen.</div>
      <div class="badge">FREE &middot; OPEN SOURCE</div>
    </div>
    <div class="right">
      <div class="row">
        <div class="mark bad">&#10005;</div>
        <div class="strip">
          <div class="bar"></div>
          <div class="line m"></div><div class="line s"></div>
          <div class="bar"></div>
          <div class="line m"></div><div class="line s"></div>
          <div class="bar"></div>
        </div>
      </div>
      <div class="row">
        <div class="mark good">&#10003;</div>
        <div class="strip">
          <div class="bar"></div>
          <div class="line m"></div><div class="line s"></div>
          <div class="line m"></div><div class="line s"></div>
          <div class="line m"></div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

const dataUri = async (f) => `data:image/png;base64,${(await fs.readFile(f)).toString('base64')}`;

async function main() {
  const browser = await launch(path.join(ROOT, 'dist', 'chrome'), {
    port: PORT, headless: true, window: '1400,900',
  });
  try {
    const version = await httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const s = await cdp.attach(targetId);
    await cdp.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, s);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: W, height: H, deviceScaleFactor: 1, mobile: false }, s);

    const doc = html(
      await dataUri(path.join(ROOT, 'src', 'icons', 'icon-128.png')),
      await dataUri(path.join(RAW, 'compare-before.png')),
      await dataUri(path.join(RAW, 'compare-after.png'))
    );
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, s);
    await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: doc }, s);
    await sleep(800);

    const png = path.join(OUT, 'youtube-thumbnail.png');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
    await fs.writeFile(png, Buffer.from(data, 'base64'));

    // YouTube accepts PNG, but a JPEG at q92 is a fraction of the size and
    // stays well under the 2MB ceiling.
    const jpg = path.join(OUT, 'youtube-thumbnail.jpg');
    await run('magick', [png, '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
      '-strip', '-quality', '92', jpg]);

    for (const f of [png, jpg]) {
      const { size } = await fs.stat(f);
      console.log(`${path.basename(f)}  ${(size / 1024).toFixed(0)} KB`);
    }
  } finally {
    await shutdown(browser);
  }
}

main().catch((err) => {
  console.error('thumbnail build failed:', err.message);
  process.exit(1);
});
