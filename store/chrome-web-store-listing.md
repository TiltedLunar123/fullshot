# Chrome Web Store listing

## Name

Fullshot - Full Page Screenshot

## Category

Workflow & Planning

## Short description (132 character limit)

Full page screenshots that handle sticky headers, lazy images and scrolling panels. Free editor and PDF export. No account.

## Detailed description

Capture a whole web page as one image, including all the parts you have to scroll to reach.

Most screenshot tools handle a plain article fine. It's everything else that goes wrong. The navigation bar that follows you down the page gets stamped into the picture over and over. Images below the fold come out as empty grey boxes (they never loaded). Really long pages save as a file that's blank, or cut off halfway. Fullshot exists because of those specific failures.

WHAT IT DOES DIFFERENTLY

Sticky menus and floating bars show up once. A sticky header goes back to its natural place in the document. A fixed toolbar or cookie bar gets drawn once, at the edge it belongs to, instead of repeating on every screenful of the image.

Images get loaded first. Fullshot walks the page before it captures anything, so pictures that only load once you scroll to them are actually there. No blank bands.

No seams, no repeated strips. After every scroll, Fullshot reads back where the page really landed instead of assuming. Browsers stop that last scroll short of where you asked, and assuming is exactly what leaves visible joins in a stitched image.

Long pages don't fail quietly. Browsers have a maximum image size, and going past it hands you a blank picture with no error at all. Fullshot measures your browser's real limit first. Then it either fits the image to that limit and says so, or saves a multi page PDF instead.

FOUR WAYS TO CAPTURE

Full page. Everything from the top of the page to the bottom, and it handles pages wider than your window too.

Visible area. Just what's on the screen right now.

Pick an element. Click any part of the page and capture only that piece.

Scrolling panel. For message threads and mailboxes, where the content scrolls inside a box rather than the page itself; a sidebar that scrolls on its own counts too. This is the one that normally defeats a screenshot tool.

EDITOR INCLUDED, NOTHING LOCKED

Crop, black out, pixelate, arrows, boxes and text, with undo and redo.

Save as PNG, JPEG, WebP or a multi page PDF.

Copy straight to the clipboard with Ctrl+C.

Optional text sharpening (worth turning on when a very long page had to be scaled down to fit).

There's no paid tier and no upgrade prompt. All of it is just there.

PRIVACY

Fullshot asks for three permissions: activeTab, scripting and storage. It does not ask for access to your websites. It can't read a page until you click the toolbar button or press the shortcut on that tab, and that access ends when you navigate away.

It makes no network requests at all. No analytics and no error reporting. It doesn't even check for its own updates. The source contains no code capable of making one, and the build refuses to produce a release if that ever changes.

Your screenshot stays in your browser until you save it.

OPEN SOURCE

The whole source is on GitHub, including the tests that check a sticky header appears exactly once and that every slice of a stitched page lands where it belongs.

https://github.com/TiltedLunar123/fullshot

KEYBOARD SHORTCUTS

Alt+Shift+S captures the full page. Alt+Shift+V captures the visible area. You can change both on your browser's extension shortcuts page.

## Permission justifications (for the review form)

**activeTab**: Required to take the screenshot. Fullshot uses chrome.tabs.captureVisibleTab on the tab the user explicitly invoked it on, either by clicking the toolbar button or pressing the keyboard shortcut. No broad host permission is requested.

**scripting**: Required to inject the capture agent into the page being captured. The agent prepares the page (loads lazy images, neutralises sticky and fixed elements, disables smooth scrolling), scrolls it, and restores every change when the capture finishes.

**storage**: Required to save the user's settings, and to hold the finished screenshot briefly so the editor tab can open it. Both stay on the user's machine.

**Remote code**: None. No code is fetched or evaluated at runtime.

**Data usage**: Fullshot collects nothing and transmits nothing. It contains no network primitive of any kind.
