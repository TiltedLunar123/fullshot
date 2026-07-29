/**
 * Fullshot orchestrator.
 *
 * Runs in the Chrome MV3 service worker and in the Firefox MV3 event page. Both
 * support OffscreenCanvas and createImageBitmap, so the stitch happens right
 * here and neither the Chrome-only `offscreen` API nor a visible worker tab is
 * needed.
 *
 * The target tab must stay focused for the whole capture, because
 * captureVisibleTab photographs whatever tab is active. That is why progress is
 * drawn as an in-page overlay instead of in an extension tab.
 */

/** Guards against two captures racing over the same tab's scroll position. */
const inFlight = new Map();

/* ------------------------------------------------------------------ */
/* Binary helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Decode a data URL without fetch().
 *
 * fetch() would work here, but a screenshot extension that contains no network
 * primitive at all is a much easier promise to verify, and the build gate
 * enforces it.
 */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('malformed capture data');
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = /:(.*?)[;,]/.exec(header)?.[1] ?? 'image/png';

  if (!/;base64/i.test(header)) {
    return new Blob([decodeURIComponent(body)], { type: mime });
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ------------------------------------------------------------------ */
/* Tab messaging                                                       */
/* ------------------------------------------------------------------ */

async function ensureAgent(tabId) {
  // executeScript is idempotent from our side: the agent no-ops if already
  // present. Re-injecting also recovers from a page that navigated.
  await FS.api.scripting.executeScript({
    target: { tabId },
    files: ['content/agent.js'],
  });
}

function tell(tabId, message) {
  return FS.api.tabs.sendMessage(tabId, message);
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

async function captureViewport(windowId, scheduler) {
  const dataUrl = await scheduler.run(() =>
    FS.api.tabs.captureVisibleTab(windowId, { format: 'png' })
  );
  if (!dataUrl) throw new Error('The browser returned an empty capture.');
  const blob = dataUrlToBlob(dataUrl);
  return createImageBitmap(blob);
}

/**
 * Try Firefox's one-shot path: captureVisibleTab with an ImageDetails rect
 * covering the whole document.
 *
 * MDN documents `rect` as page-relative CSS pixels, which implies it can reach
 * past the viewport, but that it works for a full-height rect is NOT documented
 * and is not assumed here. The returned bitmap is measured against what was
 * asked for, and anything short falls through to scroll-and-stitch. A wrong
 * guess therefore costs one capture, never a broken screenshot.
 */
async function tryOneShot({ windowId, metrics, scale, scheduler }) {
  if (!FS.isFirefox) return null;
  const wantW = Math.round(metrics.pageWidthCss * scale);
  const wantH = Math.round(metrics.pageHeightCss * scale);

  try {
    const dataUrl = await scheduler.run(() =>
      FS.api.tabs.captureVisibleTab(windowId, {
        format: 'png',
        rect: {
          x: 0,
          y: 0,
          width: metrics.pageWidthCss,
          height: metrics.pageHeightCss,
        },
        scale,
      })
    );
    if (!dataUrl) return null;
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));

    // Accept only if the engine really honoured the rect. Allow a couple of
    // pixels of rounding, but reject a viewport-sized image outright.
    const tallEnough = bitmap.height >= Math.min(wantH, wantH - 2);
    const wideEnough = bitmap.width >= Math.min(wantW, wantW - 2);
    if (tallEnough && wideEnough) return bitmap;

    bitmap.close();
    return null;
  } catch {
    return null;
  }
}

async function runCapture({ tabId, windowId, mode, settings }) {
  const scheduler = new FS.CaptureScheduler();
  const warnings = [];

  await ensureAgent(tabId);

  const prep = await tell(tabId, { type: 'FS_PREPARE', mode, settings });
  if (!prep?.ok) throw new Error(prep?.error || 'Fullshot could not read this page.');
  const metrics = prep.metrics;
  warnings.push(...(metrics.warnings ?? []));

  // Work out the output scale before allocating anything.
  const budget = await FS.canvasBudget.measure();
  const requested = settings.retina ? metrics.dpr : 1;
  const fit = FS.plan.fitToBudget({
    pageWidthCss: metrics.pageWidthCss,
    pageHeightCss: metrics.pageHeightCss,
    scale: requested,
    maxArea: budget.maxArea,
    maxDimension: budget.maxDimension,
  });
  if (fit.downscaled) {
    warnings.push(
      `This page is larger than your browser's maximum image size, so it was scaled to ${Math.round(
        fit.scale * 100
      )}% to fit. Export as PDF for full resolution.`
    );
  }

  const canvas = new OffscreenCanvas(fit.widthPx, fit.heightPx);
  const ctx = canvas.getContext('2d');
  // White base: pages with transparent backgrounds otherwise stitch onto black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, fit.widthPx, fit.heightPx);

  let sliceCount = 0;

  try {
    if (mode === 'visible') {
      const bitmap = await captureViewport(windowId, scheduler);
      ctx.drawImage(bitmap, 0, 0, fit.widthPx, fit.heightPx);
      bitmap.close();
      sliceCount = 1;
    } else {
      const oneShot = await tryOneShot({ windowId, metrics, scale: fit.scale, scheduler });
      if (oneShot) {
        ctx.drawImage(oneShot, 0, 0, fit.widthPx, fit.heightPx);
        oneShot.close();
        sliceCount = 1;
      } else {
        sliceCount = await stitchByScrolling({
          tabId,
          windowId,
          metrics,
          fit,
          ctx,
          scheduler,
          warnings,
        });
      }
    }
  } finally {
    // Always hand the page back the way we found it, even on failure.
    await tell(tabId, { type: 'FS_RESTORE' }).catch(() => {});
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  // Free the backing store now; a full-page canvas can be hundreds of MB.
  canvas.width = 1;
  canvas.height = 1;

  return {
    blob,
    width: fit.widthPx,
    height: fit.heightPx,
    scale: fit.scale,
    sliceCount,
    warnings,
    schedulerStats: scheduler.stats(),
    title: metrics.title,
    url: metrics.url,
  };
}

async function stitchByScrolling({ tabId, windowId, metrics, fit, ctx, scheduler, warnings }) {
  const tiles = FS.plan.tiles({
    pageWidthCss: metrics.pageWidthCss,
    pageHeightCss: metrics.pageHeightCss,
    viewWidthCss: metrics.viewWidthCss,
    viewHeightCss: metrics.viewHeightCss,
  });

  const rowYs = [...new Set(tiles.map((t) => t.y))];
  let drawn = 0;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const rowIndex = rowYs.indexOf(tile.y);

    const landed = await tell(tabId, {
      type: 'FS_GOTO',
      x: tile.x,
      y: tile.y,
      rowIndex,
      rowCount: rowYs.length,
      index: i,
      total: tiles.length,
    });
    if (landed?.cancelled) throw new Error('CANCELLED');
    if (!landed?.ok) throw new Error(landed?.error || 'Lost contact with the page.');

    // A page that grows or shrinks mid-capture (an infinite feed, or a
    // virtualised list recycling rows) cannot be stitched coherently. Say so
    // rather than emitting a subtly wrong image.
    if (landed.pageHeightCss && Math.abs(landed.pageHeightCss - metrics.pageHeightCss) > 4) {
      warnings.push(
        'The page changed height while it was being captured, so part of the image may repeat or be missing. Pages that load more content as you scroll are hard to capture completely.'
      );
      metrics.pageHeightCss = landed.pageHeightCss;
    }

    const bitmap = await captureViewport(windowId, scheduler);
    await tell(tabId, { type: 'FS_AFTER_SHOT' }).catch(() => {});

    const place = FS.plan.placement({
      landedXCss: landed.landedX,
      landedYCss: landed.landedY,
      viewWidthCss: metrics.viewWidthCss,
      viewHeightCss: metrics.viewHeightCss,
      scrollbarWidthCss: metrics.scrollbarWidthCss,
      scrollbarHeightCss: metrics.scrollbarHeightCss,
      bitmapWidthPx: bitmap.width,
      bitmapHeightPx: bitmap.height,
      scale: fit.scale,
      canvasWidthPx: fit.widthPx,
      canvasHeightPx: fit.heightPx,
    });

    if (place) {
      ctx.drawImage(
        bitmap,
        place.srcX,
        place.srcY,
        place.srcW,
        place.srcH,
        place.destX,
        place.destY,
        place.destW,
        place.destH
      );
      drawn++;
    }
    bitmap.close();
  }

  return drawn;
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

async function setBadge(tabId, text) {
  try {
    await FS.api.action.setBadgeText({ tabId, text });
    if (text) await FS.api.action.setBadgeBackgroundColor({ tabId, color: '#e11d48' });
  } catch {
    /* badge is decorative; never fail a capture over it */
  }
}

/**
 * @param mode one of full | visible | element | area
 * @param explicitTabId target a specific tab instead of the active one. Used by
 *   the end-to-end harness, which cannot rely on which tab the browser
 *   considers active.
 */
async function start(mode, explicitTabId) {
  const tab =
    explicitTabId != null
      ? await FS.api.tabs.get(explicitTabId)
      : (await FS.api.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return { ok: false, error: 'No active tab.' };

  const restriction = FS.restrictionFor(tab.url);
  if (restriction) return { ok: false, error: restriction };

  if (inFlight.has(tab.id)) return { ok: false, error: 'A capture is already running on this tab.' };
  inFlight.set(tab.id, true);
  await setBadge(tab.id, '...');

  try {
    const settings = await FS.settings.get();
    const result = await runCapture({
      tabId: tab.id,
      windowId: tab.windowId,
      mode,
      settings,
    });

    await FS.store.prune();
    const id = FS.store.newId();
    await FS.store.put({
      id,
      createdAt: Date.now(),
      blob: result.blob,
      width: result.width,
      height: result.height,
      title: result.title,
      url: result.url,
      warnings: result.warnings,
      sliceCount: result.sliceCount,
      scale: result.scale,
    });

    if (settings.openEditor) {
      await FS.api.tabs.create({
        url: FS.api.runtime.getURL(`editor/editor.html?id=${encodeURIComponent(id)}`),
      });
    }
    return { ok: true, id, warnings: result.warnings };
  } catch (err) {
    const message = String(err?.message ?? err);
    if (message === 'CANCELLED') return { ok: false, cancelled: true };
    return { ok: false, error: friendlyError(message) };
  } finally {
    inFlight.delete(tab.id);
    await setBadge(tab.id, '');
  }
}

function friendlyError(message) {
  if (/Cannot access|Missing host permission|Extension manifest/i.test(message)) {
    return 'Fullshot needs permission for this tab. Click the toolbar button on the page you want to capture.';
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
    return 'The page reloaded during capture. Try again once it has finished loading.';
  }
  if (/exceeds|quota/i.test(message)) {
    return 'The browser limited how fast screenshots can be taken. Try again in a moment.';
  }
  return message;
}

FS.api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'FS_START') {
    start(msg.mode).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'FS_PROGRESS_PING') {
    setBadge(msg.tabId, msg.text ?? '');
    return false;
  }
  return false;
});

FS.api.commands?.onCommand.addListener((command) => {
  if (command === 'capture-full-page') start('full');
  if (command === 'capture-visible') start('visible');
});

/**
 * Exposed so the end-to-end harness can drive a capture directly.
 *
 * Only extension contexts can reach the FS namespace, so this grants a web page
 * nothing it did not already have through the normal message listener above.
 */
FS.startCapture = start;
