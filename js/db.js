// Tiny IndexedDB wrapper. All data stays on the device.
const DB_NAME = 'budget-pwa';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const out = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  allEntries: () => tx('entries', 'readonly', s => s.getAll()),
  putEntry: entry => tx('entries', 'readwrite', s => s.put(entry)),
  putEntries: list => tx('entries', 'readwrite', s => { list.forEach(e => s.put(e)); }),
  deleteEntry: id => tx('entries', 'readwrite', s => s.delete(id)),
  clearEntries: () => tx('entries', 'readwrite', s => s.clear()),
  getSettings: () => tx('settings', 'readonly', s => s.get('settings')),
  saveSettings: settings => tx('settings', 'readwrite', s => s.put(settings, 'settings')),
};
