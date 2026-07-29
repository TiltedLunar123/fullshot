# Changelog

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
