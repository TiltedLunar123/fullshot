/**
 * Settings page. Every control writes through immediately, so there is no Save
 * button to forget.
 *
 * The defaults come from lib/settings.js rather than from a second copy kept
 * here. That copy was in step by luck rather than design, and it is exactly how
 * the popup's private list of restricted URLs came to disagree with the real
 * one: whichever file gets edited, the other goes on answering the old value.
 */
(() => {
  const CHECKBOXES = ['primeLazyContent', 'freezeMotion', 'retina', 'enhanceText', 'openEditor'];
  const SELECTS = ['floatingPolicy', 'format', 'enhanceLevel'];
  const TEXTS = ['filenameTemplate'];
  const RANGES = ['settleMs'];

  const $ = (id) => document.getElementById(id);
  let savedTimer = null;

  function flashSaved() {
    $('saved').textContent = 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('saved').textContent = ''), 1400);
  }

  async function load() {
    const settings = await FS.settings.get();

    for (const key of CHECKBOXES) $(key).checked = Boolean(settings[key]);
    for (const key of [...SELECTS, ...TEXTS]) $(key).value = settings[key];
    for (const key of RANGES) {
      $(key).value = settings[key];
      $(`${key}-out`).value = `${settings[key]} ms`;
    }
  }

  async function write(key, value) {
    await FS.settings.set({ [key]: value });
    flashSaved();
  }

  for (const key of CHECKBOXES) {
    $(key).addEventListener('change', (e) => write(key, e.target.checked));
  }
  for (const key of SELECTS) {
    $(key).addEventListener('change', (e) => write(key, e.target.value));
  }
  for (const key of TEXTS) {
    $(key).addEventListener('change', (e) => write(key, e.target.value.trim() || FS.DEFAULTS[key]));
  }
  for (const key of RANGES) {
    $(key).addEventListener('input', (e) => {
      $(`${key}-out`).value = `${e.target.value} ms`;
    });
    $(key).addEventListener('change', (e) => write(key, Number(e.target.value)));
  }

  $('reset').addEventListener('click', async () => {
    await FS.settings.reset();
    await load();
    flashSaved();
  });

  load();
})();
