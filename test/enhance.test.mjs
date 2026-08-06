import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLibs } from './helper.mjs';

const FS = await loadLibs(['enhance']);

/** Build an RGBA image from a per-pixel callback. */
function image(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a ?? 255;
    }
  }
  return { data, width, height };
}

const pixel = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

test('sharpen leaves a flat area completely unchanged', () => {
  // The kernel sums to 1, so uniform regions must not drift. If they did,
  // enhancement would tint every screenshot.
  const img = image(9, 9, () => [120, 130, 140]);
  FS.enhance.sharpen(img, 0.9);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      assert.deepEqual(pixel(img, x, y), [120, 130, 140, 255], `pixel ${x},${y} drifted`);
    }
  }
});

test('sharpen increases contrast across an edge', () => {
  // A vertical edge: dark on the left, light on the right, like text on paper.
  const img = image(9, 9, (x) => (x < 4 ? [60, 60, 60] : [200, 200, 200]));
  const beforeDark = pixel(img, 3, 4)[0];
  const beforeLight = pixel(img, 4, 4)[0];

  FS.enhance.sharpen(img, 0.8);

  const afterDark = pixel(img, 3, 4)[0];
  const afterLight = pixel(img, 4, 4)[0];

  assert.ok(afterDark < beforeDark, 'the dark side of an edge should get darker');
  assert.ok(afterLight > beforeLight, 'the light side of an edge should get lighter');
  assert.ok(
    afterLight - afterDark > beforeLight - beforeDark,
    'edge contrast should increase overall'
  );
});

test('sharpen never touches the alpha channel', () => {
  const img = image(7, 7, (x) => (x < 3 ? [10, 10, 10, 40] : [240, 240, 240, 200]));
  FS.enhance.sharpen(img, 0.9);
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const expected = x < 3 ? 40 : 200;
      assert.equal(pixel(img, x, y)[3], expected, `alpha changed at ${x},${y}`);
    }
  }
});

test('sharpen clamps instead of wrapping around', () => {
  // An extreme edge at full strength overshoots past 0 and 255. Asserting the
  // result lands in 0..255 proves nothing, because the buffer is a
  // Uint8ClampedArray and cannot hold anything else: the old assertion here
  // passed just as happily on a sharpen that wrapped 260 round to 4.
  //
  // So compute the same convolution in plain numbers and check that the
  // overshoot really did happen and really was clamped rather than wrapped.
  const img = image(7, 7, (x) => (x < 3 ? [0, 0, 0] : [255, 255, 255]));
  const before = Float64Array.from(img.data);
  FS.enhance.sharpen(img, 3);

  // The same 3x3 Laplacian the filter uses:  0 -a 0 / -a 1+4a -a / 0 -a 0.
  // Borders are deliberately left untouched, so only the interior is checked.
  const amount = 3;
  const at = (cx, cy) => before[(cy * 7 + cx) * 4];
  let sawOvershoot = false;
  let sawUndershoot = false;

  for (let y = 1; y < 6; y++) {
    for (let x = 1; x < 6; x++) {
      const raw =
        (1 + 4 * amount) * at(x, y) -
        amount * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1));
      const got = img.data[(y * 7 + x) * 4];
      if (raw > 255) {
        sawOvershoot = true;
        assert.equal(got, 255, `overshoot at ${x},${y} (raw ${raw}) wrapped instead of clamping`);
      } else if (raw < 0) {
        sawUndershoot = true;
        assert.equal(got, 0, `undershoot at ${x},${y} (raw ${raw}) wrapped instead of clamping`);
      } else {
        assert.equal(got, Math.round(raw), `interior pixel ${x},${y} is not the kernel's result`);
      }
    }
  }
  assert.ok(sawOvershoot, 'the fixture never overshot 255, so this test proves nothing');
  assert.ok(sawUndershoot, 'the fixture never undershot 0, so this test proves nothing');
});

test('sharpen is a no-op on an image too small to convolve', () => {
  const img = image(2, 2, () => [10, 20, 30]);
  const before = [...img.data];
  FS.enhance.sharpen(img, 0.9);
  assert.deepEqual([...img.data], before);
});

test('contrast pushes values away from mid grey', () => {
  const img = image(4, 1, (x) => {
    const v = [40, 100, 160, 220][x];
    return [v, v, v];
  });
  FS.enhance.contrast(img, 0.2);

  assert.ok(pixel(img, 0, 0)[0] < 40, 'dark values should get darker');
  assert.ok(pixel(img, 3, 0)[0] > 220, 'light values should get lighter');
});

test('contrast leaves mid grey where it is', () => {
  const img = image(1, 1, () => [128, 128, 128]);
  FS.enhance.contrast(img, 0.5);
  // 127.5 is the exact pivot, so 128 may land on either side by one.
  const value = pixel(img, 0, 0)[0];
  assert.ok(Math.abs(value - 128) <= 1, `mid grey moved to ${value}`);
});

test('every level is defined and ordered from gentle to strong', () => {
  const { subtle, medium, strong } = FS.enhance.LEVELS;
  assert.ok(subtle.sharpen < medium.sharpen);
  assert.ok(medium.sharpen < strong.sharpen);
  assert.ok(subtle.contrast < medium.contrast);
  assert.ok(medium.contrast < strong.contrast);
});

test('apply runs both passes and tolerates an unknown level', () => {
  const make = () => image(9, 9, (x) => (x < 4 ? [60, 60, 60] : [200, 200, 200]));

  const known = FS.enhance.apply(make(), 'strong');
  const fallback = FS.enhance.apply(make(), 'nonsense');

  assert.ok(pixel(known, 4, 4)[0] > 200, 'strong should brighten the light side of an edge');
  // An unknown level must not throw or leave the image untouched.
  assert.notDeepEqual([...fallback.data], [...make().data]);
});

test('isExpensive flags only very large captures', () => {
  assert.equal(FS.enhance.isExpensive(1920, 1080), false);
  assert.equal(FS.enhance.isExpensive(1500, 40000), true);
});
