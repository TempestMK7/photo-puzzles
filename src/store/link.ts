import { isVideoFile } from '../image';

/** Pulls the picture's own address out of what was pasted: a Google "imgres" or redirect link carries it inside, and a bare "example.com/a.jpg" gets https. */
export function parseLink(text: string, depth = 0): URL | null {
  let s = text.trim().replace(/^<(.*)>$/, '$1').replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^[^/?#]+\.[^/?#]+/.test(s)) return null;
    s = `https://${s}`;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (depth < 2 && /(^|\.)google\.[a-z.]+$/i.test(url.hostname)) {
    const inner = url.pathname === '/imgres' ? url.searchParams.get('imgurl') : url.pathname === '/url' ? url.searchParams.get('url') ?? url.searchParams.get('q') : null;
    const found = inner ? parseLink(inner, depth + 1) : null;
    if (found) return found;
  }
  return url;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/** A file name for what was downloaded: the last part of the address, with an extension that fits the type if it had none. */
export function nameFromLink(url: URL, type: string): string {
  let base = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    base = decodeURIComponent(base);
  } catch {
    // keep it as it is
  }
  base = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || url.hostname;
  const ext = EXT[type];
  return ext && !/\.(jpe?g|png|gif|webp|avif|bmp|mp4|m4v|webm|mov|mkv)$/i.test(base) ? `${base}.${ext}` : base;
}

/** What to tell the player when a link did not work (the page cannot tell a site that refuses from no connection at all). */
export const LINK_REFUSED = 'Could not download that. The site may not allow other pages to take its pictures, or there is no connection. Save the picture and use Add photos instead.';
export const LINK_IS_PAGE = 'That link is a web page, not a picture. Copy the picture\'s own address (touch and hold or right-click the picture, then Copy image address).';

async function fetchOnce(url: URL, signal: AbortSignal): Promise<Response> {
  return fetch(url.href, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
}

/** Downloads a picture or video, telling `onStatus` how far it is. Throws an Error whose message can be shown as it is. */
export async function fetchLink(url: URL, onStatus?: (text: string) => void, signal: AbortSignal = new AbortController().signal): Promise<File> {
  let res: Response;
  try {
    try {
      res = await fetchOnce(url, signal);
    } catch (e) {
      if (url.protocol !== 'http:' || signal.aborted) throw e;
      const secure = new URL(url.href);                  // a page served over https may not ask for http: try the secure address of the same file
      secure.protocol = 'https:';
      res = await fetchOnce(secure, signal);
    }
  } catch {
    throw new Error(LINK_REFUSED);
  }
  if (!res.ok) throw new Error(`The site answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''} for that link`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') throw new Error(LINK_IS_PAGE);
  if (type && !type.startsWith('image/') && !type.startsWith('video/') && type !== 'application/octet-stream' && type !== 'binary/octet-stream') {
    throw new Error('That link is not a picture or a video');
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
  try {
    const reader = res.body?.getReader();
    if (!reader) parts.push(new Uint8Array(await res.arrayBuffer()));
    else {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onStatus?.(total ? `Downloading… ${mb(got)} of ${mb(total)} MB` : `Downloading… ${mb(got)} MB`);
      }
    }
  } catch {
    throw new Error(signal.aborted ? 'Download stopped' : 'The download was cut off');
  }
  const kind = type.startsWith('image/') || type.startsWith('video/') ? type : '';
  const file = new File(parts, nameFromLink(url, kind), { type: kind });
  if (!kind && !isVideoFile(file) && !/\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(file.name)) {
    throw new Error('That link is not a picture or a video');
  }
  return file;
}
