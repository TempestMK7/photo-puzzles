import { loadPhoto, makeThumb, samplePhoto, SAMPLES } from '../image';

/** One photo in the list: the built-in samples and the player's own. */
export interface PhotoEntry {
  id: string;
  name: string;
  /** Samples are made in code and cannot be removed. */
  sample: boolean;
  thumbUrl: string;
  /** Object URL of the full picture, for the preview. */
  previewUrl: string;
}

interface StoredPhoto {
  id: string;
  name: string;
  addedAt: number;
  blob: Blob;
  thumb: Blob;
}

const DB = 'photo-puzzles';
const STORE = 'photos';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', quality));
}

/** A short id from the file's bytes, so adding the same picture twice gives one entry. */
async function hashOf(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The photo library: samples plus whatever the player added, kept in the browser's IndexedDB (nothing leaves the device). If the browser refuses storage the
 * photos still work for this visit.
 */
export class PhotoLibrary {
  private db: IDBDatabase | null = null;
  private memory: StoredPhoto[] = [];
  private urls = new Map<string, { thumb: string; preview: string }>();

  async init(): Promise<void> {
    try {
      this.db = await open();
    } catch {
      this.db = null;
    }
  }

  private async stored(): Promise<StoredPhoto[]> {
    if (!this.db) return [];
    try {
      return await request<StoredPhoto[]>(this.db, 'readonly', (s) => s.getAll());
    } catch {
      return [];
    }
  }

  async list(): Promise<PhotoEntry[]> {
    const out: PhotoEntry[] = [];
    for (const s of SAMPLES) {
      let u = this.urls.get(s.id);
      if (!u) {
        const canvas = samplePhoto(s.id);
        const [thumb, full] = await Promise.all([makeThumb(canvas), toBlob(canvas, 0.9)]);
        u = { thumb: URL.createObjectURL(thumb), preview: URL.createObjectURL(full) };
        this.urls.set(s.id, u);
      }
      out.push({ id: s.id, name: s.name, sample: true, thumbUrl: u.thumb, previewUrl: u.preview });
    }
    const mine = [...(await this.stored()), ...this.memory].sort((a, b) => a.addedAt - b.addedAt);
    const seen = new Set<string>();
    for (const p of mine) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      let u = this.urls.get(p.id);
      if (!u) {
        u = { thumb: URL.createObjectURL(p.thumb), preview: URL.createObjectURL(p.blob) };
        this.urls.set(p.id, u);
      }
      out.push({ id: p.id, name: p.name, sample: false, thumbUrl: u.thumb, previewUrl: u.preview });
    }
    return out;
  }

  /** Adds picture files; returns the ids that were added (or already there) and the names that could not be read. */
  async add(files: File[]): Promise<{ ids: string[]; failed: string[] }> {
    const ids: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        const id = await hashOf(file);
        const canvas = await loadPhoto(file);
        const rec: StoredPhoto = { id, name: file.name, addedAt: Date.now(), blob: await toBlob(canvas, 0.92), thumb: await makeThumb(canvas) };
        let saved = false;
        if (this.db) {
          try {
            if (!(await request(this.db, 'readonly', (s) => s.get(id)))) await request(this.db, 'readwrite', (s) => s.put(rec));
            saved = true;
          } catch {
            saved = false;
          }
        }
        if (!saved && !this.memory.some((m) => m.id === id)) this.memory.push(rec);
        ids.push(id);
      } catch {
        failed.push(file.name);
      }
    }
    return { ids, failed };
  }

  async remove(id: string): Promise<void> {
    const u = this.urls.get(id);
    if (u) {
      URL.revokeObjectURL(u.thumb);
      URL.revokeObjectURL(u.preview);
      this.urls.delete(id);
    }
    this.memory = this.memory.filter((m) => m.id !== id);
    if (this.db) {
      try {
        await request(this.db, 'readwrite', (s) => s.delete(id));
      } catch {
        // nothing more to do
      }
    }
  }

  /** The picture, ready to play (at most 1600 px on its longest side). */
  async load(entry: PhotoEntry): Promise<HTMLCanvasElement> {
    if (entry.sample) return samplePhoto(entry.id);
    const res = await fetch(entry.previewUrl);
    return loadPhoto(await res.blob());
  }
}
