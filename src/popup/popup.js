/**
 * Popup.
 *
 * Deliberately thin: it picks a mode, hands off to the background, and gets out
 * of the way. Capture progress is shown on the page itself, because the popup
 * closes the moment the user clicks anything.
 */
const api = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;

const status = document.querySelector('.status');
const buttons = [...document.querySelectorAll('.mode')];
const openCapture = document.getElementById('open-capture');

function say(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const b of buttons) b.disabled = busy;
}

/**
 * Take the alarm badge down.
 *
 * It is set against a SPECIFIC tab, and a per-tab badge overrides the default
 * one, so clearing the default left the "!" exactly where it was. A capture
 * that failed from the keyboard therefore flagged the toolbar icon red until
 * some later capture on the same tab happened to overwrite it: the user read
 * the message here, closed the popup, and the alarm went on claiming something
 * was wrong with a message that no longer existed anywhere.
 */
async function clearAlarmBadge() {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) await api.action.setBadgeText({ tabId: tab.id, text: '' });
    await api.action.setBadgeText({ text: '' });
  } catch {
    /* the badge is decorative; never let it break a capture */
  }
}

/** Show the "open it" button for a capture nothing has displayed yet. */
function offerCapture(id) {
  openCapture.hidden = false;
  openCapture.onclick = async () => {
    await api.storage.local.remove('pendingCapture');
    await api.tabs.create({
      url: api.runtime.getURL(`editor/editor.html?id=${encodeURIComponent(id)}`),
    });
    window.close();
  };
}

async function start(mode) {
  setBusy(true);
  // The alarm badge belongs to the failure the user is now looking at, so a new
  // attempt clears it.
  await clearAlarmBadge();
  say(mode === 'element' || mode === 'area' ? 'Click what you want to capture...' : 'Working...');

  try {
    const result = await api.runtime.sendMessage({ type: 'FS_START', mode });

    if (result?.ok) {
      if (result.editorOpened) {
        // The editor opens in a new tab, so there is nothing left to show here.
        window.close();
        return;
      }
      // "Open the editor after capturing" is switched off, so the capture is
      // sitting in storage and nothing has happened on screen. Saying nothing
      // and closing, which is what this used to do, made the whole setting look
      // as though it threw screenshots away.
      say('Captured. It is saved for a day.');
      offerCapture(result.id);
      return;
    }
    if (result?.cancelled) {
      window.close();
      return;
    }
    say(result?.error ?? 'Something went wrong.', true);
  } catch (err) {
    say(String(err?.message ?? err), true);
  } finally {
    setBusy(false);
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => start(button.dataset.mode));
}

document.getElementById('options').addEventListener('click', () => {
  api.runtime.openOptionsPage();
  window.close();
});

// A capture that failed with no popup open had nowhere to say so: the keyboard
// shortcuts have no popup at all, and the element and panel pickers close it.
// The background parks the message here instead.
(async () => {
  try {
    const { lastError } = await api.storage.local.get('lastError');
    await api.storage.local.remove('lastError');
    if (!lastError?.message) return;
    // Either way the badge has done its job: the message is either on screen
    // now or too old to be worth showing, and in both cases it has just been
    // taken out of storage, so nothing will ever display it again.
    await clearAlarmBadge();
    // Anything older than a few minutes belongs to a session the user has
    // stopped thinking about, and repeating it now would just be confusing.
    if (Date.now() - (lastError.at ?? 0) > 5 * 60 * 1000) return;
    say(lastError.message, true);
  } catch {
    /* no parked error is the normal case */
  }
})();

// A capture taken with the keyboard shortcut while the editor was switched off
// has no window of its own, so this is the only place it can be offered.
(async () => {
  try {
    const { pendingCapture } = await api.storage.local.get('pendingCapture');
    if (!pendingCapture?.id) return;
    // Captures are pruned after a day, so a stale note points at nothing.
    if (Date.now() - (pendingCapture.at ?? 0) > 24 * 60 * 60 * 1000) {
      await api.storage.local.remove('pendingCapture');
      return;
    }
    say('Your last screenshot is waiting.');
    offerCapture(pendingCapture.id);
  } catch {
    /* nothing to offer is the normal case */
  }
})();

// Show the shortcut the browser ACTUALLY bound, not the one asked for.
//
// A manifest only ever SUGGESTS a key. The browser silently drops a suggestion
// it reserves for itself or that another extension already holds, and the user
// is free to rebind or clear it from the browser's own shortcuts page. None of
// that reached the popup, which printed the suggestion regardless, so the two
// modes that advertise a shortcut could be advertising a key that does nothing.
const COMMAND_FOR_MODE = { full: 'capture-full-page', visible: 'capture-visible' };

(async () => {
  try {
    const commands = await new Promise((resolve) => {
      // Callback flavoured on Chromium, promise flavoured on Gecko. Read both;
      // whichever answers first wins and resolve() ignores the other.
      const returned = api.commands.getAll(resolve);
      if (returned && typeof returned.then === 'function') returned.then(resolve, () => resolve([]));
    });

    const bound = new Map((commands ?? []).map((c) => [c.name, c.shortcut]));
    for (const button of buttons) {
      const kbd = button.querySelector('kbd');
      if (!kbd) continue;
      const shortcut = bound.get(COMMAND_FOR_MODE[button.dataset.mode]);
      if (shortcut) {
        kbd.textContent = shortcut;
        continue;
      }
      // Nothing is bound, so the key printed here would be a lie. Say where one
      // can be set rather than leaving the user to wonder why nothing happens.
      kbd.remove();
      button.title = "No keyboard shortcut is set for this. Your browser's extension shortcuts page can set one.";
    }
  } catch {
    /* leave the suggested keys in place; they are the best guess available */
  }
})();

// Surface a restricted page before the user clicks and gets a confusing error.
//
// The rules come from lib/browser.js rather than from a second copy kept here,
// which is how the two lists came to disagree: the popup's never mentioned
// file:// at all, so a local file looked capturable right up until the moment
// the background refused it.
(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    // No address means activeTab has not been granted yet, not that the page is
    // restricted. Saying nothing is the honest answer.
    if (!url) return;
    const restriction = FS.restrictionFor(url, FS.isFileUrl(url) && (await FS.canAccessFiles()));
    if (restriction) {
      setBusy(true);
      say(restriction, true);
    }
  } catch {
    /* activeTab may not be granted until a click; silence is correct here */
  }
})();
