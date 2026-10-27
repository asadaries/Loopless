/* Shared IndexedDB store for finished recordings.
   Every extension page (popup, review, recorder) lives on the same
   chrome-extension:// origin, so they all read and write this one database.
   That is how the blob recorded in the recorder window reaches
   the review page: blob URLs do not cross documents, but IndexedDB does. */
(function (global) {
  const DB_NAME = 'takes'; // from before the rename to Loopless; changing it would orphan saved recordings
  const DB_VERSION = 1;
  const STORE = 'recordings';

  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const LooplessDB = {
    newId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    },
    put(record) { return tx('readwrite', (s) => s.put(record)); },
    get(id) { return tx('readonly', (s) => s.get(id)); },
    delete(id) { return tx('readwrite', (s) => s.delete(id)); },
    /** Newest first. Pass meta:true to leave the blobs behind. */
    async list({ limit = 50, meta = false } = {}) {
      const all = await tx('readonly', (s) => s.getAll());
      const rows = (all || []).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
      return meta ? rows.map(({ blob, ...rest }) => rest) : rows;
    },
    async patch(id, changes) {
      const existing = await LooplessDB.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...changes };
      await LooplessDB.put(merged);
      return merged;
    },
  };

  global.LooplessDB = LooplessDB;
})(self);
