# Privacy policy

**Fullshot collects nothing, sends nothing, and stores nothing about you.**

Last updated: 29 July 2026

## Data collected

None. There is no analytics, no telemetry, no crash reporting, no update check,
no advertising identifier, and no account.

## Network activity

Fullshot makes no network requests of any kind. It contains no code capable of
making one. The build is gated on this: `tools/build.mjs --check` fails if
`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` appears
anywhere in the shipped source, and it fails if a broad host permission is ever
added to either manifest.

Anyone can verify this by running `npm run check` on the source.

## What is stored, and where

Two things, both in your browser's own extension storage on your own machine:

1. **Your settings.** Capture and export preferences. Never leaves the browser.
2. **The screenshot you just took.** Held briefly so the editor tab can open it,
   then deleted as soon as the editor has loaded it. Anything left behind by an
   interrupted capture is discarded after one day.

Saved screenshots go wherever your browser puts downloads. Fullshot has no
access to them once they are saved.

## Page access

Fullshot requests `activeTab`, not host permissions. It has no ability to read
any website until you explicitly invoke it on a tab by clicking its toolbar
button or pressing its keyboard shortcut, and that access ends when you navigate
away from that page or close the tab.

It cannot read your browsing history, your other tabs, or any page you have not
explicitly pointed it at.

## Permissions and why each is needed

| Permission | Why |
|---|---|
| `activeTab` | Take the screenshot, on the one tab you invoked it on |
| `scripting` | Insert the capture agent that scrolls and prepares that page |
| `storage` | Remember your settings and hold the screenshot until the editor opens it |

## Changes

Any change to this policy will be recorded in the repository's history and in
`CHANGELOG.md`.

## Contact

Open an issue at https://github.com/TiltedLunar123/fullshot/issues
