# Changelog

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
