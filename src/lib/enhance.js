/**
 * Text legibility enhancement.
 *
 * Screenshot text loses definition in two common ways: the capture gets scaled
 * down to fit a canvas budget, or it is exported as JPEG. Both soften exactly
 * the high-frequency edges that make small text readable.
 *
 * This applies an unsharp mask followed by a gentle contrast curve. The
 * sharpen kernel is a 3x3 Laplacian, which is cheap and targets edge
 * transitions rather than adding grain across flat areas the way a larger
 * radius would.
 *
 * Deliberately NOT upscaling: inventing pixels makes text look worse, not
 * better, and would misrepresent what was on screen.
 */
globalThis.FS = globalThis.FS || {};

FS.enhance = {
  /**
   * `sharpen` is the Laplacian weight; `contrast` is the S-curve strength.
   * Values were chosen so even `strong` stays short of visible haloing on
   * ordinary body text.
   */
  LEVELS: {
    subtle: { sharpen: 0.25, contrast: 0.04 },
    medium: { sharpen: 0.55, contrast: 0.08 },
    strong: { sharpen: 0.95, contrast: 0.14 },
  },

  /**
   * Enhance pixel data in place.
   *
   * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData
   * @param {'subtle'|'medium'|'strong'} level
   * @returns the same imageData, mutated
   */
  apply(imageData, level = 'medium') {
    const settings = this.LEVELS[level] ?? this.LEVELS.medium;
    if (settings.sharpen > 0) this.sharpen(imageData, settings.sharpen);
    if (settings.contrast > 0) this.contrast(imageData, settings.contrast);
    return imageData;
  },

  /**
   * Unsharp mask via a 3x3 Laplacian.
   *
   *      0   -a    0
   *     -a  1+4a  -a
   *      0   -a    0
   *
   * The kernel sums to 1, so flat regions keep their exact value and only
   * edges move. Reading from a snapshot of the original keeps already-sharpened
   * neighbours from compounding across the image.
   */
  sharpen(imageData, amount) {
    const { data, width, height } = imageData;
    if (width < 3 || height < 3 || amount <= 0) return imageData;

    const source = new Uint8ClampedArray(data);
    const centre = 1 + 4 * amount;

    // Borders are left untouched: a one-pixel frame is invisible in practice
    // and skipping it avoids either clamping artefacts or a branch per pixel.
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        const up = i - width * 4;
        const down = i + width * 4;

        // Alpha is left alone; sharpening it would fringe transparent edges.
        for (let c = 0; c < 3; c++) {
          const value =
            source[i + c] * centre -
            amount * (source[up + c] + source[down + c] + source[i - 4 + c] + source[i + 4 + c]);
          data[i + c] = value < 0 ? 0 : value > 255 ? 255 : value;
        }
      }
    }
    return imageData;
  },

  /**
   * Symmetric contrast around mid grey.
   *
   * Uses a lookup table rather than recomputing per pixel: there are only 256
   * possible inputs, and a full-page screenshot can be tens of millions of them.
   */
  contrast(imageData, strength) {
    const { data } = imageData;
    if (strength <= 0) return imageData;

    const factor = 1 + strength;
    const table = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      table[v] = (v / 255 - 0.5) * factor * 255 + 127.5;
    }

    for (let i = 0; i < data.length; i += 4) {
      data[i] = table[data[i]];
      data[i + 1] = table[data[i + 1]];
      data[i + 2] = table[data[i + 2]];
    }
    return imageData;
  },

  /**
   * Rough cost estimate, so the caller can warn before a long pass on a very
   * large capture instead of appearing to freeze.
   */
  isExpensive(width, height) {
    return width * height > 30_000_000;
  },
};
