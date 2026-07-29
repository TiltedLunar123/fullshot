/**
 * Quota-adaptive capture scheduler.
 *
 * `tabs.captureVisibleTab` is documented at a ceiling of
 * MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2, but the ceiling is not enforced
 * identically across engines and versions. A hardcoded conservative delay
 * therefore over-pays on every single page.
 *
 * This scheduler treats the real limit as unknown and measures it: it starts
 * near the documented rate, speeds up while calls keep succeeding, and backs off
 * and RETRIES when the browser rejects a call for quota. Because a rejected
 * capture is always retried, adapting downward can cost time but can never lose
 * a slice.
 */
globalThis.FS = globalThis.FS || {};

FS.CaptureScheduler = class CaptureScheduler {
  constructor(options = {}) {
    // Documented rate is 2/s. Start there rather than guessing optimistically,
    // then let sustained success pull the interval down.
    this.interval = options.startInterval ?? 500;
    this.minInterval = options.minInterval ?? 220;
    this.maxInterval = options.maxInterval ?? 1200;
    this.speedUpAfter = options.speedUpAfter ?? 4;
    this.maxRetries = options.maxRetries ?? 6;
    this.lastCallAt = 0;
    this.streak = 0;
    this.quotaHits = 0;
  }

  static isQuotaError(err) {
    const msg = String(err?.message ?? err ?? '');
    return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|too many/i.test(msg);
  }

  async #pace() {
    const wait = this.lastCallAt + this.interval - Date.now();
    if (wait > 0) await FS.sleep(wait);
  }

  /**
   * Run `fn` under the current rate estimate, retrying on quota rejection.
   * Errors that are not quota-related propagate immediately: retrying a
   * restricted-URL failure six times would only delay a clear message.
   */
  async run(fn) {
    for (let attempt = 0; ; attempt++) {
      await this.#pace();
      this.lastCallAt = Date.now();
      try {
        const result = await fn();
        this.streak++;
        if (this.streak >= this.speedUpAfter && this.interval > this.minInterval) {
          this.interval = Math.max(this.minInterval, Math.round(this.interval * 0.85));
          this.streak = 0;
        }
        return result;
      } catch (err) {
        if (!CaptureScheduler.isQuotaError(err) || attempt >= this.maxRetries) throw err;
        this.quotaHits++;
        this.streak = 0;
        this.interval = Math.min(this.maxInterval, Math.round(this.interval * 1.6));
        await FS.sleep(this.interval);
      }
    }
  }

  stats() {
    return { interval: this.interval, quotaHits: this.quotaHits };
  }
};
