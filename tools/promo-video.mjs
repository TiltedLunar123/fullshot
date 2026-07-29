/**
 * Build the YouTube promo video from the real product shots.
 *
 * Renders 1920x1080 slides in a browser, then assembles them with ffmpeg:
 * a slow push on each still, a genuine vertical scroll through a real
 * full-page capture, and crossfades between sections.
 *
 * Requires tools/store-assets.mjs to have run first, since it reuses the
 * product shots in store/assets/raw.
 *
 *   node tools/promo-video.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CDP, launch, httpJson, shutdown, sleep } from './cdp.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'store', 'assets', 'raw');
const OUT = path.join(ROOT, 'store', 'assets');
const PORT = 9339;
const W = 1920;
const H = 1080;
const FPS = 30;

const BRAND = { rose: '#e11d48', roseDeep: '#9f1239', ink: '#0f172a', slate: '#475569', mist: '#f8fafc', line: '#e2e8f0' };
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;

const ff = (args) =>
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 26 });

const shell = (body, bg = '#ffffff') => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  body{font-family:${FONT};color:${BRAND.ink};background:${bg}}
  .kicker{color:${BRAND.rose};font-weight:800;font-size:24px;letter-spacing:.12em;text-transform:uppercase}
  h1{font-size:96px;line-height:1.03;letter-spacing:-.035em;font-weight:800}
  h2{font-size:66px;line-height:1.08;letter-spacing:-.03em;font-weight:800}
  p.lede{font-size:32px;line-height:1.45;color:${BRAND.slate}}
  ul{list-style:none;display:flex;flex-direction:column;gap:20px}
  li{font-size:30px;color:${BRAND.slate};display:flex;gap:16px;align-items:flex-start}
  li b{color:${BRAND.ink};font-weight:700}
  .tick{flex:none;width:34px;height:34px;margin-top:3px;border-radius:50%;background:${BRAND.rose};
        color:#fff;font-size:19px;font-weight:800;display:flex;align-items:center;justify-content:center}
  .shot{border-radius:14px;box-shadow:0 40px 90px rgba(15,23,42,.26);border:1px solid ${BRAND.line}}
</style></head><body>${body}</body></html>`;

const titleSlide = (icon) =>
  shell(
    `<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;
                 background:linear-gradient(160deg,#fff1f2 0%,#ffffff 55%);">
       <img src="${icon}" width="150" height="150" style="filter:drop-shadow(0 22px 44px rgba(225,29,72,.32))">
       <div style="font-size:104px;font-weight:800;letter-spacing:-.035em;">Fullshot</div>
       <p class="lede" style="font-size:38px;text-align:center;max-width:1100px;">
         Full page screenshots that get the hard pages right.
       </p>
       <div style="display:flex;gap:14px;margin-top:12px;">
         ${['No account', 'No tracking', 'Free editor', 'Open source']
           .map(
             (c) =>
               `<span style="padding:13px 26px;border:2px solid ${BRAND.line};border-radius:999px;
                      font-size:24px;font-weight:600;color:${BRAND.slate};background:#fff;">${c}</span>`
           )
           .join('')}
       </div>
     </div>`
  );

/** Left copy, empty right panel where the scrolling capture video is overlaid. */
const scrollStage = () =>
  shell(
    `<div style="height:100%;display:grid;grid-template-columns:840px 1fr;">
       <div style="padding:0 0 0 104px;display:flex;flex-direction:column;justify-content:center;gap:30px;">
         <div class="kicker">One click</div>
         <h1>The whole page,<br>not just<br>the screen.</h1>
         <p class="lede" style="max-width:660px;">
           Everything below the fold, stitched into a single image.
         </p>
       </div>
       <div style="background:${BRAND.mist};border-left:1px solid ${BRAND.line};"></div>
     </div>`
  );

const compareSlide = (before, after) =>
  shell(
    `<div style="height:100%;padding:76px 96px;display:flex;flex-direction:column;">
       <div class="kicker" style="margin-bottom:14px;">The difference</div>
       <h2 style="margin-bottom:12px;">Sticky menus appear once.</h2>
       <p class="lede" style="margin-bottom:40px;">The same page, with the sticky handling off and on.</p>
       <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:56px;min-height:0;">
         ${[
           { l: 'Handling off', img: before, bad: true },
           { l: 'Fullshot default', img: after, bad: false },
         ]
           .map(
             (c) => `<div style="display:flex;flex-direction:column;min-height:0;">
             <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
               <span style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;
                 font-size:20px;font-weight:800;color:#fff;background:${c.bad ? '#94a3b8' : BRAND.rose}">${c.bad ? '&#10005;' : '&#10003;'}</span>
               <span style="font-size:30px;font-weight:700;">${c.l}</span>
             </div>
             <div style="flex:1;overflow:hidden;border-radius:14px;border:1px solid ${BRAND.line};
                         box-shadow:0 28px 64px rgba(15,23,42,.2);background:#fff;">
               <img src="${c.img}" style="width:100%;display:block;">
             </div>
           </div>`
           )
           .join('')}
       </div>
     </div>`
  );

const splitSlide = (o) =>
  shell(
    `<div style="height:100%;display:grid;grid-template-columns:790px 1fr;">
       <div style="padding:0 0 0 104px;display:flex;flex-direction:column;justify-content:center;gap:30px;">
         <div class="kicker">${o.kicker}</div>
         <h2>${o.title}</h2>
         <ul>${o.bullets.map((b) => `<li><span class="tick">&#10003;</span><span>${b}</span></li>`).join('')}</ul>
       </div>
       <div style="position:relative;overflow:hidden;background:${BRAND.mist};border-left:1px solid ${BRAND.line};">
         <img class="shot" src="${o.image}" style="position:absolute;top:${o.top}px;left:${o.left}px;width:${o.width}px;">
       </div>
     </div>`
  );

const endSlide = (icon) =>
  shell(
    `<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;
                 background:linear-gradient(160deg,${BRAND.roseDeep},${BRAND.rose});color:#fff;">
       <img src="${icon}" width="130" height="130" style="filter:drop-shadow(0 20px 40px rgba(0,0,0,.3))">
       <div style="font-size:88px;font-weight:800;letter-spacing:-.035em;">Fullshot</div>
       <p style="font-size:36px;opacity:.95;text-align:center;max-width:1150px;line-height:1.4;">
         Free, open source, and it makes no network requests at all.
       </p>
       <div style="margin-top:16px;padding:16px 34px;background:rgba(255,255,255,.16);
                   border:2px solid rgba(255,255,255,.32);border-radius:16px;font-size:28px;font-weight:600;">
         github.com/TiltedLunar123/fullshot
       </div>
     </div>`
  );

const dataUri = async (f) => `data:image/png;base64,${(await fs.readFile(f)).toString('base64')}`;

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fullshot-video-'));
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

    const render = async (html, name) => {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width: W, height: H, deviceScaleFactor: 1, mobile: false }, s);
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, s);
      await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, s);
      await sleep(650);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
      const file = path.join(tmp, `${name}.png`);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
      console.log(`rendered ${name}`);
      return file;
    };

    const icon = await dataUri(path.join(ROOT, 'src', 'icons', 'icon-256.png'));
    const beforeU = await dataUri(path.join(RAW, 'compare-before.png'));
    const afterU = await dataUri(path.join(RAW, 'compare-after.png'));
    const popupU = await dataUri(path.join(RAW, 'popup.png'));
    const editorU = await dataUri(path.join(RAW, 'editor.png'));
    const optionsU = await dataUri(path.join(RAW, 'options.png'));

    const slides = {
      title: await render(titleSlide(icon), 'title'),
      stage: await render(scrollStage(), 'stage'),
      compare: await render(compareSlide(beforeU, afterU), 'compare'),
      modes: await render(
        splitSlide({
          kicker: 'Four ways to capture',
          title: 'Or exactly the part you meant.',
          image: popupU,
          width: 560, top: 250, left: 280,
          bullets: ['<b>Full page</b>, top to bottom', '<b>Visible area</b> only',
            '<b>Pick an element</b> by clicking', '<b>Scrolling panels</b> in chats and mail'],
        }), 'modes'
      ),
      editor: await render(
        splitSlide({
          kicker: 'Editor included',
          title: 'Crop, redact, annotate.',
          image: editorU,
          width: 1060, top: 220, left: 30,
          bullets: ['Blur or black out anything private', 'Arrows, boxes and text with undo',
            'PNG, JPEG, WebP or multi page PDF', 'Copy with Ctrl+C'],
        }), 'editor'
      ),
      privacy: await render(
        splitSlide({
          kicker: 'Privacy',
          title: 'It cannot phone home.',
          image: optionsU,
          width: 1060, top: 210, left: 30,
          bullets: ['No analytics or error reporting', 'No access to your websites',
            'Screenshots stay on your machine', 'Open source, so you can check'],
        }), 'privacy'
      ),
      end: await render(endSlide(icon), 'end'),
    };

    /* ---- clips ---------------------------------------------------- */

    /** A still with a slow centred push, so nothing sits dead on screen. */
    const still = async (src, out, seconds, from = 1.0, to = 1.05) => {
      const frames = Math.round(seconds * FPS);
      const step = (to - from) / frames;
      await ff(['-loop', '1', '-i', src, '-t', String(seconds), '-r', String(FPS),
        '-vf', `scale=${W * 2}:-2,zoompan=z='min(${from}+on*${step},${to})':` +
          `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},setsar=1`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
      return out;
    };

    // The real capture, scrolling. This is the shot that shows what the
    // extension actually produces, so it gets the most screen time.
    const pageShot = path.join(RAW, 'page-once.png');
    const panelW = 1080;
    const panelH = H;
    const scrollSeconds = 8;
    const scrollClip = path.join(tmp, 'scroll.mp4');
    await ff(['-loop', '1', '-i', pageShot, '-t', String(scrollSeconds), '-r', String(FPS),
      '-vf', `scale=${panelW}:-2,crop=${panelW}:${panelH}:0:'min((ih-${panelH})*t/${scrollSeconds},ih-${panelH})',setsar=1`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', scrollClip]);

    const scrollComposite = path.join(tmp, 'scroll-composite.mp4');
    await ff(['-loop', '1', '-i', slides.stage, '-i', scrollClip,
      '-filter_complex', `[0:v][1:v]overlay=840:0:shortest=1,setsar=1`,
      '-t', String(scrollSeconds), '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', scrollComposite]);
    console.log('built scrolling capture clip');

    const clips = [
      await still(slides.title, path.join(tmp, 'c1.mp4'), 4.5),
      scrollComposite,
      await still(slides.compare, path.join(tmp, 'c3.mp4'), 6),
      await still(slides.modes, path.join(tmp, 'c4.mp4'), 5.5),
      await still(slides.editor, path.join(tmp, 'c5.mp4'), 5.5),
      await still(slides.privacy, path.join(tmp, 'c6.mp4'), 5),
      await still(slides.end, path.join(tmp, 'c7.mp4'), 5),
    ];
    console.log('built all clips');

    /* ---- crossfade into one timeline ------------------------------ */
    const durations = [4.5, scrollSeconds, 6, 5.5, 5.5, 5, 5];
    const FADE = 0.6;

    const inputs = clips.flatMap((c) => ['-i', c]);
    let filter = '';
    let last = '0:v';
    let offset = durations[0] - FADE;
    for (let i = 1; i < clips.length; i++) {
      const label = i === clips.length - 1 ? 'vout' : `v${i}`;
      filter += `[${last}][${i}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[${label}];`;
      last = label;
      offset += durations[i] - FADE;
    }
    filter = filter.replace(/;$/, '');

    const silent = path.join(tmp, 'silent.mp4');
    await ff([...inputs, '-filter_complex', filter, '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-r', String(FPS), silent]);

    // A silent AAC track: some players and uploaders behave oddly without one.
    const final = path.join(OUT, 'fullshot-promo-1080p.mp4');
    await ff(['-i', silent, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart', final]);

    const { size } = await fs.stat(final);
    const probe = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration,codec_name', '-of', 'csv=p=0', final]);
    console.log(`\nvideo: ${path.relative(ROOT, final)}`);
    console.log(`  ${probe.stdout.trim()}, ${(size / 1024 / 1024).toFixed(1)} MB`);
  } finally {
    await shutdown(browser);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('video build failed:', err.message);
  process.exit(1);
});
