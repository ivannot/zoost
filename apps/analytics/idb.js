// The smallest possible persistence of a FileSystemDirectoryHandle, in IndexedDB.
const IDB_NAME = 'zoost';

window.idbHandle = {
  async _db() {
    if (this.__db) return this.__db;
    this.__db = await new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
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
};
