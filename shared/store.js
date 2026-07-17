const DB_NAME    = 'sitekey';
const DB_VERSION = 2;
const VAULT_STORE = 'vault';
const APP_STORE   = 'app';

let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        db.createObjectStore(VAULT_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(APP_STORE)) {
        db.createObjectStore(APP_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(VAULT_STORE, mode);
    const req = fn(t.objectStore(VAULT_STORE));
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function txApp(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t   = db.transaction(APP_STORE, mode);
    const req = fn(t.objectStore(APP_STORE));
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

export const getVaultRecord  = ()       => tx('readonly',  s => s.get(1));
export const saveVaultRecord = record   => tx('readwrite', s => s.put({ ...record, id: 1 }));
export const clearVaultStore = ()       => tx('readwrite', s => s.clear());
export const isInitialized   = async () => { const r = await getVaultRecord(); return r?.encryptedVault != null; };

export const getLinkedFileHandle   = ()       => txApp('readonly',  s => s.get('linkedFile')).then(r => r?.handle ?? null);
export const saveLinkedFileHandle  = handle   => txApp('readwrite', s => s.put({ key: 'linkedFile', handle }));
export const clearLinkedFileHandle = ()       => txApp('readwrite', s => s.delete('linkedFile'));
