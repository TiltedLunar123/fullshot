import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helper.mjs';

const FS = await loadLibs(['plan']);

test('axisPositions covers the whole axis and ends exactly at the edge', () => {
  // 1000px of content through a 300px window.
  const positions = FS.plan.axisPositions(1000, 300);
  assert.equal(positions[0], 0);
  assert.equal(positions.at(-1), 700, 'last window must end exactly at the content edge');

  // Every pixel must fall inside at least one window.
  for (let p = 0; p < 1000; p++) {
    assert.ok(
      positions.some((start) => p >= start && p < start + 300),
      `pixel ${p} was not covered by any capture position`
    );
  }
});

test('axisPositions returns a single position when content fits the window', () => {
  assert.deepEqual(FS.plan.axisPositions(400, 800), [0]);
  assert.deepEqual(FS.plan.axisPositions(800, 800), [0]);
});

test('the final position overlaps rather than overshooting', () => {
  // 1000 / 300 does not divide evenly, so the last window must back up.
  const positions = FS.plan.axisPositions(1000, 300);
  assert.deepEqual(positions, [0, 300, 600, 700]);
  // The overlap is deliberate: slices are placed at their MEASURED offset, so
  // overlapping paints identical pixels instead of leaving a seam.
  assert.ok(positions.at(-1) < positions.at(-2) + 300);
});

test('tiles produces a full grid for pages wider than the viewport', () => {
  const tiles = FS.plan.tiles({
    pageWidthCss: 2000,
    pageHeightCss: 1500,
    viewWidthCss: 800,
    viewHeightCss: 600,
  });
  const xs = [...new Set(tiles.map((t) => t.x))];
  const ys = [...new Set(tiles.map((t) => t.y))];
  assert.deepEqual(xs, [0, 800, 1200]);
  assert.deepEqual(ys, [0, 600, 900]);
  assert.equal(tiles.length, xs.length * ys.length);
});

test('tiles rejects a zero-sized viewport instead of looping forever', () => {
  assert.throws(() =>
    FS.plan.tiles({ pageWidthCss: 100, pageHeightCss: 100, viewWidthCss: 0, viewHeightCss: 600 })
  );
});

test('fitToBudget leaves the scale alone when the image fits', () => {
  const fit = FS.plan.fitToBudget({
    pageWidthCss: 1200,
    pageHeightCss: 3000,
    scale: 2,
    maxArea: 268435456,
    maxDimension: 32767,
  });
  assert.equal(fit.scale, 2);
  assert.equal(fit.downscaled, false);
  assert.equal(fit.widthPx, 2400);
  assert.equal(fit.heightPx, 6000);
});

test('fitToBudget scales down to respect the area limit', () => {
  // A big square page: total area binds long before either single axis does.
  const maxArea = 268435456;
  const maxDimension = 65535;
  const fit = FS.plan.fitToBudget({
    pageWidthCss: 20000,
    pageHeightCss: 20000,
    scale: 2,
    maxArea,
    maxDimension,
  });
  assert.ok(fit.downscaled);
  assert.ok(fit.reasons.includes('area'), `expected area to bind, got ${fit.reasons}`);
  assert.ok(
    fit.widthPx * fit.heightPx <= maxArea,
    `result ${fit.widthPx}x${fit.heightPx} still exceeds the area budget`
  );
});

test('fitToBudget respects both budgets at once on a very long page', () => {
  // 80000 CSS px tall against a 65535 dimension cap: height binds first, and
  // the area budget must still hold afterwards.
  const maxArea = 268435456;
  const maxDimension = 65535;
  const fit = FS.plan.fitToBudget({
    pageWidthCss: 1600,
    pageHeightCss: 80000,
    scale: 2,
    maxArea,
    maxDimension,
  });
  assert.ok(fit.downscaled);
  assert.ok(fit.heightPx <= maxDimension, `height ${fit.heightPx} exceeds the dimension cap`);
  assert.ok(fit.widthPx * fit.heightPx <= maxArea, 'area budget violated');
});

test('fitToBudget respects a single-axis dimension limit', () => {
  const maxDimension = 16384;
  const fit = FS.plan.fitToBudget({
    pageWidthCss: 1000,
    pageHeightCss: 40000,
    scale: 2,
    maxArea: 1073741824,
    maxDimension,
  });
  assert.ok(fit.downscaled);
  assert.ok(fit.reasons.includes('dimension'));
  assert.ok(fit.heightPx <= maxDimension, `height ${fit.heightPx} exceeds ${maxDimension}`);
});

test('placeClip keeps a viewport-sized capture at its natural size', () => {
  // This is the visible-area case. The canvas is the size of the viewport, so
  // the bitmap must land 1:1. Sizing the canvas to the whole page and drawing
  // into all of it is what produced a badly stretched image.
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 0,
    clip: { x: 0, y: 0, w: 785, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 785,
    canvasHeightPx: 600,
  });
  assert.equal(place.destX, 0);
  assert.equal(place.destY, 0);
  assert.equal(place.destW, 785, 'destination must match the clip, not the canvas');
  assert.equal(place.destH, 600);
  assert.equal(place.srcW, 785, 'source must match too, or the image is scaled');
  assert.equal(place.srcH, 600);
});

test('placeClip maps the clip through the scrollbar-inclusive bitmap', () => {
  // The bitmap covers the whole viewport including the scrollbar gutter, so a
  // 785px clip of an 800px viewport must read 785 bitmap px, not 800.
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 0,
    clip: { x: 0, y: 0, w: 785, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 1600, // 2x DPR
    bitmapHeightPx: 1200,
    scale: 1,
    canvasWidthPx: 785,
    canvasHeightPx: 600,
  });
  assert.equal(place.srcW, 1570, '785 CSS px at 2x device pixels is 1570');
  assert.equal(place.destW, 785);
});

test('placeClip offsets an element region away from the page origin', () => {
  // An element at document (300, 2400). The slice that shows its top-left is
  // captured with the page scrolled to (300, 2400), so the element starts at
  // viewport (0,0) and belongs at output (0,0). Getting this wrong is what
  // made element capture return the top-left of the page instead.
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 0,
    clip: { x: 0, y: 0, w: 500, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 500,
    canvasHeightPx: 1800,
  });
  assert.equal(place.destX, 0);
  assert.equal(place.destW, 500, 'only the element width is kept');
  assert.equal(place.srcW, 500);
});

test('placeClip places a later slice of a region at its output offset', () => {
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 600,
    clip: { x: 0, y: 0, w: 500, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 500,
    canvasHeightPx: 1800,
  });
  assert.equal(place.destY, 600);
  assert.equal(place.destH, 600);
});

test('placeClip reads from the middle of the viewport when the region does', () => {
  // A short element sitting partway down the screen: the clip starts at a
  // viewport offset, so the source rect must start there too.
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 0,
    clip: { x: 120, y: 200, w: 300, h: 150 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 300,
    canvasHeightPx: 150,
  });
  assert.equal(place.srcX, 120);
  assert.equal(place.srcY, 200);
  assert.equal(place.destX, 0);
  assert.equal(place.destY, 0);
});

test('placeClip clamps the final slice to the canvas edge', () => {
  // The browser clamps the last scroll, so the last slice overlaps. It must be
  // cropped at the canvas edge rather than overflowing it.
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 400,
    clip: { x: 0, y: 0, w: 800, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 800,
    canvasHeightPx: 1000,
  });
  assert.equal(place.destY, 400);
  assert.equal(place.destH, 600);
  assert.ok(place.destY + place.destH <= 1000, 'slice must not overflow the canvas');
});

test('placeClip crops rather than squashes a clamped slice', () => {
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 900,
    clip: { x: 0, y: 0, w: 800, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 800,
    canvasHeightPx: 1000,
  });
  assert.equal(place.destH, 100, 'only 100px of canvas remains');
  assert.equal(place.srcH, 100, 'so only 100px of source may be read');
});

test('placeClip scales device pixels correctly on a HiDPI capture', () => {
  const place = FS.plan.placeClip({
    outXCss: 0,
    outYCss: 600,
    clip: { x: 0, y: 0, w: 800, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 1600, // 2x device pixel ratio
    bitmapHeightPx: 1200,
    scale: 2,
    canvasWidthPx: 1600,
    canvasHeightPx: 4000,
  });
  assert.equal(place.destY, 1200, 'a 600 CSS px offset at 2x is 1200 device px');
  assert.equal(place.destW, 1600);
  assert.equal(place.destH, 1200);
  assert.equal(place.srcW, 1600);
  assert.equal(place.srcH, 1200);
});

test('placeClip rejects an empty or missing clip', () => {
  const base = {
    outXCss: 0,
    outYCss: 0,
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 800,
    canvasHeightPx: 600,
  };
  assert.equal(FS.plan.placeClip({ ...base, clip: null }), null);
  assert.equal(FS.plan.placeClip({ ...base, clip: { x: 0, y: 0, w: 0, h: 100 } }), null);
});

test('placeClip returns null when a slice would be entirely off-canvas', () => {
  const place = FS.plan.placeClip({
    outXCss: 2000,
    outYCss: 0,
    clip: { x: 0, y: 0, w: 800, h: 600 },
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 800,
    bitmapHeightPx: 600,
    scale: 1,
    canvasWidthPx: 800,
    canvasHeightPx: 600,
  });
  assert.equal(place, null);
});

test('paginate covers every row of the image exactly once', () => {
  const pages = FS.plan.paginate({
    imageWidthPx: 1200,
    imageHeightPx: 5000,
    pageWidthPt: 595.28,
    pageHeightPt: 841.89,
    marginPt: 24,
  });
  assert.ok(pages.length > 1);
  assert.equal(pages[0].sourceY, 0);

  let covered = 0;
  for (const page of pages) {
    assert.equal(page.sourceY, covered, 'pages must be contiguous with no gap or overlap');
    covered += page.sourceHeight;
  }
  assert.equal(covered, 5000, 'pagination must cover the whole image');
});

test('paginate keeps every page inside its printable area', () => {
  const pageHeightPt = 841.89;
  const margin = 24;
  const pages = FS.plan.paginate({
    imageWidthPx: 1200,
    imageHeightPx: 5000,
    pageWidthPt: 595.28,
    pageHeightPt,
    marginPt: margin,
  });
  for (const page of pages) {
    assert.ok(page.drawHeightPt <= pageHeightPt - margin * 2 + 0.01, 'page content overflows');
    assert.ok(page.offsetYPt >= margin - 0.01, 'page content starts above the margin');
  }
});

test('paginate rejects margins larger than the page', () => {
  assert.throws(() =>
    FS.plan.paginate({
      imageWidthPx: 100,
      imageHeightPx: 100,
      pageWidthPt: 100,
      pageHeightPt: 100,
      marginPt: 60,
    })
  );
});

test('filename substitutes tokens and keeps the hyphen separator', () => {
  const name = FS.plan.filename('{title} - {date}', {
    title: 'Quarterly report',
    url: 'https://www.example.com/reports',
    date: new Date(2026, 6, 29),
  });
  assert.equal(name, 'Quarterly report - 2026-07-29');
});

test('filename strips characters that are illegal in a file name', () => {
  const name = FS.plan.filename('{title}', {
    title: 'a/b\\c:d*e?f"g<h>i|j',
    url: 'https://example.com',
    date: new Date(2026, 0, 1),
  });
  for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
    assert.ok(!name.includes(bad), `"${bad}" survived sanitising`);
  }
});

test('filename never returns an empty or dot-prefixed name', () => {
  assert.equal(FS.plan.filename('{title}', { title: '...', url: '', date: new Date() }), 'screenshot');
  assert.equal(FS.plan.filename('{title}', { title: '   ', url: '', date: new Date() }), 'screenshot');
});

test('filename resolves the host token without the www prefix', () => {
  const name = FS.plan.filename('{host}-{date}', {
    title: 'x',
    url: 'https://www.example.co.uk/page?q=1',
    date: new Date(2026, 6, 29),
  });
  assert.equal(name, 'example.co.uk-2026-07-29');
});
