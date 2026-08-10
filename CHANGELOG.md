# Changelog

## 1.2.0

Includes 1.1.1 below, which was never published.

- Picking an element that sits inside a scrolling panel, a message in a mail
  thread or a card in a chat window, gave a picture that was part element and
  part something else entirely. A panel only shows a window onto its contents,
  and the rest of the element is not drawn anywhere on the page. The capture
  went on walking the element's full height down the document regardless and
  photographed whatever happened to be at those coordinates, which on a long
  element was mostly the page behind the panel. It now captures the part the
  panel actually shows, and says so.
- A screenshot that failed while nothing was on screen to say so, one started
  from the keyboard, left a red mark on the toolbar button. Opening the popup
  showed the message and deleted it, but the mark stayed, so from then on the
  button claimed something had gone wrong and there was nothing left anywhere
  to explain what. It was being cleared for the browser as a whole while it had
  been set against one tab, and a mark set on a tab wins.
- A capture that failed before it had properly started left the popup saying
  "Working..." for as long as it was open, with no error and nothing happening.
- The popup listed keyboard shortcuts it had no way of knowing were real. A
  browser only takes the suggested key if it is free, another extension can
  already hold it, and you can change or clear it yourself, none of which the
  popup could see. It now shows the key the browser actually bound, and says
  where to set one when there is none.
- The line at the bottom of the editor's panel, the one about nothing being
  uploaded anywhere, could not be seen without scrolling the panel: on a
  smaller screen the export controls fill it on their own. The panel's contents
  scroll on their own now and that line stays put.
- Undo and Redo looked available on a screenshot that had expired, and did
  nothing when pressed.
- Running out of memory while writing the finished image kept the whole thing
  in memory afterwards, on exactly the captures where that costs most.
- Screen readers now get told which editing tool is selected, and read out what
  the editor says after saving or copying. Both were colour and position only.
- The settings page kept its own copy of every default rather than reading the
  real ones. They agreed, but only by luck, and that is how the popup's private
  copy of the blocked-page list came to be missing local files in 1.1.0.

## 1.1.1

- Local files could not be captured at all, even with file access already
  switched on for Fullshot. The check refused every file:// address on sight
  instead of asking the browser whether access had been granted, so ticking
  "Allow access to file URLs" achieved nothing and the message telling you to
  tick it never went away. It now asks, and a local file captures like any
  other page.
- On Firefox that message was wrong in a second way. Firefox has no such
  setting: reaching local files there needs access to every file on your
  computer, which Fullshot does not ask for and will not. It now says that,
  rather than sending people to hunt for a switch their browser does not have.
- The popup kept a second, separate list of pages it cannot capture, and the
  two had drifted: local files were missing from the popup's copy entirely.
  Both now come from one place.

## 1.1.0

A bug sweep. Most of what follows is the same shape of fault: a capture that
came back the right size, looking entirely plausible, showing the wrong thing.

- Picking an element pinned to the window, a cookie banner, a docked footer, a
  chat widget, gave a picture of the page behind it instead. A fixed element has
  no position in the document, but its on-screen rectangle was being treated as
  one, so the page was scrolled to a row the element was not on. The element did
  not move, because that is what fixed means, and whatever was now at that spot
  was photographed instead.
- A page laid out right to left came out with its columns in the wrong order.
  Such a page scrolls from a negative offset up to zero rather than from zero
  upwards, so tiling from zero asked for positions that do not exist and every
  column after the first landed in the same place.
- A scrolling panel taller than the window lost the bottom of its content. Once
  the panel has been scrolled as far as it goes, the end of the content is
  sitting below the bottom of the screen, and no further scrolling of the panel
  can bring it up. The window is now moved to fetch the rest.
- Dragging the tab into another window mid-capture spliced two different pages
  into one image. The guard checked that the tab was still frontmost, which
  stays true in its new window, but the photographs kept coming from the window
  it had left.
- On Firefox, the sticky headers and floating bars setting did nothing at all.
  Firefox can photograph a whole page in one shot, and that path never ran the
  step that applies the setting. "Hide completely" hid nothing.
- Exporting as PDF could produce a file some readers reject. A long page title
  was cut to length after its parentheses had been escaped, which can slice an
  escape in half and leave a stray backslash that swallows the rest of the
  document information.
- Captures on an ordinary desktop warned that the page was larger than the
  browser's maximum image size when it was nothing of the sort. The scale is
  rounded down to a hundredth so the canvas cannot come out over budget, and
  that rounding was being reported as though a limit had been hit. A Windows
  display at 150% with the browser at 75% was enough to trigger it.

Things that got stuck rather than got it wrong:

- A page with its own click handler could leave the element picker running for
  ever, and every capture after that was refused with "a capture is already
  running". The picker now gives up.
- The same thing happened whenever the window was minimised or completely
  covered: the page stops drawing frames, and the extension was waiting for one
  that would never come. It now says so instead.
- Starting a capture while a previous one was still live took the page over
  without handing it back first, stranding the old progress card and stylesheet
  on it. A browser is free to shut the extension down mid-capture, so this was
  ordinary rather than exotic.

Failures that happened in silence now say something:

- Captures started with the keyboard reported nothing whatsoever when they
  failed. Neither did the element and panel pickers, because clicking the page
  to choose a target closes the popup that was waiting for the answer. Both now
  raise a red badge and leave the reason for the next time the popup opens.
- The page-height warning was added once per section, so a page that keeps
  loading as you scroll filled the editor with the same sentence thirty times.

In the editor:

- Pressing Escape mid-drag committed an invisible shape and threw away the redo
  history, because the shape took its type from whichever tool was selected when
  the button came up rather than when it went down.
- Cropping a second time could bring back content the first crop had removed.
- Opening a second text box before finishing the first committed the same words
  twice, in two places.
- The JPEG quality slider never saved, so it reset every time.
- Save, Copy and Sharpen text were clickable on a screenshot that had expired,
  and answered with a raw error message.

Elsewhere:

- The privacy policy said a screenshot is deleted as soon as the editor loads
  it. That stopped being true when the editor started keeping it, so that
  reloading the tab does not throw the picture away. The policy now describes
  what actually happens, and the one-day limit it falls back on is now enforced
  when the browser starts, rather than only when Fullshot happens to run again.
- The release gate could not fail its own version check, ignored optional
  permissions entirely, and wrote the store zips before deciding whether the
  build was acceptable.
- Fullshot is free and stays free, so there is now a quiet Buy Me a Coffee link
  at the bottom of the editor panel and in settings. No image is fetched for it.

## 1.0.4

- Fullshot's own progress card could end up in the screenshot, sitting in the
  top right corner of the image. Two things had to go wrong together. Every
  browser was being identified as Firefox, because the check relied on a global
  that Chromium now defines too and on an API that only exists when an
  extension asks for a permission this one deliberately never asks for. That
  turned on a Firefox-only shortcut, which takes the whole page in a single
  photograph, and that shortcut was the one capture path that never told the
  page to put the card away first. On Firefox the card landed in every
  full-page screenshot; on Chrome it landed in any page short enough to fit on
  screen in one go, and cost a wasted photograph on every other page.
- Hiding the card is now the job of a single step that runs before every
  photograph, whichever path is taking it, so a new capture path cannot forget
  to do it. It is also hidden in a way a page's own stylesheet cannot override.

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
