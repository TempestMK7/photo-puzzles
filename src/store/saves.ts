import type { KindId } from '../core/kinds';

/** A puzzle left unfinished: which one it is, how long it has been played and the state the puzzle itself gave. */
export interface SaveRecord {
  /** Photo, type and difficulty (see recordKey): one save for each. */
  key: string;
  photoId: string;
  kind: KindId;
  /** The seed the puzzle was made from; a save only comes back for the same seed. */
  seed: string;
  /** The picture's size when it was saved, to be sure it is the same picture. */
  width: number;
  height: number;
  elapsed: number;
  savedAt: number;
  state: unknown;
}

const DB_NAME = 'photo-puzzles-saves';
const STORE = 'saves';

function open(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('photoId', 'photoId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Where unfinished puzzles are kept: in the browser's own IndexedDB, on this device only (nothing is ever sent anywhere). If the browser refuses storage the saves
 * last for this visit.
 */
export class SaveStore {
  private db: Promise<IDBDatabase | null>;
  private memory = new Map<string, SaveRecord>();

  constructor(idb: IDBFactory | null = typeof indexedDB === 'undefined' ? null : indexedDB) {
    this.db = idb ? open(idb).catch(() => null) : Promise.resolve(null);
  }

  async get(key: string): Promise<SaveRecord | undefined> {
    const db = await this.db;
    if (!db) return this.memory.get(key);
    try {
      return await new Promise<SaveRecord | undefined>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as SaveRecord | undefined);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return undefined;
    }
  }

  async put(rec: SaveRecord): Promise<void> {
    const db = await this.db;
    if (!db) {
      this.memory.set(rec.key, rec);
      return;
    }
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      await done(tx);
    } catch {
      this.memory.set(rec.key, rec);
    }
  }

  async remove(key: string): Promise<void> {
    this.memory.delete(key);
    const db = await this.db;
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      await done(tx);
    } catch {
      // nothing more to do
    }
  }

  /** Every save of a photo or video (it has been deleted). */
  async removeForPhoto(photoId: string): Promise<void> {
    for (const [k, v] of [...this.memory]) if (v.photoId === photoId) this.memory.delete(k);
    const db = await this.db;
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('photoId');
      const req = index.openCursor(IDBKeyRange.only(photoId));
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          cur.delete();
          cur.continue();
        }
      };
      await done(tx);
    } catch {
      // nothing more to do
    }
  }
}
