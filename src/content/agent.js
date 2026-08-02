/**
 * Fullshot page agent.
 *
 * Injected on demand into the tab being captured. It owns every mutation made
 * to the page and is responsible for undoing all of them, including when the
 * capture fails partway through.
 *
 * Design rule throughout: measure, never assume. Scroll offsets are read back
 * after every move, because a page can clamp, snap or refuse a scroll, and a
 * slice placed at the offset we *asked* for rather than the one we *got* is
 * exactly what produces seams and duplicated strips.
 */
(() => {
  // Re-injection is normal (the background injects before every capture).
  if (window.__fullshotAgent) return;
  window.__fullshotAgent = true;

  const api = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;
  const STYLE_ID = 'fullshot-capture-style';
  const OVERLAY_ID = 'fullshot-overlay';
  const HIDE_ATTR = 'data-fullshot-hide';
  const STICKY_ATTR = 'data-fullshot-sticky';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  /** Everything mutated during a capture, so restore() can be exhaustive. */
  let session = null;

  /* ---------------------------------------------------------------- */
  /* Measurement                                                       */
  /* ---------------------------------------------------------------- */

  function docWidth() {
    const b = document.body;
    const d = document.documentElement;
    return Math.max(
      b?.scrollWidth ?? 0,
      b?.offsetWidth ?? 0,
      d.scrollWidth,
      d.offsetWidth,
      d.clientWidth
    );
  }

  function docHeight() {
    const b = document.body;
    const d = document.documentElement;
    return Math.max(
      b?.scrollHeight ?? 0,
      b?.offsetHeight ?? 0,
      d.scrollHeight,
      d.offsetHeight,
      d.clientHeight
    );
  }

  function measure() {
    return {
      pageWidthCss: docWidth(),
      pageHeightCss: docHeight(),
      // innerWidth includes the scrollbar gutter, and so does the captured
      // bitmap. clientWidth excludes it. The difference is what to crop.
      viewWidthCss: window.innerWidth,
      viewHeightCss: window.innerHeight,
      scrollbarWidthCss: Math.max(0, window.innerWidth - document.documentElement.clientWidth),
      scrollbarHeightCss: Math.max(0, window.innerHeight - document.documentElement.clientHeight),
      dpr: window.devicePixelRatio || 1,
      title: document.title || location.hostname,
      url: location.href,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Page hardening                                                    */
  /* ---------------------------------------------------------------- */

  function installStyle(settings) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    const rules = [
      // Programmatic scrolling must land exactly where it is told. Smooth
      // scrolling and scroll-snap both silently move the target.
      `html, body { scroll-behavior: auto !important; }`,
      `*, *::before, *::after { scroll-behavior: auto !important;
         scroll-snap-type: none !important; scroll-snap-align: none !important; }`,
      // Parallax backgrounds shift with the viewport and smear across slices.
      `* { background-attachment: scroll !important; }`,
      // Scroll anchoring silently moves the page to keep content visually
      // stable when something above the viewport changes size. Priming lazy
      // images does exactly that, so anchoring can undo a scroll back to the
      // top and leave the capture starting from wherever the user already was.
      `html, body, * { overflow-anchor: none !important; }`,
      // Sticky elements belong in the image once, in their natural position.
      `[${STICKY_ATTR}] { position: static !important; }`,
      `[${HIDE_ATTR}] { visibility: hidden !important; }`,
    ];
    if (settings.freezeMotion) {
      rules.push(
        `*, *::before, *::after {
           animation-play-state: paused !important;
           transition: none !important;
         }`
      );
    }
    if (settings.primeLazyContent) {
      // content-visibility:auto skips rendering offscreen subtrees entirely,
      // which reads as a blank band in a stitched image.
      rules.push(`* { content-visibility: visible !important; }`);
    }
    style.textContent = rules.join('\n');
    document.documentElement.appendChild(style);
    return style;
  }

  /**
   * Is this element part of what the user pointed at?
   *
   * The floating-chrome rules exist to get cookie bars and docked headers out of
   * a page capture. Applied to the capture target itself they do the opposite of
   * what was asked: a fixed sidebar picked in scrolling-panel mode was being
   * hidden as furniture, and since a hidden element still has a layout box the
   * stitch came back as a picture of whatever sat behind it. Ancestors count
   * too, because visibility is inherited.
   */
  function partOfTarget(el) {
    const target = session?.target;
    if (!target) return false;
    return el === target || el.contains(target) || target.contains(el);
  }

  /**
   * Classify floating chrome.
   *
   * Sticky and fixed are treated differently because they mean different
   * things. A sticky header is part of the document and should appear once
   * where it naturally sits. A fixed header is viewport furniture and should
   * appear once at the edge it is docked to.
   */
  function collectFloating() {
    const sticky = [];
    const fixed = [];
    const overlay = document.getElementById(OVERLAY_ID);

    for (const el of document.querySelectorAll('*')) {
      if (el === overlay || overlay?.contains(el)) continue;
      if (el.id === STYLE_ID) continue;
      if (partOfTarget(el)) continue;

      let cs;
      try {
        cs = getComputedStyle(el);
      } catch {
        continue;
      }
      if (cs.position === 'sticky') {
        sticky.push(el);
      } else if (cs.position === 'fixed') {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        // Docked to the top or the bottom? Compare the element's midpoint to
        // the viewport's. A full-height overlay counts as top so it shows on
        // the first slice.
        const mid = rect.top + rect.height / 2;
        fixed.push({ el, dock: mid <= window.innerHeight / 2 ? 'top' : 'bottom' });
      }
    }
    return { sticky, fixed };
  }

  function applyFloatingPolicy(rowIndex, rowCount) {
    if (!session) return;

    // Visible-area capture is a literal photograph of the screen, so page
    // furniture belongs in it exactly as the user sees it.
    if (session.mode === 'visible') return;

    // When a specific element or panel was picked, page-level fixed furniture
    // is not part of it. Leaving it visible composites a cookie bar or footer
    // over the thing the user actually asked for.
    const targeted = session.mode === 'element' || session.mode === 'area';
    if (!targeted && session.settings.floatingPolicy === 'keep') return;
    const hideAll = targeted || session.settings.floatingPolicy === 'never';

    for (const { el, dock } of session.floating.fixed) {
      const showHere =
        !hideAll && ((dock === 'top' && rowIndex === 0) || (dock === 'bottom' && rowIndex === rowCount - 1));
      if (showHere) el.removeAttribute(HIDE_ATTR);
      else el.setAttribute(HIDE_ATTR, '');
    }
  }

  /**
   * Scroll the window and CHECK that it landed.
   *
   * window.scrollTo is a request, not a guarantee. A page can ignore it, undo
   * it from a scroll handler, or move the page afterwards through scroll
   * anchoring. Nothing here used to verify the result, so a page that refused
   * to go back to the top produced a capture that started from wherever the
   * user already was, with the part above it left blank.
   *
   * Landing short at the end of the document is normal clamping, not failure,
   * so it is not retried. Callers still place slices by the MEASURED offset,
   * which is what keeps a partial move from corrupting the image.
   */
  async function scrollWindowTo(x, y) {
    const scroller = document.scrollingElement || document.documentElement;

    /**
     * Both axes, not just the vertical one.
     *
     * Only Y used to be checked, so on a page wider than the viewport every
     * column reported success whether or not it had moved sideways, and the
     * right-hand columns of the stitch came back as bare canvas.
     */
    const settled = () => {
      const offX = Math.abs(window.scrollX - x);
      const offY = Math.abs(window.scrollY - y);
      // Asking to go past the end lands short. That is the browser clamping,
      // and it is expected on the last tile of each axis.
      const maxX = Math.max(0, docWidth() - window.innerWidth);
      const maxY = Math.max(0, docHeight() - window.innerHeight);
      const okX = offX <= 1 || (x >= maxX && Math.abs(window.scrollX - maxX) <= 2);
      const okY = offY <= 1 || (y >= maxY && Math.abs(window.scrollY - maxY) <= 2);
      return okX && okY;
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      window.scrollTo(x, y);

      // Some pages leave window.scrollTo inert but honour the scrolling
      // element directly, so try that before giving up on this attempt.
      if (!settled() && scroller) {
        try {
          scroller.scrollTop = y;
          scroller.scrollLeft = x;
        } catch {
          /* not scrollable, nothing more to try */
        }
      }
      await nextFrame();

      if (settled()) return true;
      await sleep(40);
    }
    return settled();
  }

  /**
   * Wake lazily-loaded content by sweeping the page once.
   *
   * IntersectionObserver only fires for content that has actually been near the
   * viewport, so images below the fold never decode until something scrolls
   * past them. Promoting loading="lazy" alone is not enough for
   * observer-driven or background-image content.
   */
  async function primeLazyContent() {
    const promoted = [];
    for (const el of document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]')) {
      promoted.push({ el, previous: el.getAttribute('loading') });
      el.setAttribute('loading', 'eager');
    }
    session.promoted = promoted;

    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const height = docHeight();
    const maxSteps = 400; // a hard stop, so an infinite feed cannot hang here
    let steps = 0;

    for (let y = 0; y < height && steps < maxSteps; y += step, steps++) {
      window.scrollTo(0, y);
      await nextFrame();
      await sleep(40);
    }
    // Verified, because priming is exactly when scroll anchoring fires: the
    // images that just loaded are above the current position.
    await scrollWindowTo(0, 0);
    await sleep(60);
  }

  /** Wait for images near the viewport, bounded so one broken asset cannot stall. */
  async function waitForImages(timeoutMs) {
    const pending = [...document.images].filter((img) => {
      if (img.complete) return false;
      const r = img.getBoundingClientRect();
      return r.bottom > -200 && r.top < window.innerHeight + 200;
    });
    if (!pending.length) return;

    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            })
        )
      ),
      sleep(timeoutMs),
    ]);
  }

  /* ---------------------------------------------------------------- */
  /* Progress overlay                                                  */
  /* ---------------------------------------------------------------- */

  function buildOverlay() {
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    // A shadow root keeps the page's CSS from restyling our UI, and keeps our
    // CSS from touching the page.
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .card {
          position: fixed; inset-block-start: 16px; inset-inline-end: 16px;
          z-index: 2147483647;
          font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #0f172a; background: #fff;
          border: 1px solid #e2e8f0; border-radius: 12px;
          box-shadow: 0 10px 30px rgba(15, 23, 42, .18);
          padding: 12px 14px; width: 232px;
        }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .label { font-weight: 600; }
        .count { color: #64748b; font-variant-numeric: tabular-nums; }
        .track { height: 5px; background: #e2e8f0; border-radius: 999px; margin: 9px 0 10px; overflow: hidden; }
        .bar { height: 100%; width: 0%; background: #e11d48; border-radius: 999px; transition: width .18s ease; }
        button {
          width: 100%; font: inherit; font-weight: 600; color: #475569;
          background: #f1f5f9; border: 0; border-radius: 8px;
          padding: 7px; cursor: pointer;
        }
        button:hover { background: #e2e8f0; color: #0f172a; }
        @media (prefers-color-scheme: dark) {
          .card { color: #e2e8f0; background: #1e293b; border-color: #334155; }
          .track { background: #334155; }
          button { background: #334155; color: #cbd5e1; }
          button:hover { background: #475569; color: #fff; }
        }
      </style>
      <div class="card" part="card">
        <div class="row"><span class="label">Capturing page</span><span class="count"></span></div>
        <div class="track"><div class="bar"></div></div>
        <button type="button">Cancel</button>
      </div>
    `;
    root.querySelector('button').addEventListener('click', () => {
      if (session) session.cancelled = true;
      setOverlayText('Cancelling...');
    });
    document.documentElement.appendChild(host);
    return { host, root };
  }

  function setOverlayProgress(done, total) {
    if (!session?.overlay) return;
    const { root } = session.overlay;
    root.querySelector('.count').textContent = `${done} / ${total}`;
    root.querySelector('.bar').style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
  }

  function setOverlayText(text) {
    if (!session?.overlay) return;
    session.overlay.root.querySelector('.label').textContent = text;
  }

  /** The overlay is fixed-position, so it would land in the shot. Hide it. */
  function showOverlay(visible) {
    if (!session?.overlay) return;
    session.overlay.host.style.display = visible ? '' : 'none';
  }

  /* ---------------------------------------------------------------- */
  /* Element picker                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Where every scroller between `el` and the document currently sits.
   *
   * Capturing a panel rewinds it to its top, and bringing an element into view
   * can move any scroller above it. Only the window's own position used to be
   * put back, so taking a screenshot of one message in a mail client dumped the
   * user at the other end of the thread when it finished.
   */
  function scrollChainOf(el) {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      chain.push({ el: n, top: n.scrollTop, left: n.scrollLeft });
    }
    return chain;
  }

  function nearestScrollable(start) {
    for (let el = start; el && el !== document.body; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const scrolls = /auto|scroll|overlay/.test(cs.overflowY);
      if (scrolls && el.scrollHeight > el.clientHeight + 4) return el;
    }
    return null;
  }

  /**
   * Let the user point at what they want.
   *
   * `kind: 'area'` resolves to the nearest scrolling ancestor, which is how the
   * real content in mail clients and chat apps is reached: it lives in an inner
   * pane, not in the document scroll.
   */
  function pickTarget(kind) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      Object.assign(box.style, {
        position: 'fixed',
        zIndex: '2147483646',
        pointerEvents: 'none',
        border: '2px solid #e11d48',
        background: 'rgba(225, 29, 72, .12)',
        borderRadius: '3px',
        transition: 'all .05s linear',
        display: 'none',
      });
      const hint = document.createElement('div');
      Object.assign(hint.style, {
        position: 'fixed',
        zIndex: '2147483647',
        insetBlockStart: '16px',
        insetInlineStart: '50%',
        transform: 'translateX(-50%)',
        font: '600 13px system-ui, sans-serif',
        color: '#fff',
        background: '#0f172a',
        padding: '8px 14px',
        borderRadius: '999px',
        pointerEvents: 'none',
        boxShadow: '0 6px 20px rgba(15,23,42,.3)',
      });
      hint.textContent =
        kind === 'area'
          ? 'Click a scrolling area to capture. Esc to cancel.'
          : 'Click an element to capture. Esc to cancel.';

      document.documentElement.append(box, hint);
      let current = null;

      const onMove = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === box || el === hint) return;
        const target = kind === 'area' ? nearestScrollable(el) ?? el : el;
        current = target;
        const r = target.getBoundingClientRect();
        Object.assign(box.style, {
          display: 'block',
          insetBlockStart: `${r.top}px`,
          insetInlineStart: `${r.left}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
      };
      const cleanup = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        box.remove();
        hint.remove();
      };
      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        resolve(current);
      };
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        cleanup();
        resolve(null);
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  async function prepare(mode, settings) {
    const warnings = [];

    session = {
      settings,
      cancelled: false,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      promoted: [],
      scrollers: [],
      watchdog: null,
      floating: { sticky: [], fixed: [] },
      style: null,
      overlay: null,
      target: null,
      mode,
      region: null,
      usableWidthCss: 1,
      usableHeightCss: 1,
    };

    if (mode === 'element' || mode === 'area') {
      const picked = await pickTarget(mode);
      if (!picked) {
        restore();
        return { ok: false, error: 'CANCELLED' };
      }
      session.target = picked;
      // Recorded before anything is moved, which is the only moment these
      // values are still the user's.
      session.scrollers = scrollChainOf(picked);
    }

    session.style = installStyle(settings);
    if (mode !== 'visible') session.overlay = buildOverlay();

    if (settings.primeLazyContent && mode !== 'visible') {
      setOverlayText('Loading images');
      await primeLazyContent();
      await waitForImages(settings.imageWaitMs);
    }

    // Sticky and fixed are classified AFTER priming, because priming can add
    // banners and reveal chrome that did not exist at load.
    session.floating = collectFloating();

    // "Leave them alone" has to mean exactly that. Converting sticky elements
    // to static regardless of the setting would contradict the option's own
    // label, and would leave no way to capture a page the naive way on purpose.
    // Visible-area capture never needs it either, being a single photograph.
    if (settings.floatingPolicy !== 'keep' && mode !== 'visible') {
      for (const el of session.floating.sticky) el.setAttribute(STICKY_ATTR, '');
    }

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, sleep(1200)]);
    }

    // Return to the top only when the whole page is going to be walked.
    // Visible-area capture must photograph what the user is actually looking
    // at, so moving the page first would defeat the entire mode.
    if (mode === 'full') {
      const landed = await scrollWindowTo(0, 0);
      if (!landed) {
        warnings.push(
          'This page would not scroll back to the top, so the capture may be missing content above where you were. Pages that take over scrolling can behave this way.'
        );
      }
    }

    const metrics = measure();

    // Work out WHAT is being captured. Every mode is a rectangular region of
    // something, and expressing all of them the same way is what keeps the
    // stitcher from having a special case per mode.
    const usableWidthCss = Math.max(1, metrics.viewWidthCss - metrics.scrollbarWidthCss);
    const usableHeightCss = Math.max(1, metrics.viewHeightCss - metrics.scrollbarHeightCss);
    session.usableWidthCss = usableWidthCss;
    session.usableHeightCss = usableHeightCss;
    metrics.usableWidthCss = usableWidthCss;
    metrics.usableHeightCss = usableHeightCss;

    let region;
    let step = { w: usableWidthCss, h: usableHeightCss };

    if (mode === 'visible') {
      // Exactly what the user is looking at, and nothing more.
      region = {
        x: window.scrollX,
        y: window.scrollY,
        w: usableWidthCss,
        h: usableHeightCss,
      };
    } else if (mode === 'element') {
      // An element inside its own scrolling ancestor cannot be reached by
      // scrolling the window, so ask the browser to bring it into view first.
      const clipper = nearestScrollable(session.target.parentElement);
      if (clipper) {
        session.target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        await nextFrame();
        warnings.push(
          'That element sits inside its own scrolling panel. Only the part that fits in the panel could be captured, so try the scrolling panel mode for the whole thing.'
        );
      }

      // The element's box in DOCUMENT coordinates. Measured now, after
      // priming, because loading images can move things.
      const rect = session.target.getBoundingClientRect();
      region = {
        x: Math.max(0, rect.left + window.scrollX),
        y: Math.max(0, rect.top + window.scrollY),
        w: Math.max(1, Math.round(rect.width)),
        h: Math.max(1, Math.round(rect.height)),
      };
    } else if (mode === 'area') {
      const el = session.target;
      el.scrollTop = 0;
      el.scrollLeft = 0;
      await nextFrame();
      const visible = bringPaneIntoView();
      await nextFrame();
      // The pane's whole scrollable content, both axes.
      region = {
        x: 0,
        y: 0,
        w: Math.max(1, el.scrollWidth),
        h: Math.max(1, el.scrollHeight),
      };
      // A pane that still cannot be brought meaningfully on screen would give a
      // step of a few pixels, and a few pixels of step over a full-size pane is
      // thousands of screenshots. Say so instead of grinding.
      if (visible.width < 40 || visible.height < 40) {
        restore();
        return {
          ok: false,
          error:
            'Almost none of that panel is on screen, so there is nothing to scroll through. Bring it into view and try again.',
        };
      }

      // Step by how much of the pane is actually on screen, slightly reduced
      // so consecutive slices overlap rather than risk a one-pixel gap.
      step = {
        w: Math.max(1, visible.width - 8),
        h: Math.max(1, visible.height - 8),
      };
      if (el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2) {
        warnings.push('That panel does not scroll, so it was captured as it appears.');
      }
    } else {
      region = { x: 0, y: 0, w: metrics.pageWidthCss, h: metrics.pageHeightCss };
    }

    session.region = region;
    metrics.region = region;
    metrics.captureWidthCss = region.w;
    metrics.captureHeightCss = region.h;
    metrics.stepWidthCss = step.w;
    metrics.stepHeightCss = step.h;

    if (metrics.captureHeightCss > 60000) {
      warnings.push(
        'This page is extremely long, so the capture may take a while and will be scaled down to fit an image.'
      );
    }
    if (document.querySelectorAll('iframe').length > 0) {
      const crossOrigin = [...document.querySelectorAll('iframe')].filter((f) => {
        try {
          return !f.contentDocument;
        } catch {
          return true;
        }
      }).length;
      if (crossOrigin > 0) {
        warnings.push(
          `${crossOrigin} embedded frame${crossOrigin > 1 ? 's' : ''} on this page come from another site. They are captured as they appear, but cannot be scrolled or expanded.`
        );
      }
    }

    setOverlayText('Capturing page');
    metrics.warnings = warnings;
    armWatchdog();
    return { ok: true, metrics };
  }

  /**
   * A scrollable element's PADDING box, in viewport coordinates.
   *
   * This distinction matters and is easy to get wrong. getBoundingClientRect
   * returns the BORDER box, but scrollTop, scrollLeft, clientWidth and
   * clientHeight are all relative to the padding box. Treating the border box
   * as the origin of scrolled content shifts every slice by the border width
   * and paints the border itself into the output.
   */
  function paneBox() {
    const el = session.target;
    const rect = el.getBoundingClientRect();
    let borderLeft = 0;
    let borderTop = 0;
    try {
      const cs = getComputedStyle(el);
      borderLeft = parseFloat(cs.borderLeftWidth) || 0;
      borderTop = parseFloat(cs.borderTopWidth) || 0;
    } catch {
      /* fall back to the border box */
    }
    return {
      left: rect.left + borderLeft,
      top: rect.top + borderTop,
      // clientWidth/clientHeight are the padding box, minus any scrollbar.
      width: Math.max(1, el.clientWidth),
      height: Math.max(1, el.clientHeight),
    };
  }

  /**
   * Scroll the window so an inner pane is on screen.
   * Returns how much of the pane is actually visible, in CSS pixels.
   */
  function bringPaneIntoView() {
    const usableH = session.usableHeightCss;
    const usableW = session.usableWidthCss;
    let box = paneBox();

    const onScreenW = (b) => Math.min(b.left + b.width, usableW) - Math.max(0, b.left);

    // Only move the page if the pane is off screen or awkwardly low; a pane
    // already comfortably in view should stay where the user had it.
    if (box.top < 0 || box.top > usableH * 0.4) {
      window.scrollBy(0, box.top - 8);
      box = paneBox();
    }
    // Horizontally the page used to be left alone entirely, so a pane pushed
    // off the side of a wide layout measured as one pixel across. The capture
    // step is derived from that measurement, so it asked for one screenshot per
    // pixel of the pane's width and appeared to hang for minutes.
    if (onScreenW(box) < Math.min(box.width, 40)) {
      window.scrollBy(box.left - 8, 0);
      box = paneBox();
    }
    return {
      height: Math.max(1, Math.min(box.top + box.height, usableH) - Math.max(0, box.top)),
      width: Math.max(1, onScreenW(box)),
    };
  }

  /**
   * The part of the current viewport that belongs to the region, and where it
   * lands in the output image. Both in CSS pixels.
   *
   * Returning `skip` is normal: a region smaller than the viewport simply is
   * not present in every slice.
   */
  function documentClip() {
    const region = session.region;
    const usableW = session.usableWidthCss;
    const usableH = session.usableHeightCss;

    // The region, expressed in viewport coordinates as things stand now.
    const vx = region.x - window.scrollX;
    const vy = region.y - window.scrollY;

    const x0 = Math.max(0, vx);
    const y0 = Math.max(0, vy);
    const x1 = Math.min(usableW, vx + region.w);
    const y1 = Math.min(usableH, vy + region.h);
    if (x1 <= x0 || y1 <= y0) return { skip: true };

    const clip = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    return {
      clip,
      // Derived from the offset the page ACTUALLY landed on. Browsers clamp a
      // scroll at the end of the document, which makes the last slice overlap
      // the previous one; measuring rather than assuming makes that harmless.
      outX: window.scrollX + clip.x - region.x,
      outY: window.scrollY + clip.y - region.y,
    };
  }

  /** The same, for a pane that scrolls its own content. */
  function paneClip() {
    const el = session.target;
    const usableW = session.usableWidthCss;
    const usableH = session.usableHeightCss;
    // The padding box, so the pane's own border is never painted into the
    // output and scrollTop lines up with the content it addresses.
    const box = paneBox();

    const x0 = Math.max(0, box.left);
    const y0 = Math.max(0, box.top);
    const x1 = Math.min(usableW, box.left + box.width);
    const y1 = Math.min(usableH, box.top + box.height);
    if (x1 <= x0 || y1 <= y0) return { skip: true };

    const clip = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    return {
      clip,
      // The pane's own scroll offsets decide which content sits at its top
      // left corner, so output position follows those, not the window.
      outX: el.scrollLeft + (clip.x - box.left),
      outY: el.scrollTop + (clip.y - box.top),
    };
  }

  async function goto(msg) {
    if (!session) return { ok: false, error: 'Capture session was lost.' };
    if (session.cancelled) return { ok: false, cancelled: true };
    armWatchdog();

    applyFloatingPolicy(msg.rowIndex, msg.rowCount);

    if (session.mode === 'area') {
      session.target.scrollTop = msg.y;
      session.target.scrollLeft = msg.x;
      await nextFrame();
      bringPaneIntoView();
    } else if (session.mode !== 'visible') {
      // Targets arrive in output space, so shift them by the region origin.
      await scrollWindowTo(session.region.x + msg.x, session.region.y + msg.y);
    }

    await nextFrame();
    await sleep(session.settings.settleMs);
    await waitForImages(session.settings.imageWaitMs);
    // Layout can shift while images decode, so settle once more before reading.
    await nextFrame();

    setOverlayProgress(msg.index + 1, msg.total);
    showOverlay(false);
    // One more frame so the hidden overlay is actually off-screen when the
    // browser takes the photograph.
    await nextFrame();

    if (session.cancelled) {
      showOverlay(true);
      return { ok: false, cancelled: true };
    }

    const placement = session.mode === 'area' ? paneClip() : documentClip();
    return { ok: true, ...placement, pageHeightCss: docHeight() };
  }

  function restore() {
    if (!session) return;
    clearTimeout(session.watchdog);

    session.style?.remove();
    session.overlay?.host.remove();

    for (const { el, previous } of session.promoted) {
      if (previous === null) el.removeAttribute('loading');
      else el.setAttribute('loading', previous);
    }
    for (const el of session.floating.sticky) el.removeAttribute(STICKY_ATTR);
    for (const { el } of session.floating.fixed) el.removeAttribute(HIDE_ATTR);

    // Innermost first, because putting an outer scroller back can move the
    // ones inside it.
    for (const { el, top, left } of session.scrollers) {
      try {
        el.scrollTop = top;
        el.scrollLeft = left;
      } catch {
        /* the element may have been replaced by the page since */
      }
    }
    window.scrollTo(session.scrollX, session.scrollY);
    session = null;
  }

  /**
   * Hand the page back if the extension goes quiet.
   *
   * Every mutation here is undone by an FS_RESTORE from the background, and an
   * MV3 service worker can be terminated at any point, including halfway
   * through a long capture. Nothing would then ever send that message, and the
   * page would keep this stylesheet, its hidden banners and the progress card
   * until it was reloaded. The gap between two messages is normally about a
   * second, so a minute of silence means the other end is gone.
   */
  const WATCHDOG_MS = 60000;

  function armWatchdog() {
    if (!session) return;
    clearTimeout(session.watchdog);
    session.watchdog = setTimeout(restore, WATCHDOG_MS);
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.type?.startsWith('FS_')) return false;

    if (msg.type === 'FS_PREPARE') {
      prepare(msg.mode, msg.settings)
        .then(sendResponse)
        .catch((err) => {
          restore();
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        });
      return true;
    }
    if (msg.type === 'FS_GOTO') {
      goto(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true;
    }
    if (msg.type === 'FS_AFTER_SHOT') {
      showOverlay(true);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'FS_RESTORE') {
      restore();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // If the user navigates mid-capture the session is meaningless; make sure the
  // page is not left with our stylesheet or hidden elements.
  window.addEventListener('pagehide', restore, { once: true });
})();
