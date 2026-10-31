import { describe, expect, it } from 'vitest';
import { MemoryRates } from '../server/src/memory';
import { DEFAULT_RATES, RateLimiter, type Rates } from '../server/src/ratelimit';
import { createRouter, DevAuth } from '../server/src/router';
import { PexelsStock, pexelsUrl } from '../server/src/stock';
import { GuestTokens, TokenAuth } from '../server/src/guest';
import { world } from './helpers/world';

const photo = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  width: 4000,
  height: 3000,
  url: `https://www.pexels.com/photo/x-${id}/`,
  photographer: 'Ada Lovelace',
  photographer_url: 'https://www.pexels.com/@ada',
  alt: 'A mountain lake at dawn',
  src: {
    original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`,
    large2x: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940`,
    large: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=650&w=940`,
    small: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=130`,
    tiny: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280`,
  },
  ...extra,
});

const file = (width: number, type = 'video/mp4') => ({ file_type: type, width, height: Math.round((width * 9) / 16), link: `https://videos.pexels.com/video-files/7/7-${width}.mp4` });
const video = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  width: 1920,
  height: 1080,
  duration: 20,
  url: `https://www.pexels.com/video/y-${id}/`,
  image: `https://images.pexels.com/videos/${id}/free-video-${id}.jpg?fit=crop&h=630&w=1200`,
  user: { id: 5, name: 'Grace Hopper', url: 'https://www.pexels.com/@grace' },
  video_files: [file(426), file(640), file(960), file(1280), file(1920), file(3840), { file_type: 'application/x-mpegURL', width: 0, height: 0, link: 'https://videos.pexels.com/x.m3u8' }],
  ...extra,
});

/** A stand-in for Pexels: it says what it was asked and answers from a table. */
function fakePexels(answer: (path: string, params: URLSearchParams) => unknown, status = 200) {
  const asked: { path: string; params: URLSearchParams; auth: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    asked.push({ path: u.pathname, params: u.searchParams, auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(answer(u.pathname, u.searchParams)), { status });
  }) as typeof fetch;
  return { asked, fetcher };
}

describe('the stock library: addresses', () => {
  it('lets through only https addresses on pexels.com and below it', () => {
    expect(pexelsUrl('https://images.pexels.com/photos/1/a.jpeg')).toBe('https://images.pexels.com/photos/1/a.jpeg');
    expect(pexelsUrl('https://pexels.com/x')).toBe('https://pexels.com/x');
    for (const bad of ['http://images.pexels.com/a.jpg', 'https://evilpexels.com/a.jpg', 'https://pexels.com.evil.example/a.jpg', 'https://user:pw@images.pexels.com/a', 'javascript:alert(1)', 'https://images.pexels.com.evil.example/', '', 42, null, undefined]) {
      expect(pexelsUrl(bad)).toBeNull();
    }
  });
});

describe('the stock library: what Pexels says, as the game gets it', () => {
  it('turns photos into items (the file to keep, the preview, a small picture, who made it and where)', async () => {
    const pex = fakePexels(() => ({ photos: [photo(11), photo(12, { alt: '' })], next_page: 'https://api.pexels.com/v1/search?page=2' }));
    const stock = new PexelsStock('KEY', { fetch: pex.fetcher });
    const res = await stock.search('mountain lake', 'photo', 1);
    expect(res).toMatchObject({ ok: true, page: 1, more: true });
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({ id: '11', type: 'photo', title: 'A mountain lake at dawn', by: 'Ada Lovelace', byUrl: 'https://www.pexels.com/@ada', url: 'https://www.pexels.com/photo/x-11/', fileType: 'image/jpeg', width: 4000, height: 3000 });
    expect(res.items[0].file).toContain('dpr=2');
    expect(res.items[0].preview).toContain('w=940');
    expect(res.items[0].thumb).toContain('h=130');
    expect(res.items[1].title).toBe('Photo by Ada Lovelace');          // no description: the photographer's name stands in for it
    expect(pex.asked[0]).toMatchObject({ path: '/v1/search', auth: 'KEY' });
    expect(pex.asked[0].params.get('query')).toBe('mountain lake');
  });

  it('asks for what is popular when there is nothing to search for, and for videos from the video endpoints', async () => {
    const pex = fakePexels((path) => (path.startsWith('/videos') ? { videos: [video(21)] } : { photos: [photo(1)] }));
    const stock = new PexelsStock('KEY', { fetch: pex.fetcher });
    await stock.search('  ', 'photo', 1);
    await stock.search('', 'video', 2);
    await stock.search('sea', 'video', 1);
    expect(pex.asked.map((a) => a.path)).toEqual(['/v1/curated', '/videos/popular', '/videos/search']);
    expect(pex.asked[0].params.has('query')).toBe(false);
    expect(pex.asked[1].params.get('page')).toBe('2');
  });

  it('picks a video file of a good size, a small one to preview, leaves out streams, and makes the picture for the list small', async () => {
    const stock = new PexelsStock('KEY', { fetch: fakePexels(() => ({ videos: [video(31)] })).fetcher });
    const res = await stock.search('', 'video', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    const [item] = res.items;
    expect(item).toMatchObject({ id: '31', type: 'video', title: 'Video by Grace Hopper', fileType: 'video/mp4', duration: 20 });
    expect(item.file).toContain('-1280.mp4');
    expect(item.preview).toContain('-640.mp4');
    const thumb = new URL(item.thumb);
    expect([thumb.searchParams.get('w'), thumb.searchParams.get('h')]).toEqual(['160', '160']);
  });

  it('leaves out what cannot be used: a clip that is too long, one with no MP4, addresses that are not Pexels’, and the odd entry that is not an object', async () => {
    const pex = fakePexels(() => ({
      videos: [
        video(41),
        video(42, { duration: 600 }),
        video(43, { video_files: [file(1280, 'video/webm')] }),
        video(44, { image: 'https://evil.example/x.jpg' }),
        video(45, { video_files: [{ ...file(1280), link: 'https://evil.example/a.mp4' }] }),
        null,
        'nope',
      ],
    }));
    const res = await new PexelsStock('KEY', { fetch: pex.fetcher }).search('', 'video', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res.items.map((i) => i.id)).toEqual(['41']);
    const photos = await new PexelsStock('KEY', { fetch: fakePexels(() => ({ photos: [photo(1, { photographer: '' }), photo(2, { url: 'https://evil.example/p' }), photo(3)] })).fetcher }).search('x', 'photo', 1);
    if (typeof photos !== 'object' || !photos) throw new Error('no result');
    expect(photos.items.map((i) => i.id)).toEqual(['3']);
  });

  it('clips what it is asked: the length of the query and the page', async () => {
    const pex = fakePexels(() => ({ photos: [] }));
    const stock = new PexelsStock('KEY', { fetch: pex.fetcher });
    await stock.search('x'.repeat(500), 'photo', 9999);
    await stock.search('y', 'photo', -4);
    expect(pex.asked[0].params.get('query')).toHaveLength(80);
    expect(pex.asked[0].params.get('page')).toBe('20');
    expect(pex.asked[1].params.get('page')).toBe('1');
  });

  it('says that there is no more after the last page of Pexels’ own and the last that it will go to', async () => {
    const stock = new PexelsStock('KEY', { fetch: fakePexels(() => ({ photos: [photo(1)] })).fetcher });
    const res = await stock.search('x', 'photo', 1);
    expect(res).toMatchObject({ more: false });
  });

  it('gives null when Pexels does not answer properly (an error, rubbish, nothing at all)', async () => {
    expect(await new PexelsStock('KEY', { fetch: fakePexels(() => ({ error: 'no' }), 500).fetcher }).search('a', 'photo', 1)).toBeNull();
    expect(await new PexelsStock('KEY', { fetch: fakePexels(() => ({ photos: 'x' })).fetcher }).search('a', 'photo', 1)).toBeNull();
    const down = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await new PexelsStock('KEY', { fetch: down }).search('a', 'photo', 1)).toBeNull();
  });
});

describe('the stock library: keeping answers and sharing the provider’s limit', () => {
  it('keeps an answer for a while (a second asking does not go to Pexels and does not count against the limit) and then asks again', async () => {
    const pex = fakePexels(() => ({ photos: [photo(1)] }));
    let now = 0;
    let counted = 0;
    const stock = new PexelsStock('KEY', { fetch: pex.fetcher, now: () => now, keepMs: 1000 });
    const allow = async () => (counted++, true);
    await stock.search('Lake', 'photo', 1, allow);
    await stock.search('lake', 'photo', 1, allow);
    expect([pex.asked.length, counted]).toEqual([1, 1]);
    await stock.search('lake', 'photo', 2, allow);
    expect(pex.asked.length).toBe(2);
    now = 1500;
    await stock.search('lake', 'photo', 1, allow);
    expect(pex.asked.length).toBe(3);
  });

  it('says busy, and asks nothing of Pexels, when the shared limit is used up', async () => {
    const pex = fakePexels(() => ({ photos: [photo(1)] }));
    const stock = new PexelsStock('KEY', { fetch: pex.fetcher });
    expect(await stock.search('a', 'photo', 1, async () => false)).toBe('busy');
    expect(pex.asked).toHaveLength(0);
  });
});

describe('the stock library on the API', () => {
  const KEY = new Uint8Array(32).fill(7);
  const rates: Rates = { ...DEFAULT_RATES, stockSearch: { perIp: 3, windowMs: 3_600_000 }, stockUpstream: { total: 2, windowMs: 3_600_000 } };

  function setup(withStock = true) {
    const w = world();
    const guests = new GuestTokens(KEY, w.clock);
    const pex = fakePexels(() => ({ photos: [photo(1)] }));
    const limiter = new RateLimiter(new MemoryRates(w.clock), w.clock, rates);
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, limiter, ...(withStock ? { stock: new PexelsStock('KEY', { fetch: pex.fetcher, now: () => w.clock.t }) } : {}) });
    const call = async (query: string, ip = '198.51.100.1') => {
      const res = await route({ method: 'GET', path: '/stock/search', query: new URLSearchParams(query), ip, body: new Uint8Array() });
      return { status: res.status, body: res.body as Record<string, any> };
    };
    return { call, pex, w };
  }

  it('answers anyone, with no sign-in', async () => {
    const { call } = setup();
    const res = await call('q=lake&type=photo');
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ id: '1', type: 'photo' });
  });

  it('is off (503) in a deployment that has no key, and when Pexels does not answer', async () => {
    expect(await setup(false).call('q=a')).toMatchObject({ status: 503, body: { ok: false, error: 'stock-off' } });
    const w = world();
    const guests = new GuestTokens(KEY, w.clock);
    const down = fakePexels(() => ({}), 500);
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, stock: new PexelsStock('KEY', { fetch: down.fetcher }) });
    const res = await route({ method: 'GET', path: '/stock/search', query: new URLSearchParams('q=a'), body: new Uint8Array() });
    expect(res.status).toBe(503);
  });

  it('limits an address, and everybody together for what has to go to Pexels', async () => {
    const { call, pex } = setup();
    expect((await call('q=a')).status).toBe(200);
    expect((await call('q=a')).status).toBe(200);        // kept: it did not use the shared limit
    expect((await call('q=b')).status).toBe(200);        // the second the shared limit lets through
    const slowDown = await call('q=c');                  // the address has asked three times: the fourth is refused...
    expect(slowDown.status).toBe(429);
    expect(slowDown.body).toMatchObject({ ok: false, error: 'rate-limited' });
    expect(pex.asked).toHaveLength(2);
    expect((await call('q=c', '198.51.100.9')).status).toBe(429);          // ...and another address finds the shared limit used up
    expect((await call('q=a', '198.51.100.9')).status).toBe(200);          // while what was kept is still given
  });

  it('takes the type and page from the address', async () => {
    const { call, pex } = setup();
    await call('q=a&type=video&page=3');
    expect(pex.asked[0].path).toBe('/videos/search');
    expect(pex.asked[0].params.get('page')).toBe('3');
  });
});
