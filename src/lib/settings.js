/**
 * Settings and small persisted state.
 *
 * Everything lives in the browser's own extension storage. Nothing is sent
 * anywhere, and there is no identifier of any kind.
 */
globalThis.FS = globalThis.FS || {};

FS.DEFAULTS = {
  /** 'once' shows floating chrome one time, 'never' hides it, 'keep' leaves it. */
  floatingPolicy: 'once',
  /** Extra settle time per slice, in ms. Raised for slow or heavy pages. */
  settleMs: 120,
  /** Wait up to this long for images to finish decoding before a slice. */
  imageWaitMs: 1500,
  /** Run the full-page pre-scroll that wakes lazy content. */
  primeLazyContent: true,
  /** Pause CSS animations and transitions so slices do not tear. */
  freezeMotion: true,
  /** Default export format in the editor. */
  format: 'png',
  jpegQuality: 92,
  /** Filename template. Supports {title} {host} {date} {time}. */
  filenameTemplate: '{title} - {date}',
  /** Capture at device resolution for sharp output on HiDPI screens. */
  retina: true,
  /** Sharpen edges so small text stays legible, especially after a downscale. */
  enhanceText: false,
  /** How hard to sharpen: subtle | medium | strong. */
  enhanceLevel: 'medium',
  /** Open the editor when a capture finishes. */
  openEditor: true,
};

FS.settings = {
  async get() {
    const stored = await FS.api.storage.local.get('settings');
    return { ...FS.DEFAULTS, ...(stored.settings ?? {}) };
  },

  async set(patch) {
    const next = { ...(await this.get()), ...patch };
    await FS.api.storage.local.set({ settings: next });
    return next;
  },

  async reset() {
    await FS.api.storage.local.remove('settings');
    return { ...FS.DEFAULTS };
  },

  async getCachedBudget() {
    const stored = await FS.api.storage.local.get('canvasBudget');
    const budget = stored.canvasBudget;
    if (!budget) return null;
    // Re-probe monthly; a driver or hardware change can move the ceiling.
    if (Date.now() - (budget.measuredAt ?? 0) > 30 * 24 * 60 * 60 * 1000) return null;
    return budget;
  },

  async setCachedBudget(budget) {
    await FS.api.storage.local.set({ canvasBudget: budget });
  },
};
