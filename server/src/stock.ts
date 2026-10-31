import { pexelsUrl, type StockItem, type StockResponse, type StockType } from '../../src/online/protocol';

export { pexelsUrl };

/**
 * The library of stock pictures and videos that the game offers beside the player's own (Pexels, whose own checking of what it publishes stands in for ours). The game asks this
 * server and not Pexels itself so that the key stays a secret, the answers can be kept for a while, and one provider limit is shared fairly. The files themselves are fetched by the
 * game straight from Pexels' own servers (which allow that); none of them pass through here.
 */
export interface StockSource {
  /**
   * One page of results (`query` empty: what Pexels is showing now). `allow` is asked before the provider is, and only then (an answer we kept does not count): false means the limit
   * on the provider is used up, which comes back as 'busy'. Null: the provider did not answer.
   */
  search(query: string, type: StockType, page: number, allow?: () => Promise<boolean>): Promise<StockResponse | 'busy' | null>;
}

const PHOTOS_PER_PAGE = 24;
const VIDEOS_PER_PAGE = 18;
const MAX_PAGE = 20;
const KEPT = 200;
/** A clip longer than this is left out: it would not make an online puzzle anyway, and it is a big download. */
const MAX_VIDEO_SECONDS = 120;
/** The size of video that makes a good puzzle (wide enough to cut into many pieces, not so big as to be slow on a phone). */
const GOOD_WIDTH = 1280;
const PREVIEW_WIDTH = 640;

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A small square version of a Pexels picture (their image servers resize by the address). */
function small(v: unknown): string | null {
  const href = pexelsUrl(v);
  if (!href) return null;
  const u = new URL(href);
  if (u.hostname !== 'images.pexels.com') return href;
  for (const [k, val] of Object.entries({ auto: 'compress', cs: 'tinysrgb', fit: 'crop', w: '160', h: '160' })) u.searchParams.set(k, val);
  return u.href;
}

function photoItem(p: unknown): StockItem | null {
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

function videoItem(v: unknown): StockItem | null {
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
  // the file that is nearest to a good size without being huge; and, for the preview, the smallest one that still looks fine
  const sorted = [...files].sort((a, b) => a.width - b.width);
  const wanted = sorted.filter((f) => f.width <= 1920);
  const best = (wanted.length ? wanted : sorted.slice(0, 1)).reduce((a, b) => (Math.abs(b.width - GOOD_WIDTH) < Math.abs(a.width - GOOD_WIDTH) ? b : a));
  const preview = sorted.find((f) => f.width >= PREVIEW_WIDTH) ?? sorted[0];
  const thumb = small(o.image);
  const url = pexelsUrl(o.url);
  const by = text(user?.name, 80);
  if (!thumb || !url || !by || !num(o.id)) return null;
  return {
    id: String(num(o.id)),
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

export interface PexelsOptions {
  fetch?: typeof fetch;
  base?: string;
  now?: () => number;
  /** How long an answer is kept, in ms. */
  keepMs?: number;
}

/** Pexels' API (https://www.pexels.com/api/documentation/): a search, or what is popular when there is nothing to search for. */
export class PexelsStock implements StockSource {
  private readonly kept = new Map<string, { at: number; res: StockResponse }>();
  private readonly get: typeof fetch;
  private readonly base: string;
  private readonly now: () => number;
  private readonly keepMs: number;

  constructor(private readonly key: string, options: PexelsOptions = {}) {
    this.get = options.fetch ?? fetch;
    this.base = (options.base ?? 'https://api.pexels.com').replace(/\/+$/, '');
    this.now = options.now ?? Date.now;
    this.keepMs = options.keepMs ?? 10 * 60 * 1000;
  }

  async search(query: string, type: StockType, page: number, allow?: () => Promise<boolean>): Promise<StockResponse | 'busy' | null> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, 80);
    const p = Math.min(MAX_PAGE, Math.max(1, Math.floor(page) || 1));
    const id = `${type}|${q.toLowerCase()}|${p}`;
    const had = this.kept.get(id);
    if (had && this.now() - had.at < this.keepMs) return had.res;
    if (allow && !(await allow())) return 'busy';
    const perPage = type === 'photo' ? PHOTOS_PER_PAGE : VIDEOS_PER_PAGE;
    const path = type === 'photo' ? (q ? '/v1/search' : '/v1/curated') : q ? '/videos/search' : '/videos/popular';
    const params = new URLSearchParams({ ...(q ? { query: q } : {}), per_page: String(perPage), page: String(p) });
    let json: unknown;
    try {
      const res = await this.get(`${this.base}${path}?${params}`, { headers: { Authorization: this.key }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      json = await res.json();
    } catch {
      return null;
    }
    const o = rec(json);
    const list = type === 'photo' ? o?.photos : o?.videos;
    if (!o || !Array.isArray(list)) return null;
    const items = list.map(type === 'photo' ? photoItem : videoItem).filter((i): i is StockItem => !!i);
    const res: StockResponse = { ok: true, items, page: p, more: typeof o.next_page === 'string' && p < MAX_PAGE };
    this.kept.set(id, { at: this.now(), res });
    while (this.kept.size > KEPT) this.kept.delete(this.kept.keys().next().value as string);
    return res;
  }
}
