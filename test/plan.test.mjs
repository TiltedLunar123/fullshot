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

test('placement crops the scrollbar gutter out of every slice', () => {
  const place = FS.plan.placement({
    landedXCss: 0,
    landedYCss: 0,
    viewWidthCss: 800,
    viewHeightCss: 600,
    scrollbarWidthCss: 15,
    scrollbarHeightCss: 0,
    bitmapWidthPx: 1600,
    bitmapHeightPx: 1200,
    scale: 1,
    canvasWidthPx: 785,
    canvasHeightPx: 5000,
  });
  // 800 CSS px of viewport minus a 15px scrollbar leaves 785 of real content.
  assert.equal(place.destW, 785);
  assert.equal(place.destX, 0);
});

test('placement clamps the final slice to the canvas edge', () => {
  // A page 1000 tall with a 600 viewport: the last slice lands at 400 and
  // would otherwise draw 200px past the bottom of the canvas.
  const place = FS.plan.placement({
    landedXCss: 0,
    landedYCss: 400,
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

test('placement returns null when a slice would be entirely off-canvas', () => {
  const place = FS.plan.placement({
    landedXCss: 2000,
    landedYCss: 0,
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

test('placement scales device pixels correctly on a HiDPI capture', () => {
  const place = FS.plan.placement({
    landedXCss: 0,
    landedYCss: 600,
    viewWidthCss: 800,
    viewHeightCss: 600,
    bitmapWidthPx: 1600, // 2x device pixel ratio
    bitmapHeightPx: 1200,
    scale: 2,
    canvasWidthPx: 1600,
    canvasHeightPx: 4000,
  });
  assert.equal(place.destX, 0);
  assert.equal(place.destY, 1200, 'a 600 CSS px offset at 2x is 1200 device px');
  assert.equal(place.destW, 1600);
  assert.equal(place.destH, 1200);
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
