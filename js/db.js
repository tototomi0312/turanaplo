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

  window.DB = DB;
})();
