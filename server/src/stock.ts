import { pexelsUrl, pixabayUrl, STOCK_SITES, type StockItem, type StockSite, type StockType } from '../../src/online/protocol';

export { pexelsUrl, pixabayUrl };

/**
 * The library of stock pictures and videos that the game offers beside the player's own (Pexels and Pixabay, whose own checking of what they publish stands in for ours). The game asks
 * this server and not the sites themselves so that the keys stay secret, the answers can be kept for a while, and each site's limit is shared fairly. The files themselves are fetched by
 * the game straight from the sites' own servers (which allow that); none of them pass through here.
 */

/** One page of results. */
export interface StockPage {
  ok: true;
  items: StockItem[];
  page: number;
  more: boolean;
}

export interface StockProvider {
  /**
   * One page of results (`query` empty: what the site is showing now). `allow` is asked before the site is, and only then (an answer we kept does not count): false means the limit
   * on the site is used up, which comes back as 'busy'. Null: the site did not answer.
   */
  search(query: string, type: StockType, page: number, allow?: () => Promise<boolean>): Promise<StockPage | 'busy' | null>;
}

/** The providers that this server has a key for. */
export type StockProviders = Partial<Record<StockSite, StockProvider>>;

/** The sites in the order that the first one that is there is the one that is asked when the page does not say. */
export const stockSitesOf = (providers: StockProviders): StockSite[] => STOCK_SITES.filter((s) => providers[s]);

const PHOTOS_PER_PAGE = 24;
const VIDEOS_PER_PAGE = 18;
const MAX_PAGE = 20;
const KEPT = 300;
/** A clip longer than this is left out: it would not make an online puzzle anyway, and it is a big download. */
const MAX_VIDEO_SECONDS = 120;
/** The most a video file may be when its length is not told (Pixabay does not always say). */
const MAX_VIDEO_BYTES = 60_000_000;
/** The size of video that makes a good puzzle (wide enough to cut into many pieces, not so big as to be slow on a phone). */
const GOOD_WIDTH = 1280;
const PREVIEW_WIDTH = 640;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Of the video files, the one nearest to a good size without being huge, and the smallest one that still looks fine in a preview. */
function chooseFiles<T extends { width: number }>(files: T[]): { best: T; preview: T } {
  const sorted = [...files].sort((a, b) => a.width - b.width);
  const wanted = sorted.filter((f) => f.width <= 1920);
  const best = (wanted.length ? wanted : sorted.slice(0, 1)).reduce((a, b) => (Math.abs(b.width - GOOD_WIDTH) < Math.abs(a.width - GOOD_WIDTH) ? b : a));
  return { best, preview: sorted.find((f) => f.width >= PREVIEW_WIDTH) ?? sorted[0] };
}

export interface ProviderOptions {
  fetch?: typeof fetch;
  base?: string;
  now?: () => number;
  /** How long an answer is kept, in ms. */
  keepMs?: number;
}

/** What every site has in common: keeping answers, asking `allow` first, clipping the query and the page, and giving null when the site does not answer properly. */
abstract class CachedStock implements StockProvider {
  private readonly kept = new Map<string, { at: number; res: StockPage }>();
  protected readonly get: typeof fetch;
  protected readonly base: string;
  private readonly now: () => number;
  private readonly keepMs: number;

  constructor(base: string, keepMs: number, options: ProviderOptions) {
    this.get = options.fetch ?? fetch;
    this.base = (options.base ?? base).replace(/\/+$/, '');
    this.now = options.now ?? Date.now;
    this.keepMs = options.keepMs ?? keepMs;
  }

  /** The request for this search. */
  protected abstract request(query: string, type: StockType, page: number): { url: string; init: RequestInit };
  /** The items and whether there is a next page, from the site's answer; null if the answer is not what the site says it sends. */
  protected abstract parse(json: unknown, type: StockType, page: number): { items: StockItem[]; more: boolean } | null;

  async search(query: string, type: StockType, page: number, allow?: () => Promise<boolean>): Promise<StockPage | 'busy' | null> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 80);
    const p = Math.min(MAX_PAGE, Math.max(1, Math.floor(page) || 1));
    const id = `${type}|${q.toLowerCase()}|${p}`;
    const had = this.kept.get(id);
    if (had && this.now() - had.at < this.keepMs) return had.res;
    if (allow && !(await allow())) return 'busy';
    let json: unknown;
    try {
      const { url, init } = this.request(q, type, p);
      const res = await this.get(url, { ...init, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      json = await res.json();
    } catch {
      return null;
    }
    const parsed = this.parse(json, type, p);
    if (!parsed) return null;
    const res: StockPage = { ok: true, items: parsed.items, page: p, more: parsed.more && p < MAX_PAGE };
    this.kept.set(id, { at: this.now(), res });
    while (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value as string);
    return res;
  }
}

// ---------------------------------------------------------------------------------------------------------------- Pexels

/** A small square version of a Pexels picture (their image servers resize by the address). */
function small(v: unknown): string | null {
  const href = pexelsUrl(v);
  if (!href) return null;
  const u = new URL(href);
  if (u.hostname !== 'images.pexels.com') return href;
  for (const [k, val] of Object.entries({ auto: 'compress', cs: 'tinysrgb', fit: 'crop', w: '160', h: '160' })) u.searchParams.set(k, val);
  return u.href;
}

function pexelsPhoto(p: unknown): StockItem | null {
  const o = rec(p);
  const src = rec(o?.src);
  if (!o || !src) return null;
  const file = pexelsUrl(src.large2x) ?? pexelsUrl(src.large);
  const preview = pexelsUrl(src.large) ?? file;
  const thumb = pexelsUrl(src.small) ?? pexelsUrl(src.tiny);
  const url = pexelsUrl(o.url);
  const by = text(o.photographer, 80);
  if (!file || !preview || !thumb || !url || !by || !num(o.id)) return null;
  return {
    id: String(num(o.id)),
    source: 'pexels',
    type: 'photo',
    title: text(o.alt, 100) || `Photo by ${by}`,
    by,
    byUrl: pexelsUrl(o.photographer_url) ?? url,
    url,
    thumb,
    preview,
    file,
    fileType: 'image/jpeg',
    width: num(o.width),
    height: num(o.height),
    duration: 0,
  };
}

function pexelsVideo(v: unknown): StockItem | null {
  const o = rec(v);
  if (!o) return null;
  const user = rec(o.user);
  const duration = num(o.duration);
  if (duration <= 0 || duration > MAX_VIDEO_SECONDS) return null;
  const files = (Array.isArray(o.video_files) ? o.video_files : [])
    .map((f) => {
      const r = rec(f);
      const link = pexelsUrl(r?.link);
      return r && link && r.file_type === 'video/mp4' && num(r.width) > 0 ? { link, width: num(r.width) } : null;
    })
    .filter((f): f is { link: string; width: number } => !!f);
  if (!files.length) return null;
  const { best, preview } = chooseFiles(files);
  const thumb = small(o.image);
  const url = pexelsUrl(o.url);
  const by = text(user?.name, 80);
  if (!thumb || !url || !by || !num(o.id)) return null;
  return {
    id: String(num(o.id)),
    source: 'pexels',
    type: 'video',
    title: `Video by ${by}`,
    by,
    byUrl: pexelsUrl(user?.url) ?? url,
    url,
    thumb,
    preview: preview.link,
    file: best.link,
    fileType: 'video/mp4',
    width: num(o.width),
    height: num(o.height),
    duration,
  };
}

/** Pexels' API (https://www.pexels.com/api/documentation/): a search, or what is popular when there is nothing to search for. */
export class PexelsStock extends CachedStock {
  constructor(private readonly key: string, options: ProviderOptions = {}) {
    super('https://api.pexels.com', 10 * 60 * 1000, options);
  }

  protected request(q: string, type: StockType, page: number): { url: string; init: RequestInit } {
    const path = type === 'photo' ? (q ? '/v1/search' : '/v1/curated') : q ? '/videos/search' : '/videos/popular';
    const params = new URLSearchParams({ ...(q ? { query: q } : {}), per_page: String(type === 'photo' ? PHOTOS_PER_PAGE : VIDEOS_PER_PAGE), page: String(page) });
    return { url: `${this.base}${path}?${params}`, init: { headers: { Authorization: this.key } } };
  }

  protected parse(json: unknown, type: StockType): { items: StockItem[]; more: boolean } | null {
    const o = rec(json);
    const list = type === 'photo' ? o?.photos : o?.videos;
    if (!o || !Array.isArray(list)) return null;
    return { items: list.map(type === 'photo' ? pexelsPhoto : pexelsVideo).filter((i): i is StockItem => !!i), more: typeof o.next_page === 'string' };
  }
}

// ---------------------------------------------------------------------------------------------------------------- Pixabay

/** The tags that Pixabay gives a picture ("tree, nature, landscape"), as a title. */
function tagsTitle(tags: unknown, fallback: string): string {
  const t = text(tags, 120)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  return t ? t[0].toUpperCase() + t.slice(1) : fallback;
}

/** Where a Pixabay user's page is (their name and number make the address). */
const userPage = (name: string, id: number): string | null => (id > 0 ? pixabayUrl(`https://pixabay.com/users/${encodeURIComponent(name)}-${id}/`) : null);

function pixabayPhoto(p: unknown): StockItem | null {
  const o = rec(p);
  if (!o) return null;
  const by = text(o.user, 80);
  const url = pixabayUrl(o.pageURL);
  const thumb = pixabayUrl(o.previewURL) ?? pixabayUrl(o.webformatURL);
  const file = pixabayUrl(o.largeImageURL) ?? pixabayUrl(o.webformatURL);
  if (!by || !url || !thumb || !file || !num(o.id)) return null;
  return {
    id: String(num(o.id)),
    source: 'pixabay',
    type: 'photo',
    title: tagsTitle(o.tags, `Photo by ${by}`),
    by,
    byUrl: userPage(by, num(o.user_id)) ?? url,
    url,
    thumb,
    preview: file,
    file,
    fileType: 'image/jpeg',
    width: num(o.imageWidth),
    height: num(o.imageHeight),
    duration: 0,
  };
}

function pixabayVideo(v: unknown): StockItem | null {
  const o = rec(v);
  const sizes = rec(o?.videos);
  if (!o || !sizes) return null;
  const duration = num(o.duration);
  if (duration > MAX_VIDEO_SECONDS) return null;
  const files = ['large', 'medium', 'small', 'tiny']
    .map((name) => {
      const r = rec(sizes[name]);
      const link = pixabayUrl(r?.url);
      // when the length is not told, the size of the file is what keeps a huge one out
      return r && link && num(r.width) > 0 && num(r.size) > 0 && (duration > 0 || num(r.size) <= MAX_VIDEO_BYTES) ? { link, width: num(r.width), height: num(r.height), thumb: pixabayUrl(r.thumbnail) } : null;
    })
    .filter((f): f is { link: string; width: number; height: number; thumb: string | null } => !!f);
  if (!files.length) return null;
  const { best, preview } = chooseFiles(files);
  const by = text(o.user, 80);
  const url = pixabayUrl(o.pageURL);
  const thumb = best.thumb ?? preview.thumb ?? files.find((f) => f.thumb)?.thumb;
  if (!by || !url || !thumb || !num(o.id)) return null;
  return {
    id: String(num(o.id)),
    source: 'pixabay',
    type: 'video',
    title: tagsTitle(o.tags, `Video by ${by}`),
    by,
    byUrl: userPage(by, num(o.user_id)) ?? url,
    url,
    thumb,
    preview: preview.link,
    file: best.link,
    fileType: 'video/mp4',
    width: best.width,
    height: best.height,
    duration,
  };
}

/**
 * Pixabay's API (https://pixabay.com/api/docs/): a search, or what is popular when there is nothing to search for. Its terms ask that answers are kept for 24 hours, that its pictures
 * are not hotlinked for good (the game downloads what is played, and shows the addresses of a search only while it is on the screen) and that results say where they are from; the
 * safe search is on.
 */
export class PixabayStock extends CachedStock {
  constructor(private readonly key: string, options: ProviderOptions = {}) {
    super('https://pixabay.com/api', 24 * 60 * 60 * 1000, options);
  }

  protected request(q: string, type: StockType, page: number): { url: string; init: RequestInit } {
    const params = new URLSearchParams({
      key: this.key,
      ...(q ? { q } : {}),
      ...(type === 'photo' ? { image_type: 'photo' } : { video_type: 'all' }),
      safesearch: 'true',
      page: String(page),
      per_page: String(type === 'photo' ? PHOTOS_PER_PAGE : VIDEOS_PER_PAGE),
    });
    return { url: `${this.base}${type === 'photo' ? '/' : '/videos/'}?${params}`, init: {} };
  }

  protected parse(json: unknown, type: StockType, page: number): { items: StockItem[]; more: boolean } | null {
    const o = rec(json);
    if (!o || !Array.isArray(o.hits)) return null;
    const perPage = type === 'photo' ? PHOTOS_PER_PAGE : VIDEOS_PER_PAGE;
    return { items: o.hits.map(type === 'photo' ? pixabayPhoto : pixabayVideo).filter((i): i is StockItem => !!i), more: page * perPage < num(o.totalHits) };
  }
}
