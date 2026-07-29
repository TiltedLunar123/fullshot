/**
 * Runtime canvas budget probing.
 *
 * Maximum canvas size is not a spec constant. It varies by engine, platform,
 * GPU and available memory, so the widely-quoted numbers are only ever a
 * starting guess. Worse, exceeding the limit in Chrome does not throw: the
 * canvas simply stops accepting draws and you get a blank image. That silent
 * mode is exactly how a long-page capture ends up empty.
 *
 * So Fullshot measures instead of assuming: allocate a candidate canvas, draw a
 * known pixel, read it back, and step down until one survives the round trip.
 */
globalThis.FS = globalThis.FS || {};

FS.canvasBudget = {
  /** Descending candidates, in total pixels. */
  AREA_CANDIDATES: [
    1073741824, //  32768^2, generous modern desktop
    536870912,
    268435456, //  16384^2, the commonly quoted Chrome ceiling
    134217728,
    67108864,
    16777216, //   4096^2, very conservative floor
  ],

  DIMENSION_CANDIDATES: [65535, 32767, 16384, 8192, 4096],

  _cache: null,

  /**
   * Verify a canvas of this exact size really works.
   *
   * Reading the pixel back is the important part. Allocation frequently
   * succeeds on a canvas that will silently refuse to paint.
   */
  async probeSize(width, height) {
    let canvas;
    try {
      canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      if (canvas.width !== width || canvas.height !== height) return false;

      // Paint the far corner: a canvas over budget often keeps its first
      // scanline and drops the rest.
      ctx.fillStyle = '#ff8000';
      ctx.fillRect(width - 2, height - 2, 2, 2);
      const data = ctx.getImageData(width - 1, height - 1, 1, 1).data;
      return data[0] === 255 && data[1] === 128 && data[3] === 255;
    } catch {
      return false;
    } finally {
      // Release the allocation promptly; probing walks large sizes.
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
  },

  /**
   * Find the largest workable square area and single-axis dimension.
   * Cached for the life of the worker, and persisted so later captures on the
   * same machine skip the probe entirely.
   */
  async measure({ force = false } = {}) {
    if (this._cache && !force) return this._cache;

    if (!force) {
      const saved = await FS.settings.getCachedBudget();
      if (saved) {
        this._cache = saved;
        return saved;
      }
    }

    let maxArea = this.AREA_CANDIDATES[this.AREA_CANDIDATES.length - 1];
    for (const area of this.AREA_CANDIDATES) {
      const side = Math.floor(Math.sqrt(area));
      if (await this.probeSize(side, side)) {
        maxArea = area;
        break;
      }
    }

    // A tall, narrow canvas is the shape that actually matters here, so probe
    // the long axis separately rather than inferring it from area.
    let maxDimension = this.DIMENSION_CANDIDATES[this.DIMENSION_CANDIDATES.length - 1];
    for (const dim of this.DIMENSION_CANDIDATES) {
      if (await this.probeSize(64, dim)) {
        maxDimension = dim;
        break;
      }
    }

    const budget = { maxArea, maxDimension, measuredAt: Date.now() };
    this._cache = budget;
    await FS.settings.setCachedBudget(budget);
    return budget;
  },
};
