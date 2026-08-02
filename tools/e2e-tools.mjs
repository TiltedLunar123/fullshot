/**
 * End-to-end verification of every editor tool.
 *
 * Drives Move, Crop, Box, Arrow, Text, Redact and Blur with real synthesised
 * mouse and keyboard input, then asserts on the actual canvas pixels. Nothing
 * here inspects the editor's internal state, so it verifies observable
 * behaviour rather than implementation details.
 *
 * It works on a small synthetic capture rather than a real page screenshot, so
 * coordinates are exact and a failure points at one tool.
 *
 *   node tools/e2e-tools.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, buildTestVariant, launch, shutdown, waitFor, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9336;

const IMAGE_W = 400;
const IMAGE_H = 300;
// A dense checkerboard, so pixelation has something to visibly destroy.
const CHECKER = { x: 240, y: 30, w: 140, h: 120 };

const results = [];
const pass = (msg) => results.push({ ok: true, msg });
const fail = (msg) => results.push({ ok: false, msg });
const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

/** Builds the synthetic capture and stores it where the editor will find it. */
const SEED = `(async () => {
  await new Promise((resolve, reject) => {
    if (globalThis.FS && FS.store) return resolve();
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('lib/store.js');
    s.onload = resolve;
    s.onerror = () => reject(new Error('store.js failed to load'));
    document.head.append(s);
  });

  const canvas = document.createElement('canvas');
  canvas.width = ${IMAGE_W};
  canvas.height = ${IMAGE_H};
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ${IMAGE_W}, ${IMAGE_H});

  const ch = ${JSON.stringify(CHECKER)};
  for (let y = 0; y < ch.h; y += 4) {
    for (let x = 0; x < ch.w; x += 4) {
      ctx.fillStyle = ((x / 4) + (y / 4)) % 2 ? '#101010' : '#f0f0f0';
      ctx.fillRect(ch.x + x, ch.y + y, 4, 4);
    }
  }

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const id = 'tool-test-fixture';
  await FS.store.put({
    id, createdAt: Date.now(), blob,
    width: ${IMAGE_W}, height: ${IMAGE_H},
    title: 'Tool test', url: 'https://example.test/', warnings: [], sliceCount: 1, scale: 1,
  });
  return id;
})()`;

async function run() {
  console.log('building throwaway test variant...');
  const { dir, extensionId } = await buildTestVariant(ROOT, 'e2e-tools');

  console.log('launching browser...');
  const session = await launch(dir, { port: PORT, headless: true });

  try {
    const version = await (await import('./cdp.mjs')).httpJson(PORT, '/json/version');
    const cdp = await CDP.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    // Seed the capture from an extension page so it shares the extension origin.
    const { targetId: seedTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/options/options.html`,
    });
    const seedSession = await cdp.attach(seedTarget);
    await waitFor('extension page', async () => {
      const href = await cdp.evaluate(seedSession, 'location.href');
      return typeof href === 'string' && href.includes(extensionId);
    });
    const id = await cdp.evaluate(seedSession, SEED);
    pass(`seeded a ${IMAGE_W}x${IMAGE_H} test capture`);

    // Open the editor on it.
    const { targetId: editorTarget } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/editor/editor.html?id=${id}`,
    });
    const ed = await cdp.attach(editorTarget);

    const ready = await waitFor('editor to load', async () =>
      cdp.evaluate(
        ed,
        `(() => {
           const w = document.getElementById('wrap');
           const c = document.getElementById('canvas');
           if (!w || w.hidden || !c.width) return null;
           const r = c.getBoundingClientRect();
           return { width: c.width, height: c.height, displayWidth: Math.round(r.width) };
         })()`
      )
    );
    check(
      ready.width === IMAGE_W && ready.height === IMAGE_H,
      `editor opened the capture at ${ready.width}x${ready.height}`,
      `editor opened at ${ready.width}x${ready.height}, expected ${IMAGE_W}x${IMAGE_H}`
    );
    if (ready.displayWidth !== IMAGE_W) {
      console.log(`  note: canvas displayed at ${ready.displayWidth}px wide, coords are scaled`);
    }

    /* ---- page helpers ------------------------------------------- */

    // Image coordinates to viewport coordinates. Written as a page expression
    // so it stays correct if the canvas is scaled or the page is scrolled.
    const pt = (ix, iy) =>
      cdp.evaluate(
        ed,
        `(() => {
           const c = document.getElementById('canvas');
           const r = c.getBoundingClientRect();
           return { x: r.left + (${ix} / c.width) * r.width,
                    y: r.top  + (${iy} / c.height) * r.height };
         })()`
      );

    const useTool = async (name, { color, stroke } = {}) => {
      await cdp.evaluate(
        ed,
        `(() => {
           document.querySelector('[data-tool="${name}"]').click();
           ${color ? `document.getElementById('color').value = '${color}';` : ''}
           ${stroke ? `document.getElementById('stroke').value = ${stroke};` : ''}
           return true;
         })()`
      );
      await sleep(60);
    };

    const dragImage = async (from, to) => {
      await cdp.drag(ed, await pt(from[0], from[1]), await pt(to[0], to[1]));
      await sleep(180);
    };

    const px = (x, y) =>
      cdp.evaluate(
        ed,
        `(() => {
           const c = document.getElementById('canvas');
           const d = c.getContext('2d', { willReadFrequently: true }).getImageData(${x}, ${y}, 1, 1).data;
           return [d[0], d[1], d[2], d[3]];
         })()`
      );

    /** Summary statistics for a region, used for blur and no-op checks. */
    const region = (x, y, w, h) =>
      cdp.evaluate(
        ed,
        `(() => {
           const c = document.getElementById('canvas');
           const d = c.getContext('2d', { willReadFrequently: true }).getImageData(${x}, ${y}, ${w}, ${h}).data;
           let energy = 0, sum = 0, allBlack = true, nonWhite = 0;
           for (let row = 0; row < ${h}; row++) {
             for (let col = 0; col < ${w}; col++) {
               const i = (row * ${w} + col) * 4;
               sum += d[i] + d[i + 1] + d[i + 2];
               if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0 || d[i + 3] !== 255) allBlack = false;
               if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nonWhite++;
               if (col < ${w} - 1) energy += Math.abs(d[i] - d[i + 4]);
             }
           }
           return { energy, sum, allBlack, nonWhite };
         })()`
      );

    const canvasSize = () =>
      cdp.evaluate(
        ed,
        `(() => { const c = document.getElementById('canvas'); return { w: c.width, h: c.height }; })()`
      );

    /* ---- Blur: measure the checkerboard before anything covers it -- */

    const before = await region(CHECKER.x + 6, CHECKER.y + 6, 120, 100);

    await useTool('pixelate');
    await dragImage([CHECKER.x + 2, CHECKER.y + 2], [CHECKER.x + CHECKER.w - 2, CHECKER.y + CHECKER.h - 2]);
    const after = await region(CHECKER.x + 6, CHECKER.y + 6, 120, 100);

    check(
      after.energy < before.energy * 0.6,
      `Blur destroyed fine detail (edge energy ${before.energy} to ${after.energy})`,
      `Blur did not obscure detail (edge energy ${before.energy} to ${after.energy})`
    );
    check(
      after.energy > 0,
      'Blur left the region pixelated rather than blanking it',
      'Blur blanked the region entirely instead of pixelating'
    );

    /* ---- Move: must change nothing -------------------------------- */

    await useTool('move');
    const moveBefore = await region(20, 200, 200, 80);
    await dragImage([30, 210], [200, 270]);
    const moveAfter = await region(20, 200, 200, 80);
    check(
      moveBefore.sum === moveAfter.sum && moveBefore.energy === moveAfter.energy,
      'Move left the image untouched',
      'Move altered the image when it should be inert'
    );

    /* ---- Box: stroked outline, hollow centre ---------------------- */

    await useTool('box', { color: '#00c000', stroke: 6 });
    await dragImage([40, 40], [140, 110]);

    const boxEdge = await px(90, 40);
    const boxMid = await px(90, 75);
    check(
      boxEdge[1] > 140 && boxEdge[0] < 120,
      `Box drew its outline (edge pixel rgb ${boxEdge.slice(0, 3)})`,
      `Box outline missing at its top edge (got rgb ${boxEdge.slice(0, 3)})`
    );
    check(
      boxMid[0] > 240 && boxMid[1] > 240 && boxMid[2] > 240,
      'Box left its interior transparent, as an outline should',
      `Box filled its interior (centre rgb ${boxMid.slice(0, 3)})`
    );

    /* ---- Arrow ---------------------------------------------------- */

    await useTool('arrow', { color: '#0000ff', stroke: 6 });
    await dragImage([200, 200], [320, 260]);

    const arrowShaft = await region(250, 220, 24, 20);
    check(
      arrowShaft.nonWhite > 0,
      'Arrow drew its shaft',
      'Arrow shaft is missing along the drag path'
    );

    // The head is a FILLED triangle, so a small box at its centroid should be
    // almost solid. Comparing raw pixel counts against the shaft would not
    // prove that: a long thin line easily covers more pixels than a small
    // triangle without the triangle existing at all.
    const headCore = await region(307, 252, 6, 6);
    check(
      headCore.nonWhite >= 30,
      `Arrow head is a solid filled triangle (${headCore.nonWhite}/36 pixels at its centroid)`,
      `Arrow head is not filled (${headCore.nonWhite}/36 pixels at its centroid)`
    );

    // Control: somewhere the arrow must not have reached.
    const untouched = await region(350, 185, 12, 12);
    check(
      untouched.nonWhite === 0,
      'Arrow drew only where it was dragged',
      `Arrow painted outside its drag (${untouched.nonWhite} stray pixels)`
    );

    /* ---- Text ----------------------------------------------------- */

    await useTool('text', { color: '#cc0000', stroke: 8 });
    const textAt = await pt(40, 240);
    await cdp.click(ed, textAt);
    await sleep(200);

    const inputVisible = await cdp.evaluate(
      ed,
      `!document.getElementById('text-input').hidden`
    );
    check(inputVisible === true, 'Text opened an input where clicked', 'Text did not open its input');

    await cdp.typeText(ed, 'HELLO');
    await sleep(80);
    await cdp.pressEnter(ed);
    await sleep(250);

    const textRegion = await region(36, 236, 150, 44);
    check(
      textRegion.nonWhite > 40,
      `Text rendered onto the image (${textRegion.nonWhite} pixels drawn)`,
      `Text did not render (${textRegion.nonWhite} pixels drawn)`
    );

    const inputHidden = await cdp.evaluate(ed, `document.getElementById('text-input').hidden`);
    check(inputHidden === true, 'Text input closed after Enter', 'Text input stayed open after Enter');

    // Clicking away should also commit. Moving focus elsewhere is the same
    // blur path a user takes when they click back onto the page.
    const blurAt = await pt(28, 172);
    await cdp.click(ed, blurAt);
    await sleep(180);
    await cdp.typeText(ed, 'BYE');
    await sleep(80);
    await cdp.evaluate(ed, `document.getElementById('filename').focus()`);
    await sleep(250);

    const blurCommitted = await region(24, 168, 120, 40);
    check(
      blurCommitted.nonWhite > 20,
      `Text also commits when focus moves away (${blurCommitted.nonWhite} pixels drawn)`,
      `Text was lost when focus moved away (${blurCommitted.nonWhite} pixels drawn)`
    );

    // Exactly one undo must remove it. If the blur handler had double fired,
    // a second copy would still be sitting underneath.
    await cdp.evaluate(ed, `document.getElementById('undo').click()`);
    await sleep(250);
    const afterOneUndo = await region(24, 168, 120, 40);
    check(
      afterOneUndo.nonWhite === 0,
      'Text was committed exactly once (a single undo removed it)',
      `Text was committed more than once (${afterOneUndo.nonWhite} pixels survived one undo)`
    );

    /* ---- Redact: must be genuinely opaque ------------------------- */

    await useTool('redact');
    await dragImage([180, 120], [240, 170]);
    const redacted = await region(186, 126, 48, 38);
    check(
      redacted.allBlack,
      'Redact produced fully opaque black over the whole selection',
      'Redact left non-black pixels inside the selection'
    );

    /* ---- Crop, and whether annotations stay anchored -------------- */

    await useTool('crop');
    await dragImage([20, 20], [220, 180]);

    // Crossing the canvas on the way to the Apply button must not resize the
    // selection. Releasing the button ends the drag; the rectangle that is left
    // on screen is the one Apply has to use. Without that distinction the crop
    // silently followed the cursor and Apply cropped to wherever it stopped.
    await cdp.hover(ed, await pt(340, 260));
    await sleep(120);
    await cdp.hover(ed, await pt(60, 60));
    await sleep(120);

    await cdp.evaluate(ed, `document.getElementById('crop-apply').click()`);
    await sleep(300);

    const cropped = await canvasSize();
    check(
      cropped.w === 200 && cropped.h === 160,
      `Crop used the rectangle that was drawn, not the cursor (${cropped.w}x${cropped.h})`,
      `Crop gave ${cropped.w}x${cropped.h}, expected 200x160 (did hovering move it?)`
    );

    // The box was drawn at image (40,40). After cropping at (20,20) its top
    // edge must sit at canvas (70,20). If the crop origin were applied twice,
    // this pixel would be white.
    const boxAfterCrop = await px(70, 20);
    check(
      boxAfterCrop[1] > 140 && boxAfterCrop[0] < 120,
      'Annotations stayed anchored to the image through a crop',
      `Annotation shifted after crop (pixel rgb ${boxAfterCrop.slice(0, 3)})`
    );

    /* ---- Undo ----------------------------------------------------- */

    await cdp.evaluate(ed, `document.getElementById('undo').click()`);
    await sleep(250);
    const undone = await canvasSize();
    check(
      undone.w === IMAGE_W && undone.h === IMAGE_H,
      'Undo reversed the crop',
      `Undo left the canvas at ${undone.w}x${undone.h}`
    );

    /* ---- Keyboard shortcuts --------------------------------------- */

    const activeTool = () =>
      cdp.evaluate(ed, `document.querySelector('.tool.is-active')?.dataset.tool ?? null`);

    await useTool('move');

    // The reported bug: bare-letter tool shortcuts were matched without
    // checking modifiers, so Ctrl+C selected Crop instead of copying.
    await cdp.pressKey(ed, 'c', { ctrl: true });
    await sleep(200);
    const afterCtrlC = await activeTool();
    check(
      afterCtrlC === 'move',
      'Ctrl+C no longer switches to the crop tool',
      `Ctrl+C selected "${afterCtrlC}" instead of leaving the tool alone`
    );

    // Bare C still selects crop.
    await cdp.pressKey(ed, 'c');
    await sleep(200);
    const afterC = await activeTool();
    check(afterC === 'crop', 'Bare C still selects the crop tool', `Bare C selected "${afterC}"`);

    // Escape leaves crop and returns to move.
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      ed
    );
    await sleep(200);
    const afterEscape = await activeTool();
    check(
      afterEscape === 'move',
      'Escape leaves the crop tool',
      `Escape left the tool as "${afterEscape}"`
    );

    // Other command combinations must not select tools either.
    for (const [letter, name] of [
      ['v', 'move'],
      ['a', 'arrow'],
      ['t', 'text'],
      ['b', 'redact'],
      ['p', 'pixelate'],
      ['r', 'box'],
    ]) {
      await useTool('move');
      await cdp.pressKey(ed, letter, { ctrl: true });
      await sleep(90);
      const got = await activeTool();
      if (got !== 'move') {
        fail(`Ctrl+${letter.toUpperCase()} wrongly selected the ${name} tool`);
        break;
      }
      if (letter === 'r') pass('No Ctrl combination selects a tool by accident');
    }

    /* ---- Export still works after all of that --------------------- */

    const exported = await cdp.evaluate(
      ed,
      `(async () => {
         const c = document.getElementById('canvas');
         const b = await new Promise((r) => c.toBlob(r, 'image/png'));
         return b ? b.size : 0;
       })()`
    );
    check(exported > 500, `Export encoded a PNG after editing (${exported} bytes)`, 'Export failed after editing');
  } finally {
    await shutdown(session);
  }

  console.log('\n--- tool results ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error('\nharness error:', err.message);
  process.exit(1);
});
