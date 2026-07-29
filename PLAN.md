# Fullshot - architecture and build plan

A full-page screenshot extension for Chrome (MV3) and Firefox (MV3), built to be
correct on the pages where scroll-and-stitch capture normally falls apart.

This plan merges an independent research pass (Grok 4.5, web-sourced) with my own
verification against primary docs. Where the two disagreed, the verified doc wins and
the disagreement is recorded below.

---

## 1. Why build this

Scroll-and-stitch full-page capture is easy to make work on a simple article page and
hard to make work on the modern web. The recurring, reproducible failure modes are:

| # | Symptom | Cause |
|---|---------|-------|
| 1 | Sticky nav / cookie bar / chat widget stamped once per viewport | Every slice re-captures `position: fixed` and `position: sticky` chrome |
| 2 | Blank or half-loaded bands mid-image | Lazy images and IntersectionObserver content never painted before capture |
| 3 | Seams, white lines, duplicated strips | Scroll offset assumed rather than measured; DPR vs CSS-pixel math |
| 4 | Only the viewport captured | Wrong scroll root, or `scroll-behavior: smooth` fighting programmatic scroll |
| 5 | Broken on app UIs (mail, chat, dashboards) | Real content lives in an inner `overflow: auto` pane, not the document |
| 6 | Slow capture | `captureVisibleTab` is quota-limited; conservative fixed delays over-pay |
| 7 | Very long pages produce a blank or truncated image | Canvas max-area exceeded; canvas fails silently rather than throwing |
| 8 | Scrollbar baked into the image | Captured bitmap includes the scrollbar gutter |
| 9 | Parallax backgrounds smeared | `background-attachment: fixed` shifts per slice |

Items 1-9 are all engineering-fixable. That is the whole thesis: **correctness on hard
pages**, plus the editor and PDF export given away for free, plus a real Firefox build.

---

## 2. Verified platform facts

Everything load-bearing was checked against primary documentation, not assumed.

| Fact | Status | Source |
|---|---|---|
| `tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` is **2** | Verified | Chrome tabs API reference |
| `captureVisibleTab` requires `<all_urls>` **or** `activeTab` | Verified | Chrome tabs API reference |
| Firefox `captureVisibleTab` accepts `activeTab` from **Firefox 126**; `<all_urls>` only in 125 and earlier | Verified | MDN `tabs.captureVisibleTab` |
| Firefox `tabs.captureTab` requires **`<all_urls>`** | Verified | MDN `tabs.captureTab` |
| `ImageDetails.rect` is `{x,y,width,height}` in **CSS pixels relative to the page**, added Firefox 82 | Verified | MDN `extensionTypes.ImageDetails` |
| `ImageDetails.scale` defaults to `devicePixelRatio`, added Firefox 82 | Verified | MDN `extensionTypes.ImageDetails` |
| A `commands` keyboard shortcut **does** grant `activeTab` | Verified | Chrome activeTab concept doc |
| activeTab is revoked on navigation away from the origin / tab close | Verified | Chrome activeTab concept doc |
| A single `rect` capture works for arbitrary page height | **Unverified** | Treated as a runtime probe, never assumed |
| Exact max canvas area per browser | **Unverified / device-dependent** | Probed at runtime, never hardcoded |

### Where I overrode the research draft

1. **Firefox fast path.** The draft proposed `tabs.captureTab` + `rect` as the Firefox
   fast path. That API requires `<all_urls>`, which contradicts the draft's own
   (correct) advice to ship `activeTab` only. Fullshot instead calls
   `captureVisibleTab` with a `rect`, which is `activeTab`-compatible on Firefox 126+,
   and **verifies the returned bitmap height** before trusting it. If the browser
   ignores `rect` and returns a viewport-sized image, we fall through to scroll-and-stitch.
   No claim about `rect` is trusted without measuring the result.

2. **Where stitching runs.** The draft suggested doing the work in a visible extension
   tab to dodge the MV3 service-worker idle timeout. That breaks capture:
   `captureVisibleTab` grabs whatever tab is *active*, so focusing an extension tab
   would capture the extension tab. Fullshot keeps the target tab focused, stitches in
   the background context using `OffscreenCanvas`, and keeps the worker alive with a
   long-lived port plus per-slice message traffic. Progress is shown as an in-page
   overlay that is hidden for the duration of each capture call.

3. **No `offscreen` permission.** `OffscreenCanvas` and `createImageBitmap` are
   available directly in a Chrome MV3 service worker and in a Firefox MV3 event page,
   so the Chrome-only `offscreen` document API is unnecessary. One less permission and
   one less code path.

4. **No `downloads` permission.** The editor is a normal extension page, so saving is
   an `<a download>` against a blob URL. Zero permission cost.

5. **Editor ships in v1.** The draft deferred crop/redact/annotate to v1.x. Since the
   dominant paid competitor paywalls exactly those, shipping them free in v1 is the
   point, not a stretch goal.

---

## 3. Permissions

```
"permissions": ["activeTab", "scripting", "storage"]
```

No `host_permissions`. No `<all_urls>`. No `tabs`. No `downloads`. No `offscreen`.
No remote code, no network calls of any kind, no analytics, no accounts, no paid tier.

`tools/build.mjs --check` fails the build if a broad host permission or an
unexpected permission ever appears in either manifest. The permission set is a
product feature, so it is enforced mechanically rather than by good intentions.

---

## 4. Architecture

```
action click / keyboard shortcut
        |
        v
background (Chrome: service worker | Firefox: event page)
  - validates the tab is capturable
  - injects the content agent via scripting.executeScript (activeTab)
  - owns the capture scheduler (quota-adaptive)
  - owns the stitch OffscreenCanvas
  - writes the finished blob to IndexedDB, opens the editor
        |
        | long-lived port, one message per slice
        v
content agent (injected, isolated world)
  - prepares the page (lazy priming, motion freeze, scroll hardening)
  - applies the floating-element policy
  - measures true geometry
  - scrolls, settles, reports the ACTUAL landed offset
  - draws the progress overlay, hides it during each capture
  - restores every mutation when done or cancelled
        |
        v
editor tab  <- reads the blob from IndexedDB
  - preview, crop, redact, annotate
  - export PNG / JPEG / WebP / PDF, copy to clipboard
```

Slices are drawn into the stitch canvas as they arrive and the source bitmap is closed
immediately, so peak memory is one bitmap plus the destination canvas rather than N
bitmaps.

### Module loading

Shared library files are plain classic scripts that attach to a `FS` global, and
`tools/build.mjs` concatenates them into a single `background.js`. This sidesteps the
question of ES-module support in a Firefox MV3 background script entirely: Chrome gets
`"service_worker": "background.js"`, Firefox gets `"scripts": ["background.js"]`, and
neither needs `"type": "module"`.

---

## 5. Capture mechanics

### 5.1 Page preparation, in order

1. Override `scroll-behavior: auto !important` and `scroll-snap-type: none !important`
   so programmatic scrolling lands exactly where it is told.
2. Freeze motion: pause CSS animations and disable transitions, so nothing tears
   between slices. Force `background-attachment: scroll` to stop parallax smearing.
3. Prime lazy content: promote `loading="lazy"` to `eager` on images and iframes, then
   sweep the full page in viewport-sized steps so IntersectionObserver fires.
4. Settle: await `document.fonts.ready` and every in-viewport image's `decode()`,
   under a hard timeout so a broken asset cannot hang the capture.
5. Return to the top and **re-measure**, because priming usually changes page height.

### 5.2 Floating-element policy

Sticky and fixed elements are handled differently because they mean different things.

- **`position: sticky` becomes `position: static`.** A sticky header's correct
  appearance in a full-page image is once, in its natural document position. Sticky
  elements already occupy normal flow space, so this does not change page height.
- **`position: fixed` is shown once and hidden otherwise.** Each fixed element is
  classified as top-docked or bottom-docked by comparing its rect to the viewport
  midpoint. Top-docked elements are visible only on the first row, bottom-docked only
  on the last row. Hiding uses `visibility: hidden`, never `display: none`, so no
  reflow is triggered.

The policy is user-selectable: **once** (default), **never**, or **keep**.

### 5.3 Scroll and stitch

- Tile the page as a grid, not a column, so pages wider than the viewport work too.
- After every scroll, **read `scrollX`/`scrollY` back** and place the slice at the
  offset the page actually landed on. The final row and column are clamped by the
  browser and therefore overlap the previous one; placing by measured offset makes
  that overlap self-correcting instead of a seam.
- Derive the device-pixel scale empirically as `bitmap.width / viewportCssWidth`
  rather than trusting `devicePixelRatio`, which drifts under browser zoom.
- Crop the scrollbar gutter using `innerWidth - documentElement.clientWidth` (and the
  horizontal equivalent) so no scrollbar is baked into the output.
- Re-measure `scrollHeight` between slices. If the page height moves mid-capture (an
  infinite feed, or a virtualized list recycling rows), stop and tell the user plainly
  rather than emitting a silently corrupt image.

### 5.4 Quota-adaptive scheduling

The documented ceiling is 2 calls/second, but it is not identical across browsers and
versions. A fixed conservative delay over-pays on every page.

The scheduler starts at a 500 ms interval and adapts: four consecutive successes
shrink the interval by 15% (floor 220 ms); a quota rejection grows it by 60% (ceiling
1200 ms) and **retries the same slice**, so adaptation never loses data. On a browser
that enforces the limit loosely this converges downward on its own.

### 5.5 Canvas limits

Maximum canvas area is device- and GPU-dependent, so it is probed at runtime rather
than hardcoded: allocate a candidate `OffscreenCanvas`, write a pixel, read it back,
and step down through candidates until one round-trips. The result is cached.

This matters because an oversized canvas in Chrome does not throw. It silently stops
accepting draws, which is exactly how a competitor produces a blank image on a very
long page. When the target exceeds the probed budget, Fullshot downscales to fit and
says so, or exports as a multi-page PDF where no single huge canvas is ever needed.

### 5.6 Capture modes

| Mode | Behaviour |
|---|---|
| Full page | The whole document, tiled grid |
| Visible | One capture of the current viewport |
| Element | Hover-to-highlight picker; captures one element, stitching if it is taller than the viewport |
| Scrolling area | Picker resolves the nearest scrollable ancestor and drives `el.scrollTop`, for inner panes in app UIs |

---

## 6. Export

- **PNG** (lossless), **JPEG**, **WebP** via canvas encoding.
- **PDF**, written by hand in `src/lib/pdf.js` with no dependency. JPEG bytes embed
  directly into a PDF as an XObject with `/Filter /DCTDecode`, so a valid multi-page
  PDF is a few hundred lines of byte assembly: header, catalog, page tree, one image
  XObject and content stream per page, xref table with correct offsets, trailer.
  Long images are paginated so a very tall capture becomes N sensible pages, and no
  single oversized canvas is ever required.
- **Copy to clipboard** as a PNG blob.
- Filename template with page title and date, free.

---

## 7. Editor

Deliberately small: preview with fit/actual zoom, crop, redact (solid or pixelate),
arrow, box, and text annotation, then export. The goal is to cover what people
actually need after a screenshot without opening a design surface that never closes.

---

## 8. Honest failure reporting

Some things cannot be captured, and pretending otherwise is how a screenshot tool
loses trust. Fullshot collects warnings during capture and shows them in the editor:
cross-origin iframes that could not be primed, DRM-protected video that renders black,
page height that changed mid-capture, and any downscale applied to fit canvas limits.

Restricted URLs (`chrome://`, `about:`, the extension galleries, the PDF viewer)
produce a clear explanation instead of a silent failure.

---

## 9. Testing

- Unit tests (Node, no framework) for stitch geometry, tile planning, canvas-budget
  fitting, filename templating, and PDF byte structure.
- `test-pages/torture.html`: a deliberately hostile fixture with a sticky header, a
  fixed footer, a fixed cookie banner, lazy images, `scroll-behavior: smooth`,
  scroll-snap, a parallax background, an inner scrolling pane, and a wide element.
- A real-browser check that loads the built extension and captures the torture page.
- `tools/build.mjs --check` gates the permission set, manifest validity, and icons.

---

## 10. Scope

**v1.0**: everything above.

**Deferred**: same-origin iframe recursion, multi-tab batch capture, per-site saved
profiles, OCR / selectable-text PDF.

**Explicitly rejected**: cloud upload or share links (kills the privacy claim), the
`debugger` permission (scary, and a review risk), DOM-clone rendering approaches
(breaks on cross-origin CSS, shadow DOM, canvas and video), and any paid tier.
