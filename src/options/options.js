/**
 * Settings page. Every control writes through immediately, so there is no Save
 * button to forget.
 */
(() => {
  const api = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;

  const DEFAULTS = {
    floatingPolicy: 'once',
    settleMs: 120,
    imageWaitMs: 1500,
    primeLazyContent: true,
    freezeMotion: true,
    format: 'png',
    jpegQuality: 92,
    filenameTemplate: '{title} - {date}',
    retina: true,
    openEditor: true,
  };

  const CHECKBOXES = ['primeLazyContent', 'freezeMotion', 'retina', 'openEditor'];
  const SELECTS = ['floatingPolicy', 'format'];
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
    const stored = (await api.storage.local.get('settings')).settings ?? {};
    const settings = { ...DEFAULTS, ...stored };

    for (const key of CHECKBOXES) $(key).checked = Boolean(settings[key]);
    for (const key of [...SELECTS, ...TEXTS]) $(key).value = settings[key];
    for (const key of RANGES) {
      $(key).value = settings[key];
      $(`${key}-out`).value = `${settings[key]} ms`;
    }
  }

  async function write(key, value) {
    const stored = (await api.storage.local.get('settings')).settings ?? {};
    await api.storage.local.set({ settings: { ...DEFAULTS, ...stored, [key]: value } });
    flashSaved();
  }

  for (const key of CHECKBOXES) {
    $(key).addEventListener('change', (e) => write(key, e.target.checked));
  }
  for (const key of SELECTS) {
    $(key).addEventListener('change', (e) => write(key, e.target.value));
  }
  for (const key of TEXTS) {
    $(key).addEventListener('change', (e) => write(key, e.target.value.trim() || DEFAULTS[key]));
  }
  for (const key of RANGES) {
    $(key).addEventListener('input', (e) => {
      $(`${key}-out`).value = `${e.target.value} ms`;
    });
    $(key).addEventListener('change', (e) => write(key, Number(e.target.value)));
  }

  $('reset').addEventListener('click', async () => {
    await api.storage.local.remove('settings');
    await load();
    flashSaved();
  });

  load();
})();
