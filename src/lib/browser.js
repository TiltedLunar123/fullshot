/**
 * Cross-browser namespace.
 *
 * Firefox exposes promise-returning APIs on `browser`; Chrome exposes them on
 * `chrome` under MV3. Both also expose a callback-style `chrome`, so picking
 * `browser` first gives one promise-based surface on either engine.
 */
globalThis.FS = globalThis.FS || {};

FS.api = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;

/**
 * True on Gecko, where captureVisibleTab may honour an ImageDetails rect.
 *
 * The `browser` global is no longer a Gecko tell: Chromium exposes one as well.
 * The old tiebreak on `chrome.offscreen` was worse than useless, because that
 * API only exists when an extension asks for the `offscreen` permission, which
 * this one never does. Both halves therefore agreed on Chromium and every
 * Chromium build called itself Firefox.
 *
 * `runtime.getBrowserInfo` is Gecko-only, needs no permission, and is not
 * called here, only looked for.
 */
FS.isFirefox =
  typeof browser !== 'undefined' &&
  !!browser.runtime &&
  typeof browser.runtime.getBrowserInfo === 'function';

/**
 * URLs the browser refuses to let extensions script or capture. Detecting these
 * up front turns a confusing silent failure into a sentence the user can act on.
 */
FS.RESTRICTED = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^about:/i,
  /^edge:\/\//i,
  /^devtools:\/\//i,
  /^view-source:/i,
  /^https:\/\/chromewebstore\.google\.com/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/addons\.mozilla\.org/i,
];

FS.restrictionFor = function (url) {
  if (!url) return 'This tab has no address Fullshot can read.';
  if (FS.RESTRICTED.some((re) => re.test(url))) {
    return 'Browsers block extensions from capturing this page. Try it on an ordinary web page.';
  }
  if (/^file:\/\//i.test(url)) {
    return 'Local files need file access enabled for Fullshot in your extensions settings.';
  }
  return null;
};

FS.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
