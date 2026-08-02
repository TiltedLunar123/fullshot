# Changelog

## 1.0.3

A sweep for bugs that produce a quietly wrong screenshot rather than an
obvious failure, plus the editor and cleanup problems found alongside them.

### Capture

- Switching tabs partway through a capture used to splice the new page into
  the middle of the old one. captureVisibleTab photographs whichever tab is
  active, not the tab that was asked for, so the second half of a long
  screenshot could be a completely different site. The capture now stops with
  an explanation instead. Two captures can no longer run at once for the same
  reason.
- Downscaled captures could come back with hairline white lines across them.
  Each slice's position and its size were rounded separately, so at some
  combinations of viewport height and scale a row of pixels belonged to
  neither of two adjacent slices. Slice edges are now rounded together.
- Picking a fixed-position panel in scrolling panel or element mode returned a
  picture of whatever was behind it. The panel was being hidden as page
  furniture, and a hidden element still occupies its layout box, so the
  capture looked plausible and was wrong. The target and its ancestors are now
  exempt from the furniture rules.
- Pages wider than the viewport could return blank right-hand columns. Only
  the vertical scroll was ever verified, so a page that refused to move
  sideways still reported success for every column.
- A panel almost entirely off screen made Fullshot appear to hang. The step
  size collapsed to a single pixel, which asked for one screenshot per pixel
  of the panel's width. It now scrolls the panel into view, and says so
  plainly when it cannot.

### Cleanup and recovery

- A capture that failed while the browser was allocating its canvas left the
  page rearranged: scrolled to the top, wearing the progress card, with sticky
  headers forced static and banners hidden. The page is now handed back
  whatever goes wrong.
- If the extension's background worker is shut down mid capture, which the
  browser may do at any time, the page hands itself back after a minute rather
  than staying rearranged until it is reloaded.
- Capturing an element or a panel no longer loses your place. The scroll
  position inside mail threads, chat panes and other inner scrollers is now
  restored along with the window's.

### Editor

- Cropping used the wrong rectangle. Releasing the mouse ended the drag but not
  the selection, so moving the pointer across the image on the way to the Apply
  button dragged the crop along with it and Apply cropped to wherever the
  cursor stopped.
- A crop drag that started at the very edge of the image could produce a crop
  of zero width and break the editor until you undid it.
- Copy failed on large screenshots. Permission to write to the clipboard
  expires a few seconds after the click that asked for it, and encoding a full
  page to PNG takes longer than that, so Copy worked on small captures and
  failed on exactly the ones this extension exists to produce.
- Reloading the editor tab no longer throws the screenshot away.
- With "open the editor after capturing" switched off, a capture went nowhere
  the user could reach. The popup now offers it.
- PDF export writes its document information as a separate object, which is
  what the PDF specification requires. Lenient readers accepted the old files;
  strict ones rejected them outright.

### Tooling

- The end-to-end suites rebuild the extension before they run. They used to
  test whatever was last built, so a change to the source could be verified by
  a suite that had never loaded it.

## 1.0.2

- Fixed: starting a full page capture while scrolled down could leave the top
  of the image blank. window.scrollTo is a request, not a guarantee, and
  nothing verified that it landed. Since slices are placed at the MEASURED
  offset, a page that ignored or undid the scroll produced an image filled
  only from where the user already was, downward. Scrolling is now verified
  and retried, and falls back to the document's scrolling element.
- Scroll anchoring is disabled during capture. It moves the page to keep
  content visually stable when something above the viewport changes size,
  which is exactly what priming lazy images does, so it could undo the return
  to the top.
- When a page genuinely refuses to scroll back to the top, the capture now
  says so instead of silently returning a screenshot missing its top.

## 1.0.1

Fixes for the three non-full-page capture modes, and for the editor shortcuts.

- Visible-area capture was drawn stretched. The stitch canvas was sized to the
  whole page and the viewport bitmap was scaled up to fill it, so on a long
  page the result was badly elongated. Capture is now modelled as a REGION,
  and the canvas is sized to that region.
- Element capture did not work. It narrowed the width to the element and
  extended the height to the element's bottom, but never applied the element's
  position, so it returned the top-left of the page instead. It now captures
  the element's own box wherever it sits.
- Scrolling panel capture now scrolls the panel and stitches its whole
  content, on both axes.
- A panel's border no longer shifts or leaks into the capture. scrollTop and
  clientHeight are padding-box metrics while getBoundingClientRect returns the
  border box; treating them as the same origin shifted every slice by the
  border width.
- Page furniture (fixed headers, footers, cookie bars) is no longer composited
  over an element or panel capture. Visible-area capture keeps it, since that
  mode is a literal photograph of the screen.
- A capture where nothing could be brought into view now reports a clear error
  instead of silently saving a blank image.
- Ctrl+C copies the screenshot. It previously matched the bare "c" crop
  shortcut, because modifiers were not checked before the tool shortcuts, so
  no Ctrl combination did what it should. Ctrl+S saves, Ctrl+Z and Ctrl+Y
  undo and redo, Enter applies a crop, and Escape cancels.
- Recoloured to crimson, with a single-hue icon gradient.
- Optional text sharpening for captures that had to be scaled down.

## 1.0.0

First release.

- Full page, visible area, single element and inner scrolling pane capture.
- Sticky elements returned to their natural document position; fixed elements
  drawn once at the edge they are docked to.
- Lazy content primed by a full-page sweep before capture, with fonts and
  images awaited under a timeout.
- Slice placement measured from the offset the page actually landed on, so
  browser scroll clamping cannot produce seams or duplicated strips.
- Grid capture, so pages wider than the viewport are handled.
- Runtime probing of the canvas limit, with automatic downscale or PDF
  pagination instead of the silent blank image an oversized canvas produces.
- Quota-adaptive capture pacing that discovers the browser's real rate limit
  and retries rather than dropping a slice.
- Scrollbar cropped out, animations paused, parallax pinned, smooth scrolling
  and scroll-snap overridden during capture.
- Optional text sharpening (unsharp mask plus a gentle contrast curve, at
  three strengths) for captures that had to be scaled down. Available as a
  default in settings and as a per-screenshot toggle in the editor. It never
  upscales.
- Editor with crop, redact, pixelate, arrow, box and text, plus undo and redo.
- Export to PNG, JPEG, WebP and multi-page PDF, and copy to clipboard.
- Warnings surfaced for cross-origin frames, mid-capture height changes and
  any downscale applied.
- Chrome and Firefox from one source tree.
- activeTab, scripting and storage only. No host permissions, no network calls.
