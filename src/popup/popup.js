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

// Surface a restricted page before the user clicks and gets a confusing error.
(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? '';
    const blocked =
      /^(chrome|edge|about|devtools|view-source|moz-extension|chrome-extension):/i.test(url) ||
      /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org)/i.test(url);
    if (blocked) {
      setBusy(true);
      say('Browsers block screenshots of this page. Open an ordinary web page and try again.', true);
    }
  } catch {
    /* activeTab may not be granted until a click; silence is correct here */
  }
})();
