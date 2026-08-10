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

/**
 * The tab currently being captured, or null.
 *
 * This is deliberately ONE slot rather than a set keyed by tab. captureVisibleTab
 * photographs whichever tab is active, so two captures running at once would
 * photograph each other's pages. Refusing the second one is the only honest
 * answer.
 */
let inFlightTabId = null;

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

/**
 * Ask the page something, and give up rather than wait for ever.
 *
 * FS_PREPARE, FS_GOTO and FS_BEFORE_SHOT all await an animation frame, and a
 * minimised or fully occluded tab stops producing them. sendMessage does not
 * time out on its own, so the reply simply never arrived: the capture hung, the
 * one in-flight slot stayed taken, and every later capture was refused with "a
 * capture is already running" until the worker happened to be recycled.
 *
 * Waiting for the frame is deliberately not skipped. The frame is the proof
 * that the progress card is off screen, and photographing without it is how the
 * card ended up in people's screenshots. Failing loudly is the right answer.
 */
function tell(tabId, message, timeoutMs = 30000) {
  let timer;
  return Promise.race([
    FS.api.tabs.sendMessage(tabId, message),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PAGE_UNRESPONSIVE')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Refuse to photograph the wrong page.
 *
 * captureVisibleTab takes a picture of whatever tab is active, not of the tab
 * that was asked for. Switching tabs partway through a long capture therefore
 * used to splice the new page into the middle of the old one, silently, and a
 * screenshot that is quietly wrong is worse than one that failed.
 */
async function assertStillActive(tabId, windowId) {
  let tab;
  try {
    tab = await FS.api.tabs.get(tabId);
  } catch {
    throw new Error('The tab being captured was closed.');
  }
  if (!tab.active) throw new Error('TAB_SWITCHED');
  // `active` only means "frontmost in ITS window", and captureVisibleTab is
  // pointed at a window id fixed when the capture started. Drag the tab out
  // into a new window mid-capture and it is active there while the photographs
  // keep coming from whatever is now frontmost in the window it left, so two
  // different pages get stitched into one image.
  if (windowId != null && tab.windowId !== windowId) throw new Error('TAB_SWITCHED');
}

/**
 * Take one photograph, with the page's progress card out of the way.
 *
 * EVERY capture goes through here, and that is the point. The card is fixed to
 * the top right of the viewport, so a photograph taken while it is up paints
 * extension UI into the user's screenshot. The tiled path used to do the hiding
 * itself, which left the one-shot path below photographing the page without
 * ever asking, and on Firefox that photograph is the whole screenshot.
 *
 * The hide is deliberately not swallowed: photographing without knowing the
 * card is down is the exact failure being prevented.
 */
async function shoot(tabId, windowId, scheduler, take) {
  await assertStillActive(tabId, windowId);
  const ready = await tell(tabId, { type: 'FS_BEFORE_SHOT' });
  if (!ready?.ok) throw new Error(ready?.error || 'Lost contact with the page.');
  try {
    return await scheduler.run(take);
  } finally {
    // Put it back so the user can still see progress and reach Cancel. Cleanup
    // must never be the reason a good capture is thrown away.
    await tell(tabId, { type: 'FS_AFTER_SHOT' }).catch(() => {});
  }
}

async function captureViewport(tabId, windowId, scheduler) {
  const dataUrl = await shoot(tabId, windowId, scheduler, () =>
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
async function tryOneShot({ tabId, windowId, metrics, scale, scheduler }) {
  if (!FS.isFirefox) return null;
  const wantW = Math.round(metrics.pageWidthCss * scale);
  const wantH = Math.round(metrics.pageHeightCss * scale);

  try {
    const dataUrl = await shoot(tabId, windowId, scheduler, () =>
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

/** Drop a canvas's backing store immediately rather than waiting for the GC. */
function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 1;
    canvas.height = 1;
  } catch {
    /* already gone */
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

  // Everything from here on runs against a page the agent has already
  // rearranged, so every exit path has to hand it back. Measuring the canvas
  // budget and allocating the canvas used to sit outside this guard, which
  // meant a browser that refused the allocation left the page permanently
  // scrolled to the top, wearing our progress overlay, with its sticky header
  // forced static.
  let canvas = null;
  let fit = null;
  let sliceCount = 0;

  try {
    // Work out the output scale before allocating anything. The canvas is
    // sized to the REGION being captured, not to the page: sizing it to the
    // page and then drawing a viewport-sized bitmap into it is what stretches
    // a visible-area capture.
    const budget = await FS.canvasBudget.measure();
    const requested = settings.retina ? metrics.dpr : 1;
    fit = FS.plan.fitToBudget({
      pageWidthCss: metrics.captureWidthCss,
      pageHeightCss: metrics.captureHeightCss,
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

    canvas = new OffscreenCanvas(fit.widthPx, fit.heightPx);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser would not give Fullshot a canvas big enough for that page.');
    // White base: pages with transparent backgrounds otherwise stitch onto black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fit.widthPx, fit.heightPx);

    // The one-shot path photographs the whole document, so it only applies
    // when the whole document is what was asked for.
    const oneShot =
      mode === 'full'
        ? await tryOneShot({ tabId, windowId, metrics, scale: fit.scale, scheduler })
        : null;

    if (oneShot) {
      ctx.drawImage(oneShot, 0, 0, fit.widthPx, fit.heightPx);
      oneShot.close();
      sliceCount = 1;
    } else {
      sliceCount = await stitchByScrolling({
        tabId,
        mode,
        windowId,
        metrics,
        fit,
        ctx,
        scheduler,
        warnings,
      });
    }
  } catch (err) {
    // A full-page canvas can be hundreds of megabytes; do not wait for the
    // collector to notice that this one is never going to be used.
    releaseCanvas(canvas);
    throw err;
  } finally {
    // Always hand the page back the way we found it, even on failure.
    await tell(tabId, { type: 'FS_RESTORE' }).catch(() => {});
  }

  // Encoding is the last thing that can fail, and it fails on exactly the
  // captures where holding the canvas costs most: the encoder is out of memory
  // because the canvas is enormous. Letting it escape without releasing left
  // hundreds of megabytes pinned until the worker was recycled.
  let blob;
  try {
    blob = await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    // Free the backing store now; a full-page canvas can be hundreds of MB.
    releaseCanvas(canvas);
  }

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

async function stitchByScrolling({ tabId, mode, windowId, metrics, fit, ctx, scheduler, warnings }) {
  // Tiles are positions in OUTPUT space, covering the region being captured in
  // steps of whatever the agent said it can show at once. The agent translates
  // each position into the right kind of scrolling for the mode.
  const tiles = FS.plan.tiles({
    pageWidthCss: metrics.captureWidthCss,
    pageHeightCss: metrics.captureHeightCss,
    viewWidthCss: metrics.stepWidthCss,
    viewHeightCss: metrics.stepHeightCss,
  });

  const rowYs = [...new Set(tiles.map((t) => t.y))];
  let drawn = 0;
  let heightChanged = false;

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

    // A full-page capture of something that grows or shrinks mid-run (an
    // infinite feed, or a virtualised list recycling rows) cannot be stitched
    // coherently. Say so rather than emitting a subtly wrong image. Other
    // modes are bounded by an element or the viewport, so page height moving
    // underneath them is not a problem.
    if (
      mode === 'full' &&
      landed.pageHeightCss &&
      Math.abs(landed.pageHeightCss - metrics.pageHeightCss) > 4
    ) {
      // Once, however many times the page moves. A feed that grows on every
      // scroll trips this on every tile, and thirty identical bullets in the
      // editor say nothing the first one did not.
      if (!heightChanged) {
        heightChanged = true;
        warnings.push(
          'The page changed height while it was being captured, so part of the image may repeat or be missing. Pages that load more content as you scroll are hard to capture completely.'
        );
      }
      metrics.pageHeightCss = landed.pageHeightCss;
    }

    // The region is simply not present in this slice; that is expected for any
    // region smaller than the viewport.
    if (landed.skip) continue;

    const bitmap = await captureViewport(tabId, windowId, scheduler);

    const place = FS.plan.placeClip({
      outXCss: landed.outX,
      outYCss: landed.outY,
      clip: landed.clip,
      viewWidthCss: metrics.viewWidthCss,
      viewHeightCss: metrics.viewHeightCss,
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

  // Every slice was skipped or fell outside the canvas, so the image would be
  // blank. That is a failure, not a screenshot, and saying so beats handing
  // back an empty picture.
  if (drawn === 0) {
    throw new Error(
      'Fullshot could not bring that target into view, so there was nothing to capture. If it sits inside a scrolling panel, try the scrolling panel mode instead.'
    );
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
  // Everything is inside the try, including working out which tab this is.
  //
  // Those first few calls used to sit outside it, so anything they threw came
  // straight back out of start() as a rejected promise. The message listener
  // has already answered `true` by then, promising a reply that now never
  // arrives: the popup sits on "Working..." for as long as it is open, with no
  // error, and the worker logs an unhandled rejection nobody sees.
  let tab = null;
  let claimed = false;

  try {
    tab =
      explicitTabId != null
        ? await FS.api.tabs.get(explicitTabId)
        : (await FS.api.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab) return { ok: false, error: 'No active tab.' };

    // Only ask the browser about file access when the answer can change the
    // outcome. It is a round trip, and no ordinary page has any use for it.
    const fileAccess = FS.isFileUrl(tab.url) && (await FS.canAccessFiles());
    const restriction = FS.restrictionFor(tab.url, fileAccess);
    if (restriction) return { ok: false, error: restriction };

    if (inFlightTabId !== null) {
      return {
        ok: false,
        error:
          inFlightTabId === tab.id
            ? 'A capture is already running on this tab.'
            : 'A capture is already running on another tab. Screenshots have to be taken one at a time.',
      };
    }
    inFlightTabId = tab.id;
    claimed = true;
    await setBadge(tab.id, '...');

    const settings = await FS.settings.get();
    const result = await runCapture({
      tabId: tab.id,
      windowId: tab.windowId,
      mode,
      settings,
    });

    // Housekeeping must never be the reason a finished capture is thrown away.
    await FS.store.prune().catch(() => {});
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
    } else {
      // Nothing opened, so nothing on screen says this worked. Leave a note the
      // popup can pick up, otherwise a capture taken with the keyboard shortcut
      // and the editor switched off is indistinguishable from one that failed.
      await FS.api.storage.local.set({ pendingCapture: { id, at: Date.now() } }).catch(() => {});
    }
    return { ok: true, id, editorOpened: Boolean(settings.openEditor), warnings: result.warnings };
  } catch (err) {
    const message = String(err?.message ?? err);
    if (message === 'CANCELLED') return { ok: false, cancelled: true };
    return { ok: false, error: friendlyError(message) };
  } finally {
    // Only if this call is the one that took the slot. The early returns above
    // include "a capture is already running", and releasing another capture's
    // slot from here would let a second one start on top of it.
    if (claimed) {
      inFlightTabId = null;
      await setBadge(tab.id, '');
    }
  }
}

function friendlyError(message) {
  if (message === 'TAB_SWITCHED') {
    return 'The tab changed while the screenshot was being taken, so it was stopped before it could photograph the wrong page. Leave the tab in front until it finishes.';
  }
  if (/Cannot access|Missing host permission|Extension manifest/i.test(message)) {
    return 'Fullshot needs permission for this tab. Click the toolbar button on the page you want to capture.';
  }
  if (message === 'PAGE_UNRESPONSIVE') {
    return 'The page stopped responding, which usually means the window was minimised or hidden behind another one. Leave the tab on screen while the screenshot is taken.';
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
    // A listener that has answered `true` owes a reply. Anything unforeseen
    // between here and sendResponse leaves the popup waiting for one that
    // never comes, so the catch answers rather than letting it fall through.
    start(msg.mode)
      .catch((err) => ({ ok: false, error: friendlyError(String(err?.message ?? err)) }))
      .then(async (result) => {
        sendResponse(result);
        // The element and panel pickers need a click on the page, and that
        // click closes the popup, so by the time this resolves there is usually
        // nothing left to receive the answer. Those two modes therefore failed
        // in total silence. Leave the message where the next popup will find it.
        if (!result?.ok && !result?.cancelled && (msg.mode === 'element' || msg.mode === 'area')) {
          const [tab] = await FS.api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
          await reportSilentFailure(tab?.id, result.error);
        }
      });
    return true; // async response
  }
  if (msg?.type === 'FS_PROGRESS_PING') {
    setBadge(msg.tabId, msg.text ?? '');
    return false;
  }
  return false;
});

/**
 * Report a failure that has nowhere to be displayed.
 *
 * A capture started from the keyboard has no popup listening, and the element
 * and panel pickers close the popup the moment the user clicks the page, so
 * their failures had no audience either. Both used to end in silence: the badge
 * cleared and nothing else happened, which is indistinguishable from the
 * shortcut not being bound at all.
 *
 * The badge carries the alarm and the message waits for the next popup, which
 * is the only surface an extension without notifications has.
 */
async function reportSilentFailure(tabId, message) {
  if (!message) return;
  try {
    await FS.api.storage.local.set({ lastError: { message, at: Date.now() } });
  } catch {
    /* storage is best effort here */
  }
  try {
    await FS.api.action.setBadgeText({ tabId, text: '!' });
    await FS.api.action.setBadgeBackgroundColor({ tabId, color: '#b91c1c' });
  } catch {
    /* badge is decorative */
  }
}

FS.api.commands?.onCommand.addListener(async (command) => {
  if (command !== 'capture-full-page' && command !== 'capture-visible') return;
  const mode = command === 'capture-full-page' ? 'full' : 'visible';
  // A shortcut has no popup listening, so an error thrown here would be seen
  // by nobody at all. Turn it into the badge and the parked message instead.
  const result = await start(mode).catch((err) => ({
    ok: false,
    error: friendlyError(String(err?.message ?? err)),
  }));
  if (!result?.ok && !result?.cancelled) {
    const [tab] = await FS.api.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    await reportSilentFailure(tab?.id, result?.error);
  }
});

/**
 * Bound the store by age even if the extension is never used again.
 *
 * prune() otherwise only ran off the back of a finished capture or an editor
 * tab opening, so one screenshot taken and never looked at again sat in
 * IndexedDB indefinitely, which is not what the privacy policy's one-day
 * promise says. Both of these events are free: an alarm would need the
 * `alarms` permission, and the permission set is the product.
 */
function pruneQuietly() {
  FS.store.prune().catch(() => {});
}
FS.api.runtime.onStartup?.addListener(pruneQuietly);
FS.api.runtime.onInstalled?.addListener(pruneQuietly);

/**
 * Exposed so the end-to-end harness can drive a capture directly.
 *
 * Only extension contexts can reach the FS namespace, so this grants a web page
 * nothing it did not already have through the normal message listener above.
 */
FS.startCapture = start;
