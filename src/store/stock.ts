import { STOCK_NAMES, STOCK_SITES, stockUrl, type StockItem, type StockSite, type StockType } from '../online/protocol';
import { fetchLink, LINK_REFUSED } from './link';

/** Where a picture or video of the library came from: kept with it, so that the credit that its site asks for can be shown wherever it is. */
export interface StockCredit {
  source: StockSite;
  /** The picture's or video's number at the source (to know that it is in the library already). */
  id: string;
  by: string;
  /** The photographer's page and the picture's own page on its site. */
  byUrl: string;
  url: string;
  /** The site says that an AI made it: the picture is shown with a badge wherever it is. */
  ai?: true;
}

export type StockResult = { ok: true; items: StockItem[]; page: number; more: boolean; source: StockSite; sources: StockSite[] } | { ok: false; error: 'offline' | 'busy' | 'unavailable' };

/** An item whose every address is one of its site's own (what the server sends, checked again: the page fetches what these say). */
export function trustedItem(v: unknown): StockItem | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const text = (x: unknown, max: number): string => (typeof x === 'string' ? x.slice(0, max) : '');
  const site = STOCK_SITES.find((s) => s === o.source);
  if (!site) return null;
  const [thumb, preview, file, url, byUrl] = [o.thumb, o.preview, o.file, o.url, o.byUrl].map((a) => stockUrl(site, a));
  if (!thumb || !preview || !file || !url || !byUrl || (o.type !== 'photo' && o.type !== 'video') || typeof o.id !== 'string' || !o.id || !text(o.by, 80)) return null;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return { id: o.id.slice(0, 20), source: site, type: o.type, title: text(o.title, 120) || `${o.type === 'video' ? 'Video' : 'Photo'} by ${text(o.by, 80)}`, by: text(o.by, 80), byUrl, url, thumb, preview, file, fileType: o.type === 'video' ? 'video/mp4' : 'image/jpeg', width: n(o.width), height: n(o.height), duration: n(o.duration), ...(o.ai === true ? { ai: true as const } : {}) };
}

export const stockCredit = (item: StockItem): StockCredit => ({ source: item.source, id: item.id, by: item.by, byUrl: item.byUrl, url: item.url, ...(item.ai ? { ai: true as const } : {}) });

/** One page of the stock library, from the game's own server (an empty `query` shows what is popular; no `source`: the server's first site). */
export async function searchStock(base: string, query: string, type: StockType, page: number, source?: StockSite, signal?: AbortSignal): Promise<StockResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/stock/search?${new URLSearchParams({ q: query, type, page: String(page), ...(source ? { source } : {}) })}`, { signal, credentials: 'omit' });
  } catch {
    return { ok: false, error: 'offline' };
  }
  if (res.status === 429) return { ok: false, error: 'busy' };
  const body: { items?: unknown; page?: unknown; more?: unknown; source?: unknown; sources?: unknown } | null = res.ok ? await res.json().catch(() => null) : null;
  if (!body || !Array.isArray(body.items)) return { ok: false, error: 'unavailable' };
  const items = body.items.map(trustedItem).filter((i): i is StockItem => !!i);
  const sources = Array.isArray(body.sources) ? STOCK_SITES.filter((s) => (body.sources as unknown[]).includes(s)) : [];
  const site = STOCK_SITES.find((s) => s === body.source) ?? sources[0];
  if (!site) return { ok: false, error: 'unavailable' };
  return { ok: true, items, page: typeof body.page === 'number' ? body.page : page, more: body.more === true, source: site, sources: sources.length ? sources : [site] };
}

/** A file name for the library: the title, as the list shows it. */
function fileNameOf(item: StockItem): string {
  const base = item.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || `${item.source} ${item.id}`;
  return `${base}.${item.type === 'video' ? 'mp4' : 'jpg'}`;
}

/** Downloads the file of an item from its site's servers (which allow the page to), telling `onStatus` how far it is. Throws an Error whose message can be shown as it is. */
export async function downloadStock(item: StockItem, onStatus?: (text: string) => void, signal?: AbortSignal): Promise<File> {
  const href = stockUrl(item.source, item.file);
  if (!href) throw new Error('That file cannot be downloaded');
  let got: File;
  try {
    got = await fetchLink(new URL(href), onStatus, signal, item.fileType);
  } catch (e) {
    throw e instanceof Error && e.message !== LINK_REFUSED ? e : new Error(`Could not download that from ${STOCK_NAMES[item.source]}. Check the connection and try again.`);
  }
  return new File([got], fileNameOf(item), { type: item.type === 'video' ? 'video/mp4' : 'image/jpeg' });
}
