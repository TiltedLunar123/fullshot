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

FS.isFileUrl = (url) => /^file:\/\//i.test(url ?? '');

/**
 * Whether this browser will let Fullshot touch file:// pages.
 *
 * Chromium keeps a per-extension "Allow access to file URLs" switch, off by
 * default, and `extension.isAllowedFileSchemeAccess` reports which way it is
 * set. Asking costs no permission, which is the only reason it can be asked
 * from here. Fullshot used to assume the switch was off and refuse every local
 * file, so a user who went and turned it on got exactly the same refusal and no
 * way to capture a local file at all.
 *
 * Gecko has no such switch. Reaching file:// there means holding the
 * `file:///*` host permission, which Fullshot does not request and will not, so
 * on Firefox the answer is a flat no and there is nothing to go and ask.
 *
 * Anything unexpected answers no. A refusal is a sentence the user can act on,
 * whereas starting a capture that cannot work ends in the browser's own error.
 */
FS.canAccessFiles = function () {
  if (FS.isFirefox) return Promise.resolve(false);
  const ext = FS.api.extension;
  if (typeof ext?.isAllowedFileSchemeAccess !== 'function') return Promise.resolve(false);

  return new Promise((resolve) => {
    const answer = (allowed) => resolve(allowed === true);
    try {
      // Callback flavoured on Chromium. Some builds hand back a promise as
      // well, so both are read; whichever arrives first wins, and resolve()
      // ignores the other.
      const returned = ext.isAllowedFileSchemeAccess(answer);
      if (returned && typeof returned.then === 'function') {
        returned.then(answer, () => answer(false));
      }
    } catch {
      answer(false);
    }
  });
};

/**
 * Why this page cannot be captured, or null if it can.
 *
 * Deliberately still synchronous and side-effect free. `fileAccess` is what
 * canAccessFiles() answered, probed by the caller and handed in, so that the
 * one place that needs an await does the awaiting and this stays a plain
 * function of its arguments.
 */
FS.restrictionFor = function (url, fileAccess = false) {
  if (!url) return 'This tab has no address Fullshot can read.';
  if (FS.RESTRICTED.some((re) => re.test(url))) {
    return 'Browsers block extensions from capturing this page. Try it on an ordinary web page.';
  }
  if (FS.isFileUrl(url)) {
    if (fileAccess) return null;
    // Two engines, two different facts, so two different sentences. Sending a
    // Firefox user off to switch on something Firefox does not have is worse
    // than telling them no.
    return FS.isFirefox
      ? 'Fullshot cannot capture local files on Firefox. That would need access to every file on your computer, which Fullshot does not ask for.'
      : 'Fullshot needs file access to capture local files. Find Fullshot on the extensions page, turn on "Allow access to file URLs", then try again.';
  }
  return null;
};

FS.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
