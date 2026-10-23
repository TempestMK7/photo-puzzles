import { isVideoFile, loadPhoto, makeThumb, readVideo, samplePhoto, SAMPLES } from '../image';

/** One photo in the list: the built-in samples and the player's own. */
export interface PhotoEntry {
  id: string;
  name: string;
  /** Samples are made in code and cannot be removed. */
  sample: boolean;
  thumbUrl: string;
  /** Object URL of the full picture (or the video file), for the preview. */
  previewUrl: string;
  video: boolean;
  /** Seconds, for a video. */
  duration: number;
}

/** What a puzzle draws from: a picture, or a video element whose current frame is drawn. */
export interface PlaySource {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Set for a video: it plays by itself and the screen redraws when it shows a new frame. */
  video: HTMLVideoElement | null;
  dispose(): void;
}

interface StoredPhoto {
  id: string;
  name: string;
  addedAt: number;
  blob: Blob;
  thumb: Blob;
  video?: boolean;
  duration?: number;
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

/** A short id from the file's bytes, so adding the same file twice gives one entry (a video: its size and its first and last megabyte, not all of it). */
async function hashOf(blob: Blob): Promise<string> {
  const MB = 1 << 20;
  const part = blob.size <= 8 * MB ? blob : new Blob([String(blob.size), blob.slice(0, MB), blob.slice(blob.size - MB)]);
  const digest = await crypto.subtle.digest('SHA-256', await part.arrayBuffer());
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

  /** `onRemove` is told when a photo or video is deleted (its saved puzzles go with it). */
  constructor(private readonly onRemove?: (id: string) => Promise<void>) {}

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
      out.push({ id: s.id, name: s.name, sample: true, thumbUrl: u.thumb, previewUrl: u.preview, video: false, duration: 0 });
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
      out.push({ id: p.id, name: p.name, sample: false, thumbUrl: u.thumb, previewUrl: u.preview, video: !!p.video, duration: p.duration ?? 0 });
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
        let rec: StoredPhoto;
        if (isVideoFile(file)) {                                       // a video is kept as it is: the browser plays the file itself
          const info = await readVideo(file);
          rec = { id, name: file.name, addedAt: Date.now(), blob: file, thumb: await makeThumb(info.poster), video: true, duration: Number.isFinite(info.duration) ? info.duration : 0 };
        } else {
          const canvas = await loadPhoto(file);
          rec = { id, name: file.name, addedAt: Date.now(), blob: await toBlob(canvas, 0.92), thumb: await makeThumb(canvas) };
        }
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
    await this.onRemove?.(id);
  }

  /** The picture or video, ready to play (a picture is at most 1600 px on its longest side). */
  async load(entry: PhotoEntry): Promise<PlaySource> {
    if (entry.video) return openVideo(entry.previewUrl);
    const canvas = entry.sample ? samplePhoto(entry.id) : await loadPhoto(await (await fetch(entry.previewUrl)).blob());
    return { source: canvas, width: canvas.width, height: canvas.height, video: null, dispose() {} };
  }
}

/** Some recorders leave a webm without a length (Infinity); seeking far past the end makes the browser work it out. */
export async function settleDuration(v: HTMLVideoElement): Promise<void> {
  if (Number.isFinite(v.duration)) return;
  await new Promise<void>((resolve) => {
    v.addEventListener('durationchange', () => Number.isFinite(v.duration) && resolve(), { once: true });
    v.currentTime = 1e101;
    window.setTimeout(resolve, 3000);
  });
  v.currentTime = 0;
}

function openVideo(url: string): Promise<PlaySource> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.src = url;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.onerror = () => reject(new Error('This browser cannot play that video'));
    v.onloadeddata = async () => {
      await settleDuration(v);
      resolve({
        source: v,
        width: v.videoWidth,
        height: v.videoHeight,
        video: v,
        dispose() {
          v.pause();
          v.removeAttribute('src');
          v.load();
        },
      });
    };
  });
}
