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

function say(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const b of buttons) b.disabled = busy;
}

async function start(mode) {
  setBusy(true);
  say(mode === 'element' || mode === 'area' ? 'Click what you want to capture...' : 'Working...');

  try {
    const result = await api.runtime.sendMessage({ type: 'FS_START', mode });

    if (result?.ok) {
      // The editor opens in a new tab, so there is nothing left to show here.
      window.close();
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
