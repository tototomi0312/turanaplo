// IndexedDB storage. Shaped like the future server tables (hikes, photos, places,
// reports) so the backend step is a sync layer, not a rewrite.
(function () {
  const NAME = 'turanaplo';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('hikes', { keyPath: 'id' });
        const ph = db.createObjectStore('photos', { keyPath: 'id' });
        ph.createIndex('hikeId', 'hikeId');
        db.createObjectStore('places', { keyPath: 'id' });
        const rp = db.createObjectStore('reports', { keyPath: 'id' });
        rp.createIndex('placeId', 'placeId');
        db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function wrap(req) {
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  }

  async function tx(store, mode, fn) {
    const db = await open();
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return result instanceof IDBRequest ? result.result : result;
  }

  const DB = {
    put: (store, val) => tx(store, 'readwrite', (s) => s.put(val)),
    get: async (store, key) => { const db = await open(); return wrap(db.transaction(store).objectStore(store).get(key)); },
    del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
    all: async (store) => { const db = await open(); return wrap(db.transaction(store).objectStore(store).getAll()); },
    byIndex: async (store, index, key) => {
      const db = await open();
      return wrap(db.transaction(store).objectStore(store).index(index).getAll(key));
    },
    kvGet: async (key) => { const db = await open(); return wrap(db.transaction('kv').objectStore('kv').get(key)); },
    kvSet: (key, val) => tx('kv', 'readwrite', (s) => s.put(val, key)),
    kvDel: (key) => tx('kv', 'readwrite', (s) => s.delete(key)),
    clear: async (store) => tx(store, 'readwrite', (s) => s.clear()),
  };

  DB.uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  DB.settings = async () => Object.assign({ heightCm: null, mapLayer: 'topo' }, (await DB.kvGet('settings')) || {});
  DB.saveSettings = (s) => DB.kvSet('settings', s);

  // Photos are stored as ArrayBuffer, not Blob. On Tomi's iPhone (2026-10-25) a
  // Blob-stored photo showed as a broken image; Safari's IndexedDB Blob handling is
  // the suspected cause (not measured on the device). ArrayBuffer avoids that path.
  DB.photoBlob = (p) => p.data ? new Blob([p.data], { type: p.type || 'image/jpeg' }) : p.blob;

  // Small error log in the kv store, shown in Settings, so field problems can be read back.
  DB.logError = async (where, err) => {
    try {
      const list = (await DB.kvGet('errors')) || [];
      const msg = String(err && (err.message || err)), last = list[list.length - 1];
      if (last && last.where === where && last.msg === msg) { last.n = (last.n || 1) + 1; last.t = Date.now(); } // a timer loop must not flood the log
      else list.push({ t: Date.now(), where, msg, ua: navigator.userAgent.slice(0, 120) });
      await DB.kvSet('errors', list.slice(-50));
    } catch (e) { /* logging must never break the app */ }
  };

  window.DB = DB;
})();
