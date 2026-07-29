/**
 * Blob handoff between the background context and the editor tab.
 *
 * Extension message passing serialises to JSON, so a multi-megabyte image
 * cannot travel that way without base64 inflating it by a third and stalling
 * the worker. IndexedDB stores the Blob natively and is shared across every
 * extension page, so the background writes a record and the editor reads it.
 */
globalThis.FS = globalThis.FS || {};

FS.store = {
  DB: 'fullshot',
  STORE: 'captures',
  VERSION: 1,

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB, this.VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.STORE)) {
          db.createObjectStore(this.STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async _tx(mode, fn) {
    const db = await this._open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, mode);
        const store = tx.objectStore(this.STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result?.result ?? result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },

  async put(record) {
    await this._tx('readwrite', (store) => store.put(record));
    return record.id;
  },

  async get(id) {
    return this._tx('readonly', (store) => store.get(id));
  },

  async delete(id) {
    return this._tx('readwrite', (store) => store.delete(id));
  },

  /**
   * Drop captures older than a day.
   *
   * A screenshot is a transient artefact; keeping it around indefinitely would
   * quietly turn into a browsing history nobody asked for.
   */
  async prune(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const db = await this._open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, 'readwrite');
        const store = tx.objectStore(this.STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if ((cursor.value?.createdAt ?? 0) < cutoff) cursor.delete();
          cursor.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },

  newId() {
    // crypto.randomUUID is available in workers and extension pages alike.
    return globalThis.crypto?.randomUUID?.() ?? `cap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  },
};
