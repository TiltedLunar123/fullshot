/**
 * Fullshot editor.
 *
 * State model: the captured bitmap is never modified. A crop rectangle and a
 * list of annotation shapes sit on top of it, both stored in ORIGINAL image
 * coordinates. Rendering and export apply them.
 *
 * That keeps undo cheap (a snapshot is a small object, not another copy of a
 * possibly 200MB image) and makes cropping non-destructive, so a crop can be
 * undone long after later annotations were added.
 */
(() => {
  const api = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;

  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const wrap = $('#wrap');
  const cropOverlay = $('#crop-overlay');
  const textInput = $('#text-input');
  const hint = $('#hint');

  /** Redaction is always opaque black; that is what "blacked out" means. */
  const REDACT_FILL = '#000000';
  const PIXELATE_BLOCK = 12;

  let base = null; // ImageBitmap, never mutated
  let record = null;
  let tool = 'move';
  let state = { crop: null, shapes: [] };
  const undoStack = [];
  const redoStack = [];

  /**
   * Sharpening is expensive on a full-page capture, so the enhanced copy is
   * computed once and reused for every render and export until the setting
   * changes. `base` itself is never modified, so the toggle stays reversible.
   */
  let enhanced = { canvas: null, level: null };

  function enhanceOn() {
    return $('#enhance').checked;
  }

  function buildEnhanced(level) {
    const canvas = document.createElement('canvas');
    canvas.width = base.width;
    canvas.height = base.height;
    const ectx = canvas.getContext('2d', { willReadFrequently: true });
    ectx.drawImage(base, 0, 0);

    const imageData = ectx.getImageData(0, 0, canvas.width, canvas.height);
    FS.enhance.apply(imageData, level);
    ectx.putImageData(imageData, 0, 0);

    enhanced = { canvas, level };
    return canvas;
  }

  /** The image everything draws from: the original, or its sharpened copy. */
  function source() {
    if (!enhanceOn()) return base;
    const level = $('#enhance-level').value;
    if (enhanced.canvas && enhanced.level === level) return enhanced.canvas;
    return buildEnhanced(level);
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function cropRect() {
    return state.crop ?? { x: 0, y: 0, w: base.width, h: base.height };
  }

  function render() {
    const c = cropRect();
    if (canvas.width !== c.w || canvas.height !== c.h) {
      canvas.width = c.w;
      canvas.height = c.h;
    }
    ctx.clearRect(0, 0, c.w, c.h);
    ctx.drawImage(source(), c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    for (const shape of state.shapes) drawShape(ctx, shape, c);
    updateMeta();
  }

  function drawShape(target, shape, c) {
    const x = shape.x - c.x;
    const y = shape.y - c.y;

    target.save();
    target.lineCap = 'round';
    target.lineJoin = 'round';
    target.strokeStyle = shape.color;
    target.fillStyle = shape.color;
    target.lineWidth = shape.stroke;

    switch (shape.type) {
      case 'box':
        target.strokeRect(x, y, shape.w, shape.h);
        break;

      case 'redact':
        target.fillStyle = REDACT_FILL;
        target.fillRect(x, y, shape.w, shape.h);
        break;

      case 'pixelate':
        drawPixelated(target, shape, c);
        break;

      case 'arrow':
        drawArrow(target, x, y, x + shape.w, y + shape.h, shape.stroke);
        break;

      case 'text':
        target.font = `600 ${Math.max(12, shape.stroke * 3.6)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        target.textBaseline = 'top';
        // A thin light halo keeps text legible over busy screenshots.
        target.strokeStyle = 'rgba(255,255,255,.85)';
        target.lineWidth = Math.max(2, shape.stroke * 0.6);
        target.strokeText(shape.text, x, y);
        target.fillStyle = shape.color;
        target.fillText(shape.text, x, y);
        break;
    }
    target.restore();
  }

  /**
   * Pixelation samples the untouched base image, so it always obscures the
   * original pixels rather than whatever happens to be drawn on top.
   */
  function drawPixelated(target, shape, c) {
    const w = Math.abs(shape.w);
    const h = Math.abs(shape.h);
    if (w < 2 || h < 2) return;

    const smallW = Math.max(1, Math.round(w / PIXELATE_BLOCK));
    const smallH = Math.max(1, Math.round(h / PIXELATE_BLOCK));

    const tmp = document.createElement('canvas');
    tmp.width = smallW;
    tmp.height = smallH;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(
      source(),
      Math.min(shape.x, shape.x + shape.w),
      Math.min(shape.y, shape.y + shape.h),
      w,
      h,
      0,
      0,
      smallW,
      smallH
    );

    target.imageSmoothingEnabled = false;
    target.drawImage(
      tmp,
      Math.min(shape.x, shape.x + shape.w) - c.x,
      Math.min(shape.y, shape.y + shape.h) - c.y,
      w,
      h
    );
    target.imageSmoothingEnabled = true;
  }

  function drawArrow(target, x1, y1, x2, y2, stroke) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(10, stroke * 3.2);

    target.beginPath();
    target.moveTo(x1, y1);
    // Stop the shaft short so it does not poke through the arrowhead.
    target.lineTo(x2 - Math.cos(angle) * head * 0.6, y2 - Math.sin(angle) * head * 0.6);
    target.stroke();

    target.beginPath();
    target.moveTo(x2, y2);
    target.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
    target.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
    target.closePath();
    target.fill();
  }

  /* ---------------------------------------------------------------- */
  /* History                                                           */
  /* ---------------------------------------------------------------- */

  function snapshot() {
    undoStack.push(structuredClone(state));
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    $('#undo').disabled = undoStack.length === 0;
    $('#redo').disabled = redoStack.length === 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(structuredClone(state));
    state = undoStack.pop();
    updateHistoryButtons();
    render();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(structuredClone(state));
    state = redoStack.pop();
    updateHistoryButtons();
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Pointer handling                                                  */
  /* ---------------------------------------------------------------- */

  /** Map a pointer event to ORIGINAL image coordinates. */
  function toImage(event) {
    const rect = canvas.getBoundingClientRect();
    const c = cropRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width + c.x,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height + c.y,
    };
  }

  let drag = null;

  canvas.addEventListener('pointerdown', (event) => {
    if (tool === 'move') return;
    if (tool === 'text') {
      startText(event);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    drag = { start: toImage(event), current: toImage(event) };
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    drag.current = toImage(event);
    if (tool === 'crop') {
      paintCropOverlay();
    } else {
      // Preview the shape without committing it to history.
      render();
      const preview = shapeFromDrag();
      if (preview) drawShape(ctx, preview, cropRect());
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!drag) return;
    canvas.releasePointerCapture(event.pointerId);

    if (tool === 'crop') {
      // Crop is confirmed with the Apply button, not on release.
      drag.pending = true;
      return;
    }

    const shape = shapeFromDrag();
    drag = null;
    if (!shape) {
      render();
      return;
    }
    snapshot();
    state.shapes.push(shape);
    render();
  });

  function shapeFromDrag() {
    if (!drag) return null;
    const w = drag.current.x - drag.start.x;
    const h = drag.current.y - drag.start.y;
    // Ignore stray clicks that were not really a drag.
    if (tool !== 'arrow' && (Math.abs(w) < 3 || Math.abs(h) < 3)) return null;
    if (tool === 'arrow' && Math.hypot(w, h) < 6) return null;

    const color = $('#color').value;
    const stroke = Number($('#stroke').value);

    if (tool === 'arrow') {
      return { type: 'arrow', x: drag.start.x, y: drag.start.y, w, h, color, stroke };
    }
    // Normalise so a drag in any direction gives a positive-size rectangle.
    return {
      type: tool,
      x: Math.min(drag.start.x, drag.current.x),
      y: Math.min(drag.start.y, drag.current.y),
      w: Math.abs(w),
      h: Math.abs(h),
      color,
      stroke,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Crop                                                              */
  /* ---------------------------------------------------------------- */

  function paintCropOverlay() {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const c = cropRect();
    const displayScale = rect.width / canvas.width;

    const x1 = (Math.min(drag.start.x, drag.current.x) - c.x) * displayScale + (rect.left - wrapRect.left);
    const y1 = (Math.min(drag.start.y, drag.current.y) - c.y) * displayScale + (rect.top - wrapRect.top);

    Object.assign(cropOverlay.style, {
      left: `${x1}px`,
      top: `${y1}px`,
      width: `${Math.abs(drag.current.x - drag.start.x) * displayScale}px`,
      height: `${Math.abs(drag.current.y - drag.start.y) * displayScale}px`,
    });
    cropOverlay.hidden = false;
  }

  function applyCrop() {
    if (!drag) return;
    const x = Math.round(Math.min(drag.start.x, drag.current.x));
    const y = Math.round(Math.min(drag.start.y, drag.current.y));
    const w = Math.round(Math.abs(drag.current.x - drag.start.x));
    const h = Math.round(Math.abs(drag.current.y - drag.start.y));
    if (w < 8 || h < 8) {
      setHint('That crop area is too small.');
      return;
    }

    snapshot();
    // Clamp to the image so a drag past the edge cannot produce empty bands.
    state.crop = {
      x: Math.max(0, x),
      y: Math.max(0, y),
      w: Math.min(w, base.width - Math.max(0, x)),
      h: Math.min(h, base.height - Math.max(0, y)),
    };
    cancelCrop();
    render();
  }

  function cancelCrop() {
    drag = null;
    cropOverlay.hidden = true;
    render();
  }

  /* ---------------------------------------------------------------- */
  /* Text tool                                                         */
  /* ---------------------------------------------------------------- */

  function startText(event) {
    // Without this the browser moves focus on mouse-up, which immediately
    // blurs the input being opened here and commits an empty shape before the
    // user has typed a single character.
    event.preventDefault();

    const point = toImage(event);
    const rect = canvas.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();

    Object.assign(textInput.style, {
      left: `${event.clientX - wrapRect.left}px`,
      top: `${event.clientY - wrapRect.top}px`,
      color: $('#color').value,
      fontSize: `${Math.max(12, Number($('#stroke').value) * 3.6) * (rect.width / canvas.width)}px`,
    });
    textInput.value = '';
    textInput.hidden = false;
    textInput.focus();

    // Setting `hidden` below itself fires a blur, which would re-enter commit
    // and push the same text twice. One flag closes both paths.
    let finished = false;

    const teardown = () => {
      finished = true;
      textInput.hidden = true;
      textInput.removeEventListener('blur', commit);
      textInput.removeEventListener('keydown', onKey);
    };

    const commit = () => {
      if (finished) return;
      const text = textInput.value.trim();
      teardown();
      if (!text) return;
      snapshot();
      state.shapes.push({
        type: 'text',
        x: point.x,
        y: point.y,
        w: 0,
        h: 0,
        text,
        color: $('#color').value,
        stroke: Number($('#stroke').value),
      });
      render();
    };

    const onKey = (e) => {
      // Keep typing contained: the editor's single-key tool shortcuts must not
      // fire while the user is writing a label.
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') teardown();
    };

    textInput.addEventListener('keydown', onKey);
    // Attach blur only after the current input sequence has settled, so the
    // focus churn from this very click cannot commit an empty shape.
    requestAnimationFrame(() => {
      if (!finished) textInput.addEventListener('blur', commit);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Export                                                            */
  /* ---------------------------------------------------------------- */

  function toBlob(target, type, quality) {
    return new Promise((resolve, reject) => {
      target.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(`This browser could not encode ${type}.`))),
        type,
        quality
      );
    });
  }

  async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  /** Render the current crop plus annotations to a fresh canvas. */
  function flatten() {
    const c = cropRect();
    const out = document.createElement('canvas');
    out.width = c.w;
    out.height = c.h;
    const octx = out.getContext('2d');
    octx.drawImage(source(), c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    for (const shape of state.shapes) drawShape(octx, shape, c);
    return out;
  }

  async function buildPdf(flat, quality) {
    const [pageWidthPt, pageHeightPt] = FS.pdf.PAGE_SIZES[$('#paper').value];
    const margin = 24;
    const layout = FS.plan.paginate({
      imageWidthPx: flat.width,
      imageHeightPx: flat.height,
      pageWidthPt,
      pageHeightPt,
      marginPt: margin,
    });

    // Each page is encoded from its own strip, so no single oversized canvas
    // is ever required no matter how tall the capture is.
    const strip = document.createElement('canvas');
    const sctx = strip.getContext('2d');
    const pages = [];

    for (const page of layout) {
      strip.width = flat.width;
      strip.height = page.sourceHeight;
      // JPEG has no alpha; without this, transparent areas encode as black.
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, strip.width, strip.height);
      sctx.drawImage(
        flat,
        0,
        page.sourceY,
        flat.width,
        page.sourceHeight,
        0,
        0,
        flat.width,
        page.sourceHeight
      );
      pages.push({
        jpeg: await blobToBytes(await toBlob(strip, 'image/jpeg', quality)),
        widthPx: strip.width,
        heightPx: strip.height,
        drawWidthPt: page.drawWidthPt,
        drawHeightPt: page.drawHeightPt,
        offsetXPt: page.offsetXPt,
        offsetYPt: page.offsetYPt,
      });
    }

    const bytes = FS.pdf.build(pages, {
      pageWidthPt,
      pageHeightPt,
      title: record?.title ?? 'Screenshot',
    });
    return { blob: new Blob([bytes], { type: 'application/pdf' }), pageCount: pages.length };
  }

  async function save() {
    const format = $('#format').value;
    const quality = Number($('#quality').value) / 100;
    setHint('Preparing...');

    try {
      const flat = flatten();
      let blob;
      let extension = format;
      let note = '';

      if (format === 'pdf') {
        const result = await buildPdf(flat, quality);
        blob = result.blob;
        note = `${result.pageCount} page${result.pageCount > 1 ? 's' : ''}`;
      } else if (format === 'jpeg') {
        // Flatten onto white first; JPEG cannot carry transparency.
        const opaque = document.createElement('canvas');
        opaque.width = flat.width;
        opaque.height = flat.height;
        const octx = opaque.getContext('2d');
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, opaque.width, opaque.height);
        octx.drawImage(flat, 0, 0);
        blob = await toBlob(opaque, 'image/jpeg', quality);
        extension = 'jpg';
      } else if (format === 'webp') {
        blob = await toBlob(flat, 'image/webp', quality);
      } else {
        blob = await toBlob(flat, 'image/png');
      }

      const name = `${$('#filename').value || 'screenshot'}.${extension}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      // Revoke on the next turn so the download has definitely started.
      setTimeout(() => URL.revokeObjectURL(url), 30000);

      setHint(`Saved ${name} (${formatBytes(blob.size)}${note ? `, ${note}` : ''}).`);
    } catch (err) {
      setHint(String(err?.message ?? err));
    }
  }

  async function copyToClipboard() {
    setHint('Copying...');
    try {
      // Clipboard image support is PNG-only in practice.
      const blob = await toBlob(flatten(), 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setHint('Copied. Paste it anywhere.');
    } catch (err) {
      setHint(`Could not copy: ${err?.message ?? err}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Chrome                                                            */
  /* ---------------------------------------------------------------- */

  function setHint(text) {
    hint.textContent = text;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function updateMeta() {
    const c = cropRect();
    $('#dims').textContent = `${c.w} x ${c.h}`;
  }

  function selectTool(next) {
    tool = next;
    for (const button of document.querySelectorAll('.tool')) {
      button.classList.toggle('is-active', button.dataset.tool === next);
    }
    $('.crop-bar').hidden = next !== 'crop';
    if (next !== 'crop') cropOverlay.hidden = true;
    canvas.style.cursor = next === 'move' ? 'default' : next === 'text' ? 'text' : 'crosshair';
  }

  function syncFormatFields() {
    const format = $('#format').value;
    $('#quality-field').hidden = format === 'png';
    $('#paper-field').hidden = format !== 'pdf';
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  async function boot() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) {
      $('#loading').textContent = 'No screenshot was requested.';
      return;
    }

    record = await FS.store.get(id);
    if (!record?.blob) {
      $('#loading').textContent =
        'That screenshot is no longer available. Captures are cleared after a day.';
      return;
    }

    base = await createImageBitmap(record.blob);
    $('#loading').hidden = true;
    wrap.hidden = false;

    $('#page-title').textContent = record.title ?? '-';
    $('#page-title').title = record.url ?? '';

    const settings = (await api.storage.local.get('settings')).settings ?? {};
    $('#format').value = settings.format ?? 'png';
    $('#quality').value = settings.jpegQuality ?? 92;
    $('#quality-out').value = $('#quality').value;
    $('#enhance').checked = Boolean(settings.enhanceText);
    $('#enhance-level').value = settings.enhanceLevel ?? 'medium';
    $('#enhance-level-field').hidden = !settings.enhanceText;
    $('#filename').value = FS.plan.filename(settings.filenameTemplate ?? '{title} - {date}', {
      title: record.title,
      url: record.url,
      date: new Date(record.createdAt ?? Date.now()),
    });
    syncFormatFields();

    if (record.warnings?.length) {
      $('#warnings').hidden = false;
      $('#warning-list').replaceChildren(
        ...record.warnings.map((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          return li;
        })
      );
    }

    updateHistoryButtons();
    render();

    // The capture is safely decoded into `base` now, so the stored copy is
    // redundant. Dropping it keeps screenshots from piling up on disk.
    FS.store.delete(id).catch(() => {});
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  for (const button of document.querySelectorAll('.tool')) {
    button.addEventListener('click', () => selectTool(button.dataset.tool));
  }
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#crop-apply').addEventListener('click', applyCrop);
  $('#crop-cancel').addEventListener('click', cancelCrop);
  $('#save').addEventListener('click', save);
  $('#copy').addEventListener('click', copyToClipboard);
  $('#format').addEventListener('change', syncFormatFields);

  function applyEnhanceSetting() {
    const on = enhanceOn();
    $('#enhance-level-field').hidden = !on;

    if (on && FS.enhance.isExpensive(base.width, base.height)) {
      setHint('Sharpening a capture this large takes a moment...');
    }
    // Yield a frame so the hint paints before the synchronous filter runs.
    requestAnimationFrame(() => {
      render();
      setHint(on ? 'Text sharpening on.' : '');
    });
  }

  $('#enhance').addEventListener('change', applyEnhanceSetting);
  $('#enhance-level').addEventListener('change', () => {
    enhanced = { canvas: null, level: null };
    applyEnhanceSetting();
  });
  $('#quality').addEventListener('input', () => {
    $('#quality-out').value = $('#quality').value;
  });

  const SHORTCUTS = { v: 'move', c: 'crop', r: 'box', a: 'arrow', t: 'text', b: 'redact', p: 'pixelate' };
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
      return;
    }
    const next = SHORTCUTS[event.key.toLowerCase()];
    if (next) selectTool(next);
  });

  boot().catch((err) => {
    $('#loading').textContent = `Could not open this screenshot: ${err?.message ?? err}`;
  });
})();
