/**
 * Capture geometry. Pure functions, no browser APIs, so the arithmetic that
 * decides where every slice lands can be unit tested directly.
 *
 * Conventions:
 *   - Anything named *Css is in CSS pixels (what the page scrolls in).
 *   - Anything named *Px is in device pixels (what the captured bitmap is in).
 *   - `scale` converts one to the other and is MEASURED from the first captured
 *     bitmap, never read from devicePixelRatio, which drifts under browser zoom.
 */
globalThis.FS = globalThis.FS || {};

FS.plan = {
  /**
   * Split a page into a grid of viewport-sized capture positions.
   *
   * The last row and column are clamped by the browser: asking to scroll past
   * the end lands short, so those tiles overlap their neighbour. That is fine
   * and deliberate. Slices are drawn at the offset the page ACTUALLY landed on,
   * so the overlap paints over identical pixels instead of leaving a seam.
   */
  tiles({ pageWidthCss, pageHeightCss, viewWidthCss, viewHeightCss }) {
    if (viewWidthCss <= 0 || viewHeightCss <= 0) {
      throw new Error('viewport must have a positive size');
    }
    const xs = FS.plan.axisPositions(pageWidthCss, viewWidthCss);
    const ys = FS.plan.axisPositions(pageHeightCss, viewHeightCss);
    const out = [];
    // Row-major: scrolling down a column then jumping back is more jarring to
    // watch, and vertical pages are the common case.
    for (const y of ys) for (const x of xs) out.push({ x, y });
    return out;
  },

  /** Scroll offsets covering `total` in `step`-sized windows, last one clamped. */
  axisPositions(total, step) {
    if (total <= step) return [0];
    const positions = [];
    for (let p = 0; p < total - step; p += step) positions.push(p);
    positions.push(total - step); // exact end, so nothing is missed
    return positions;
  },

  /**
   * Decide the output scale.
   *
   * Oversized canvases do not throw in Chrome; they silently stop accepting
   * draws, which is how a very long page turns into a blank image. So the
   * budget is respected up front by scaling down, and the caller is told, rather
   * than discovering the failure after the capture is spent.
   */
  fitToBudget({ pageWidthCss, pageHeightCss, scale, maxArea, maxDimension }) {
    let effective = scale;
    const reasons = [];

    const dimLimit = Math.min(
      maxDimension / Math.max(1, pageWidthCss),
      maxDimension / Math.max(1, pageHeightCss)
    );
    if (effective > dimLimit) {
      effective = dimLimit;
      reasons.push('dimension');
    }

    const areaLimit = Math.sqrt(maxArea / Math.max(1, pageWidthCss * pageHeightCss));
    if (effective > areaLimit) {
      effective = areaLimit;
      reasons.push('area');
    }

    // Round down to a hundredth so the final canvas is never a fraction over.
    effective = Math.max(0.05, Math.floor(effective * 100) / 100);

    return {
      scale: effective,
      downscaled: effective < scale - 1e-9,
      reasons,
      widthPx: Math.max(1, Math.floor(pageWidthCss * effective)),
      heightPx: Math.max(1, Math.floor(pageHeightCss * effective)),
    };
  },

  /**
   * Where a captured viewport bitmap belongs on the stitch canvas, and which
   * part of it to keep.
   *
   * Two corrections happen here. The scrollbar gutter is cropped off so no
   * scrollbar is baked into the output, and the source rect is clamped so a
   * clamped final tile cannot draw past the canvas edge.
   */
  placement({
    landedXCss,
    landedYCss,
    viewWidthCss,
    viewHeightCss,
    scrollbarWidthCss = 0,
    scrollbarHeightCss = 0,
    bitmapWidthPx,
    bitmapHeightPx,
    scale,
    canvasWidthPx,
    canvasHeightPx,
  }) {
    // The bitmap covers the viewport including its scrollbars; trim them.
    const usableWidthCss = Math.max(0, viewWidthCss - scrollbarWidthCss);
    const usableHeightCss = Math.max(0, viewHeightCss - scrollbarHeightCss);

    // Capture-space scale can differ slightly from output scale (the bitmap is
    // always at device resolution; output may be downscaled to fit the budget).
    const srcScaleX = bitmapWidthPx / viewWidthCss;
    const srcScaleY = bitmapHeightPx / viewHeightCss;

    let destX = Math.round(landedXCss * scale);
    let destY = Math.round(landedYCss * scale);
    let destW = Math.round(usableWidthCss * scale);
    let destH = Math.round(usableHeightCss * scale);

    // Clamp against the canvas so the last tile cannot overflow it.
    const overflowX = Math.max(0, destX + destW - canvasWidthPx);
    const overflowY = Math.max(0, destY + destH - canvasHeightPx);
    destW -= overflowX;
    destH -= overflowY;

    if (destW <= 0 || destH <= 0) return null;

    return {
      srcX: 0,
      srcY: 0,
      srcW: Math.min(bitmapWidthPx, Math.round((destW / scale) * srcScaleX)),
      srcH: Math.min(bitmapHeightPx, Math.round((destH / scale) * srcScaleY)),
      destX,
      destY,
      destW,
      destH,
    };
  },

  /**
   * Paginate a tall image across PDF pages.
   *
   * Slicing is done in image space so no single oversized canvas is ever needed:
   * each page is rendered from its own strip of the source.
   */
  paginate({ imageWidthPx, imageHeightPx, pageWidthPt, pageHeightPt, marginPt = 0 }) {
    const usableW = pageWidthPt - marginPt * 2;
    const usableH = pageHeightPt - marginPt * 2;
    if (usableW <= 0 || usableH <= 0) throw new Error('margins exceed page size');

    // Fit to width, then however much height that leaves per page.
    const ptPerPx = usableW / imageWidthPx;
    const stripHeightPx = Math.max(1, Math.floor(usableH / ptPerPx));

    const pages = [];
    for (let y = 0; y < imageHeightPx; y += stripHeightPx) {
      const h = Math.min(stripHeightPx, imageHeightPx - y);
      pages.push({
        sourceY: y,
        sourceHeight: h,
        drawWidthPt: usableW,
        drawHeightPt: h * ptPerPx,
        offsetXPt: marginPt,
        // PDF's origin is bottom-left, so a top-aligned strip sits at
        // pageHeight - margin - drawHeight.
        offsetYPt: pageHeightPt - marginPt - h * ptPerPx,
      });
    }
    return pages;
  },

  /** Build a filename from a template, keeping it safe for every filesystem. */
  filename(template, { title, url, date }) {
    const d = date ?? new Date();
    const pad = (n) => String(n).padStart(2, '0');
    let host = '';
    try {
      host = url ? new URL(url).hostname.replace(/^www\./, '') : '';
    } catch {
      host = '';
    }
    const values = {
      title: (title || 'screenshot').trim(),
      host,
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    };
    const raw = template.replace(/\{(\w+)\}/g, (m, key) =>
      key in values ? values[key] : m
    );
    return (
      raw
        // Reserved on Windows, plus control characters. Hyphens and spaces
        // survive: the default template uses a hyphen as its separator.
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        // A leading dot would make the file hidden on unix.
        .replace(/^\.+/, '')
        .slice(0, 120)
        .trim() || 'screenshot'
    );
  },
};
