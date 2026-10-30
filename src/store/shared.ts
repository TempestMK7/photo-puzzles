/**
 * Pictures and videos that another app shared with this one (the Android app is in the system's share list). The app that hosts the page says what was shared through
 * `PhotoPuzzlesNative.takeShared()`: a JSON list of `{ url, name, type }`, where `url` is an address on the page's own origin that serves the file (`/shared/...`), and which empties the list
 * (taking is once). It also fires the `photopuzzles-shared` event on the window when something is shared while the page is already open; the page takes what is there when it starts, and again
 * on every event.
 */

export const SHARED_EVENT = 'photopuzzles-shared';

interface Native {
  takeShared?: () => string;
}

interface SharedItem {
  url: string;
  name: string;
  type: string;
}

/** The most that is taken in one share: the system lets an app send a great many, and each is held in memory while it is added. */
export const SHARED_MAX = 50;

function items(raw: unknown): SharedItem[] {
  let list: unknown;
  try {
    list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: SharedItem[] = [];
  for (const it of list) {
    const { url, name, type } = (it ?? {}) as Record<string, unknown>;
    // only what the app itself serves under its own address: the list is the host app's word, and a page address is not something to fetch from it
    if (typeof url !== 'string' || !/^\/shared\/[^/]+\/[^/]*$/.test(url)) continue;
    out.push({ url, name: typeof name === 'string' && name ? name : 'Shared', type: typeof type === 'string' ? type : '' });
    if (out.length === SHARED_MAX) break;
  }
  return out;
}

/** Takes what was shared (nothing, if nothing was, or if this is not the app) as files that the library can add. A file that cannot be read is left out. */
export async function takeShared(
  host: Native | undefined = typeof window === 'undefined' ? undefined : (window as unknown as { PhotoPuzzlesNative?: Native }).PhotoPuzzlesNative,
  get: typeof fetch = (...a) => fetch(...a),
): Promise<File[]> {
  if (typeof host?.takeShared !== 'function') return [];
  let list: SharedItem[];
  try {
    list = items(host.takeShared());
  } catch {
    return [];
  }
  const files: File[] = [];
  for (const it of list) {
    try {
      const res = await get(it.url);
      if (!res.ok) continue;
      const blob = await res.blob();
      files.push(new File([blob], it.name, { type: it.type || blob.type }));
    } catch {
      /* it went away (the app that shared it took it back): the others are still added */
    }
  }
  return files;
}

/** Adds what is shared now, and whatever is shared later while the page is open. `add` is the library's way of adding files. */
export function listenForShared(add: (files: File[]) => Promise<void>): void {
  const run = async () => {
    const files = await takeShared();
    if (files.length) await add(files);
  };
  window.addEventListener(SHARED_EVENT, () => void run());
  void run();
}
