// @ts-check
// The smallest possible persistence of a FileSystemDirectoryHandle, in IndexedDB.
const IDB_NAME = 'zoost';

window.idbHandle = /** @type {any} */ ({
  /** **The store is checked for and made, not assumed from the version number.**
   *
   * This opened at version 1 and created `kv` from `onupgradeneeded`, which is right for a database
   * that does not exist yet and wrong for one that exists at version 1 *without* the store: no
   * upgrade fires, `db.transaction('kv')` throws synchronously, and two of the four callers do not
   * guard it - so the panel dies on startup with «One of the specified object stores was not found»
   * and no working folder, for ever, because the only path that would recreate the store is the one
   * that just threw.
   *
   * Reached by an extension page sharing its origin with a console that had opened `zoost` without
   * an upgrade handler of its own. That console was mine, which is the honest version of how this
   * was found - but the state is reachable by anything that opens the database by name, and a panel
   * that cannot repair its own storage is one keystroke from unusable in a browser we do not own.
   *
   * So: open at whatever version is current, and if the store is absent, reopen one version up and
   * make it. `onblocked` is answered rather than left to hang - another panel of the same product
   * holding the old version open is ordinary, and a silent wait there is indistinguishable from a
   * dead panel.
   */
  async _db() {
    if (this.__db) return this.__db;
    const open = (version, upgrade) => new Promise((res, rej) => {
      const r = version ? indexedDB.open(IDB_NAME, version) : indexedDB.open(IDB_NAME);
      if (upgrade) r.onupgradeneeded = () => upgrade(r.result);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Another Zoost window is holding this workspace store open - close it and try again.'));
    });
    let db = await open(null, (d) => { if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); });
    if (!db.objectStoreNames.contains('kv')) {
      const next = db.version + 1;
      db.close();
      db = await open(next, (d) => { if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); });
    }
    this.__db = db;
    return this.__db;
  },
  async set(key, val) {
    const db = await this._db();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async get(key) {
    const db = await this._db();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const rq = tx.objectStore('kv').get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
});
