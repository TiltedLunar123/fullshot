import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadLibs } from './helper.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.chrome = { runtime: {} };
const FS = await loadLibs(['browser', 'settings']);

/** A storage.local that behaves like the real one, including its misses. */
function fakeStorage(initial = {}) {
  let data = structuredClone(initial);
  return {
    read: () => structuredClone(data),
    api: {
      storage: {
        local: {
          async get(key) {
            // The real API answers with an object that simply lacks the key,
            // never with the key set to undefined.
            return key in data ? { [key]: structuredClone(data[key]) } : {};
          },
          async set(patch) {
            data = { ...data, ...structuredClone(patch) };
          },
          async remove(key) {
            delete data[key];
          },
        },
      },
    },
  };
}

async function withStorage(initial, fn) {
  const store = fakeStorage(initial);
  const previous = FS.api;
  FS.api = store.api;
  try {
    return await fn(store);
  } finally {
    FS.api = previous;
  }
}

test('a profile that has never opened the settings page reads every default', async () => {
  await withStorage({}, async () => {
    assert.deepEqual(await FS.settings.get(), FS.DEFAULTS);
  });
});

test('a stored value wins over the default, and the rest still arrive', async () => {
  await withStorage({ settings: { settleMs: 400 } }, async () => {
    const settings = await FS.settings.get();
    assert.equal(settings.settleMs, 400);
    assert.equal(settings.floatingPolicy, FS.DEFAULTS.floatingPolicy);
    assert.equal(Object.keys(settings).length, Object.keys(FS.DEFAULTS).length);
  });
});

test('writing one setting leaves the others alone', async () => {
  // The settings page writes on every keystroke and every tick, and the editor
  // writes the JPEG quality from a different page entirely. A write that
  // replaced the object rather than merging into it would throw away whichever
  // preference was set last.
  await withStorage({ settings: { format: 'webp', jpegQuality: 60 } }, async (store) => {
    await FS.settings.set({ retina: false });
    const saved = store.read().settings;
    assert.equal(saved.format, 'webp');
    assert.equal(saved.jpegQuality, 60);
    assert.equal(saved.retina, false);
  });
});

test('reset clears the stored settings rather than writing the defaults over them', async () => {
  // Writing them out would pin today's defaults into the profile for ever, so
  // a later release could never change one for anybody who had ever pressed
  // Reset.
  await withStorage({ settings: { retina: false } }, async (store) => {
    const after = await FS.settings.reset();
    assert.deepEqual(after, FS.DEFAULTS);
    assert.equal('settings' in store.read(), false);
    assert.deepEqual(await FS.settings.get(), FS.DEFAULTS);
  });
});

test('a cached canvas budget is used, and dropped once it is a month old', async () => {
  const fresh = { maxArea: 268435456, maxDimension: 65535, measuredAt: Date.now() };
  await withStorage({ canvasBudget: fresh }, async () => {
    assert.deepEqual(await FS.settings.getCachedBudget(), fresh);
  });

  const stale = { ...fresh, measuredAt: Date.now() - 40 * 24 * 60 * 60 * 1000 };
  await withStorage({ canvasBudget: stale }, async () => {
    assert.equal(await FS.settings.getCachedBudget(), null);
  });
});

test('the settings page reads the real defaults instead of keeping a copy', async () => {
  // This is the drift that shipped once already: the popup kept its own list of
  // blocked pages, file:// was never added to it, and a local file looked
  // capturable right up to the moment the background refused it. The settings
  // page was carrying a second copy of every default the same way.
  const source = await fs.readFile(path.join(ROOT, 'src', 'options', 'options.js'), 'utf8');
  const page = await fs.readFile(path.join(ROOT, 'src', 'options', 'options.html'), 'utf8');

  assert.ok(page.includes('lib/settings.js'), 'the settings page must load the real defaults');
  for (const key of Object.keys(FS.DEFAULTS)) {
    assert.ok(
      !new RegExp(`^\\s*${key}\\s*:`, 'm').test(source),
      `options.js defines its own "${key}" default; it must come from FS.DEFAULTS`
    );
  }
});
