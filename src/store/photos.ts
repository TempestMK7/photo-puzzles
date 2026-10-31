import { gifToWebm, isGifFile } from '../gif';
import type { StockCredit } from './stock';
import { isVideoFile, loadPhoto, makeThumb, readVideo } from '../image';

/** One photo in the list. */
export interface PhotoEntry {
  id: string;
  name: string;
  thumbUrl: string;
  /** Object URL of the full picture (or the video file), for the preview. */
  previewUrl: string;
  video: boolean;
  /** Seconds, for a video. */
  duration: number;
  /** Where it came from, for a picture or video of the stock library (the credit is shown with it). */
  credit?: StockCredit;
  /** The id the online server gave this picture or video when it was sent (or when the player joined a puzzle made from it): a puzzle can be made from it again without sending it. */
  serverFile?: string;
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
  credit?: StockCredit;
}

const DB = 'photo-puzzles';
const STORE = 'photos';
/** The order the photos are listed in; with it the keys come back in that order, without reading the pictures. */
const BY_DATE = 'addedAt';
/** How many photos are read from the store at once: the first few, so that the list starts to fill quickly, then more. */
const FIRST_BATCH = 12;
const BATCH = 100;
/** The ids the online server holds the photos under, apart from the photos: a few bytes each, so that one is written without writing the picture again. */
const SERVER_FILES = 'serverFiles';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SERVER_FILES)) req.result.createObjectStore(SERVER_FILES, { keyPath: 'id' });
      const store = req.result.objectStoreNames.contains(STORE) ? req.transaction!.objectStore(STORE) : req.result.createObjectStore(STORE, { keyPath: 'id' });
      if (!store.indexNames.contains(BY_DATE)) store.createIndex(BY_DATE, 'addedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
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
 * The photo library: whatever the player added, kept in the browser's IndexedDB (nothing leaves the device). If the browser refuses storage the
 * photos still work for this visit.
 */
export class PhotoLibrary {
  private db: IDBDatabase | null = null;
  private memory: StoredPhoto[] = [];
  private urls = new Map<string, { thumb?: string; preview?: string }>();
  private serverFiles = new Map<string, string>();

  /** `onRemove` is told when a photo or video is deleted (its saved puzzles go with it). */
  constructor(private readonly onRemove?: (id: string) => Promise<void>) {}

  async init(): Promise<void> {
    try {
      this.db = await open();
      for (const r of await request<{ id: string; fileId: string }[]>(this.db, 'readonly', (s) => s.getAll(), SERVER_FILES)) this.serverFiles.set(r.id, r.fileId);
    } catch {
      this.db = this.db ?? null;
    }
  }

  /** How many of the player's photos there are, those that only live in memory included. */
  private async count(): Promise<number> {
    let n = 0;
    if (this.db) {
      try {
        n = await request<number>(this.db, 'readonly', (s) => s.count());
      } catch {
        n = 0;
      }
    }
    return n + this.memory.length;
  }

  /** The next `size` records in the order they were added, starting at `from` (a date; ones before it are left out). One request for the lot is much cheaper than one each. */
  private async batch(from: number | undefined, size: number): Promise<StoredPhoto[]> {
    if (!this.db) return [];
    try {
      const range = from === undefined ? undefined : IDBKeyRange.lowerBound(from);
      return await request<StoredPhoto[]>(this.db, 'readonly', (s) => s.index(BY_DATE).getAll(range, size));
    } catch {
      return [];
    }
  }

  private async record(id: string): Promise<StoredPhoto | undefined> {
    const kept = this.memory.find((m) => m.id === id);
    if (kept) return kept;
    if (!this.db) return undefined;
    try {
      return await request<StoredPhoto | undefined>(this.db, 'readonly', (s) => s.get(id));
    } catch {
      return undefined;
    }
  }

  /** The object URLs are made when first asked for: making one takes about a millisecond on a phone, and the full picture's is only wanted for the one that is chosen. */
  private entryOf(p: StoredPhoto): PhotoEntry {
    const urls = this.urls;
    const files = this.serverFiles;
    const url = (which: 'thumb' | 'preview', blob: Blob): string => {
      let u = urls.get(p.id);
      if (!u) urls.set(p.id, (u = {}));
      return (u[which] ??= URL.createObjectURL(blob));
    };
    return {
      id: p.id,
      name: p.name,
      get thumbUrl() {
        return url('thumb', p.thumb);
      },
      get previewUrl() {
        return url('preview', p.blob);
      },
      video: !!p.video,
      duration: p.duration ?? 0,
      ...(p.credit ? { credit: p.credit } : {}),
      /** Read when asked: the entry in the list was made before the server gave the picture its id. */
      get serverFile() {
        return files.get(p.id);
      },
    };
  }

  /** Whether this file is in the list already (the id comes from the file's bytes, so the same file added again is not a second photo). */
  async has(file: Blob): Promise<boolean> {
    return !!(await this.idOf(file));
  }

  /** The id of this file in the list, if it is there. */
  async idOf(file: Blob): Promise<string | undefined> {
    const id = await hashOf(file);
    return (await this.record(id)) ? id : undefined;
  }

  /** Remembers (or, with nothing, forgets) the id that the online server holds this photo under. */
  async setServerFile(id: string, fileId: string | undefined): Promise<void> {
    if (this.serverFiles.get(id) === fileId) return;
    if (fileId) this.serverFiles.set(id, fileId);
    else this.serverFiles.delete(id);
    if (!this.db) return;
    try {
      if (fileId) await request(this.db, 'readwrite', (s) => s.put({ id, fileId }), SERVER_FILES);
      else await request(this.db, 'readwrite', (s) => s.delete(id), SERVER_FILES);
    } catch {
      // the photo works as before: the next puzzle sends it again
    }
  }

  /** One photo of the list, or null if it is gone. */
  async entry(id: string): Promise<PhotoEntry | null> {
    const rec = await this.record(id);
    return rec ? this.entryOf(rec) : null;
  }

  /**
   * Hands over the photos of the list one at a time, in order (by date added), waiting for `onEntry` before reading the next, so that a
   * long library can show up as it is read. `total` is how many there will be; it is known before the first.
   */
  async each(onEntry: (entry: PhotoEntry, done: number, total: number) => void | Promise<void>): Promise<void> {
    const total = await this.count();
    let done = 0;
    const seen = new Set<string>();
    let from: number | undefined;
    let size = FIRST_BATCH;                                        // a few first, so that the list starts to fill at once
    for (;;) {
      const recs = await this.batch(from, size);
      let fresh = 0;
      for (const rec of recs) {
        if (seen.has(rec.id)) continue;                            // the date a batch starts at is its last one's: photos added in the same millisecond come twice
        seen.add(rec.id);
        fresh++;
        await onEntry(this.entryOf(rec), ++done, total);
      }
      if (recs.length < size) break;
      from = recs[recs.length - 1].addedAt;
      size = fresh ? BATCH : size * 2;                             // no progress: that many photos share one date
    }
    for (const rec of [...this.memory].sort((a, b) => a.addedAt - b.addedAt)) {
      if (!seen.has(rec.id)) await onEntry(this.entryOf(rec), ++done, total);
    }
  }

  /**
   * Adds picture files; returns the ids that were added (or already there) and the names that could not be read. `onStatus` is told what is going on when it takes a
   * while (an animated GIF is turned into a video). `credit` says where they came from, for files of the stock library.
   */
  async add(files: File[], onStatus?: (text: string) => void, credit?: StockCredit, serverFile?: string): Promise<{ ids: string[]; failed: string[] }> {
    const ids: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        const id = await hashOf(file);
        let rec: StoredPhoto;
        let video: Blob | null = isVideoFile(file) ? file : null;      // a video is kept as it is: the browser plays the file itself
        if (!video && isGifFile(file)) {                               // an animated GIF becomes a video (a still one stays a picture)
          const gif = await gifToWebm(file, (done, total) => onStatus?.(`Converting ${file.name}: frame ${done} of ${total}…`));
          if (gif) video = gif.blob;
        }
        if (video) {
          const info = await readVideo(video);
          rec = { id, name: file.name, addedAt: Date.now(), blob: video, thumb: await makeThumb(info.poster), video: true, duration: Number.isFinite(info.duration) ? info.duration : 0, ...(credit ? { credit } : {}) };
        } else {
          const canvas = await loadPhoto(file);
          rec = { id, name: file.name, addedAt: Date.now(), blob: await toBlob(canvas, 0.92), thumb: await makeThumb(canvas), ...(credit ? { credit } : {}) };
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
        if (serverFile) await this.setServerFile(id, serverFile);
      } catch (e) {
        failed.push(e instanceof Error && e.message ? `${file.name} (${e.message})` : file.name);
      }
    }
    return { ids, failed };
  }

  async remove(id: string): Promise<void> {
    const u = this.urls.get(id);
    if (u) {
      if (u.thumb) URL.revokeObjectURL(u.thumb);
      if (u.preview) URL.revokeObjectURL(u.preview);
      this.urls.delete(id);
    }
    this.memory = this.memory.filter((m) => m.id !== id);
    await this.setServerFile(id, undefined);
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
    const canvas = await loadPhoto(await (await fetch(entry.previewUrl)).blob());
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

export function openVideo(url: string): Promise<PlaySource> {
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
