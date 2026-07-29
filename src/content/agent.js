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
    if (!session || session.settings.floatingPolicy === 'keep') return;
    const hideAll = session.settings.floatingPolicy === 'never';

    for (const { el, dock } of session.floating.fixed) {
      const showHere =
        !hideAll && ((dock === 'top' && rowIndex === 0) || (dock === 'bottom' && rowIndex === rowCount - 1));
      if (showHere) el.removeAttribute(HIDE_ATTR);
      else el.setAttribute(HIDE_ATTR, '');
    }
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
    window.scrollTo(0, 0);
    await nextFrame();
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
        .bar { height: 100%; width: 0%; background: #4f46e5; border-radius: 999px; transition: width .18s ease; }
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
        border: '2px solid #4f46e5',
        background: 'rgba(79, 70, 229, .12)',
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
      floating: { sticky: [], fixed: [] },
      style: null,
      overlay: null,
      target: null,
    };

    if (mode === 'element' || mode === 'area') {
      const picked = await pickTarget(mode);
      if (!picked) {
        restore();
        return { ok: false, error: 'CANCELLED' };
      }
      session.target = picked;
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
    for (const el of session.floating.sticky) el.setAttribute(STICKY_ATTR, '');

    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, sleep(1200)]);
    }

    window.scrollTo(0, 0);
    await nextFrame();

    const metrics = measure();

    // An element or inner-pane capture is bounded by that element, not the page.
    if (session.target) {
      const rect = session.target.getBoundingClientRect();
      metrics.pageWidthCss = Math.min(metrics.pageWidthCss, Math.ceil(rect.width));
      metrics.pageHeightCss =
        mode === 'area'
          ? session.target.scrollHeight
          : Math.ceil(rect.height + window.scrollY + rect.top);
    }

    if (metrics.pageHeightCss > 60000) {
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
    return { ok: true, metrics };
  }

  async function goto(msg) {
    if (!session) return { ok: false, error: 'Capture session was lost.' };
    if (session.cancelled) return { ok: false, cancelled: true };

    applyFloatingPolicy(msg.rowIndex, msg.rowCount);

    if (session.target && session.settings && msg.rowCount) {
      // Inner-pane mode drives the element's own scroll offset.
      if (session.target.scrollHeight > session.target.clientHeight) {
        session.target.scrollTop = msg.y;
      }
    }
    window.scrollTo(msg.x, msg.y);

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

    return {
      ok: true,
      // The offset the page ACTUALLY landed on. Clamping at the end of the
      // document is normal and makes the last slice overlap the previous one;
      // placing by measured offset makes that overlap harmless.
      landedX: window.scrollX,
      landedY: window.scrollY,
      pageHeightCss: docHeight(),
    };
  }

  function restore() {
    if (!session) return;

    session.style?.remove();
    session.overlay?.host.remove();

    for (const { el, previous } of session.promoted) {
      if (previous === null) el.removeAttribute('loading');
      else el.setAttribute('loading', previous);
    }
    for (const el of session.floating.sticky) el.removeAttribute(STICKY_ATTR);
    for (const { el } of session.floating.fixed) el.removeAttribute(HIDE_ATTR);

    window.scrollTo(session.scrollX, session.scrollY);
    session = null;
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
