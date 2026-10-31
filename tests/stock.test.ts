import { describe, expect, it } from 'vitest';
import { MemoryRates } from '../server/src/memory';
import { DEFAULT_RATES, RateLimiter, type Rates } from '../server/src/ratelimit';
import { createRouter, DevAuth } from '../server/src/router';
import { PexelsStock, PixabayStock, pexelsUrl, pixabayUrl } from '../server/src/stock';
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
  const rates: Rates = { ...DEFAULT_RATES, stockSearch: { perIp: 3, windowMs: 3_600_000 }, stockUpstream: { pexels: { total: 2, windowMs: 3_600_000 }, pixabay: { total: 2, windowMs: 3_600_000 } } };

  function setup(withStock = true) {
    const w = world();
    const guests = new GuestTokens(KEY, w.clock);
    const pex = fakePexels(() => ({ photos: [photo(1)] }));
    const limiter = new RateLimiter(new MemoryRates(w.clock), w.clock, rates);
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, limiter, ...(withStock ? { stock: { pexels: new PexelsStock('KEY', { fetch: pex.fetcher, now: () => w.clock.t }) } } : {}) });
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
    expect(res.body.items[0]).toMatchObject({ id: '1', type: 'photo', source: 'pexels' });
    expect(res.body).toMatchObject({ source: 'pexels', sources: ['pexels'] });
  });

  it('is off (503) in a deployment that has no key, and when Pexels does not answer', async () => {
    expect(await setup(false).call('q=a')).toMatchObject({ status: 503, body: { ok: false, error: 'stock-off' } });
    const w = world();
    const guests = new GuestTokens(KEY, w.clock);
    const down = fakePexels(() => ({}), 500);
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, stock: { pexels: new PexelsStock('KEY', { fetch: down.fetcher }) } });
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

// ---------------------------------------------------------------------------------------------------------------- Pixabay

const hit = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  pageURL: `https://pixabay.com/photos/tree-nature-${id}/`,
  type: 'photo',
  tags: 'tree, nature, landscape, sky',
  previewURL: `https://cdn.pixabay.com/photo/2015/04/23/22/00/tree-${id}_150.jpg`,
  webformatURL: `https://pixabay.com/get/g1234_640.jpg`,
  largeImageURL: `https://pixabay.com/get/g1234_1280.jpg`,
  imageWidth: 5000,
  imageHeight: 3333,
  user_id: 77,
  user: 'Some User',
  ...extra,
});

const vsize = (width: number, size = 5_000_000) => ({ url: `https://cdn.pixabay.com/video/2020/01/01/5-${width}.mp4`, width, height: Math.round((width * 9) / 16), size, thumbnail: `https://cdn.pixabay.com/video/2020/01/01/5-${width}.jpg` });
const vhit = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  pageURL: `https://pixabay.com/videos/waves-sea-${id}/`,
  type: 'film',
  tags: 'waves, sea',
  duration: 15,
  videos: { large: vsize(3840, 90_000_000), medium: vsize(1920), small: vsize(1280), tiny: vsize(960, 2_000_000) },
  user_id: 8,
  user: 'Wave Maker',
  ...extra,
});

describe('the stock library: Pixabay', () => {
  it('lets through only https addresses on pixabay.com and below it', () => {
    expect(pixabayUrl('https://cdn.pixabay.com/photo/a.jpg')).toBe('https://cdn.pixabay.com/photo/a.jpg');
    expect(pixabayUrl('https://pixabay.com/photos/x/')).toBe('https://pixabay.com/photos/x/');
    for (const bad of ['http://cdn.pixabay.com/a.jpg', 'https://evilpixabay.com/a', 'https://pixabay.com.evil.example/a', 'https://images.pexels.com/a.jpg']) expect(pixabayUrl(bad)).toBeNull();
    expect(pexelsUrl('https://cdn.pixabay.com/a.jpg')).toBeNull();
  });

  it('turns pictures into items: the tags as a title, the largest size to keep, the small one for the list, the user page', async () => {
    const pex = fakePexels(() => ({ total: 500, totalHits: 400, hits: [hit(1), hit(2, { tags: '' })] }));
    const res = await new PixabayStock('KEY', { fetch: pex.fetcher }).search('tree', 'photo', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res).toMatchObject({ ok: true, page: 1, more: true });
    expect(res.items[0]).toMatchObject({ id: '1', source: 'pixabay', type: 'photo', title: 'Tree, nature, landscape', by: 'Some User', byUrl: 'https://pixabay.com/users/Some%20User-77/', fileType: 'image/jpeg', width: 5000, height: 3333 });
    expect(res.items[0].file).toContain('1280');
    expect(res.items[0].thumb).toContain('150');
    expect(res.items[1].title).toBe('Photo by Some User');
    // what was asked: the key, the query, safe search on, and a photo
    expect(pex.asked[0].path).toBe('/api/');
    const p = pex.asked[0].params;
    expect([p.get('key'), p.get('q'), p.get('safesearch'), p.get('image_type'), p.get('page')]).toEqual(['KEY', 'tree', 'true', 'photo', '1']);
  });

  it('knows there is no more at the end of the hits, and asks the video endpoint for videos', async () => {
    const pex = fakePexels(() => ({ totalHits: 5, hits: [vhit(9)] }));
    const stock = new PixabayStock('KEY', { fetch: pex.fetcher });
    const res = await stock.search('', 'video', 1);
    expect(res).toMatchObject({ more: false });
    expect(pex.asked[0].path).toBe('/api/videos/');
    expect(pex.asked[0].params.has('q')).toBe(false);
    expect(pex.asked[0].params.get('safesearch')).toBe('true');
  });

  it('picks a video file of a good size, a smaller one to preview, and a picture from the file it keeps', async () => {
    const res = await new PixabayStock('KEY', { fetch: fakePexels(() => ({ totalHits: 1, hits: [vhit(9)] })).fetcher }).search('', 'video', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    const [item] = res.items;
    expect(item).toMatchObject({ id: '9', source: 'pixabay', type: 'video', title: 'Waves, sea', duration: 15, width: 1280 });
    expect(item.file).toContain('-1280.mp4');
    expect(item.preview).toContain('-960.mp4');
    expect(item.thumb).toContain('-1280.jpg');
  });

  it('leaves out a clip that is too long, one with no usable file, and (when its length is not told) one that is a huge file', async () => {
    const noLength = (id: number, size: number) => vhit(id, { duration: undefined, videos: { small: vsize(1280, size) } });
    const pex = fakePexels(() => ({ totalHits: 9, hits: [vhit(1), vhit(2, { duration: 600 }), vhit(3, { videos: {} }), noLength(4, 5_000_000), noLength(5, 200_000_000), vhit(6, { videos: { small: { ...vsize(1280), url: 'https://evil.example/a.mp4' } } })] }));
    const res = await new PixabayStock('KEY', { fetch: pex.fetcher }).search('', 'video', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res.items.map((i) => i.id)).toEqual(['1', '4']);
  });

  it('keeps an answer for a day (the site asks for that), and not a minute less', async () => {
    const pex = fakePexels(() => ({ totalHits: 1, hits: [hit(1)] }));
    let now = 0;
    const stock = new PixabayStock('KEY', { fetch: pex.fetcher, now: () => now });
    await stock.search('a', 'photo', 1);
    now = 23 * 3_600_000;
    await stock.search('a', 'photo', 1);
    expect(pex.asked).toHaveLength(1);
    now = 24 * 3_600_000 + 1;
    await stock.search('a', 'photo', 1);
    expect(pex.asked).toHaveLength(2);
  });

  it('gives null when the site does not answer properly', async () => {
    expect(await new PixabayStock('KEY', { fetch: fakePexels(() => 'nope', 429).fetcher }).search('a', 'photo', 1)).toBeNull();
    expect(await new PixabayStock('KEY', { fetch: fakePexels(() => ({ hits: 'x' })).fetcher }).search('a', 'photo', 1)).toBeNull();
  });
});

describe('the stock library with two sites', () => {
  const KEY = new Uint8Array(32).fill(7);

  function setup() {
    const w = world();
    const guests = new GuestTokens(KEY, w.clock);
    const px = fakePexels(() => ({ photos: [photo(1)] }));
    const pb = fakePexels(() => ({ totalHits: 1, hits: [hit(2)] }));
    const limiter = new RateLimiter(new MemoryRates(w.clock), w.clock, { ...DEFAULT_RATES, stockUpstream: { pexels: { total: 1, windowMs: 3_600_000 }, pixabay: { total: 5, windowMs: 3_600_000 } } });
    const stock = { pexels: new PexelsStock('A', { fetch: px.fetcher }), pixabay: new PixabayStock('B', { fetch: pb.fetcher }) };
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, limiter, stock });
    const call = async (query: string) => {
      const res = await route({ method: 'GET', path: '/stock/search', query: new URLSearchParams(query), ip: '198.51.100.1', body: new Uint8Array() });
      return { status: res.status, body: res.body as Record<string, any> };
    };
    return { call, px, pb };
  }

  it('asks the site the page names, the first one there is when it names none or one that is not there, and says which sites there are', async () => {
    const { call, px, pb } = setup();
    expect((await call('q=a&source=pixabay')).body).toMatchObject({ source: 'pixabay', sources: ['pexels', 'pixabay'], items: [{ id: '2', source: 'pixabay' }] });
    expect((await call('q=b')).body).toMatchObject({ source: 'pexels', items: [{ id: '1', source: 'pexels' }] });
    expect([px.asked.length, pb.asked.length]).toEqual([1, 1]);
    expect((await call('q=c&source=nowhere')).status).toBe(429);          // (it asked Pexels, whose one allowed request is used up)
  });

  it('counts each site’s own limit apart', async () => {
    const { call } = setup();
    expect((await call('q=a')).status).toBe(200);                          // Pexels: its one
    expect((await call('q=b')).status).toBe(429);                          // Pexels is used up...
    expect((await call('q=b&source=pixabay')).status).toBe(200);          // ...and Pixabay is not
  });

  it('works with only Pixabay, which is then the one that is asked, and with none (off)', async () => {
    const w = world();
    const guests = new GuestTokens(KEY, w.clock);
    const pb = fakePexels(() => ({ totalHits: 1, hits: [hit(2)] }));
    const mk = (stock: object) => createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, stock });
    const only = await mk({ pixabay: new PixabayStock('B', { fetch: pb.fetcher }) })({ method: 'GET', path: '/stock/search', query: new URLSearchParams('q=a&source=pexels'), body: new Uint8Array() });
    expect(only.body).toMatchObject({ source: 'pixabay', sources: ['pixabay'] });
    const none = await mk({})({ method: 'GET', path: '/stock/search', query: new URLSearchParams('q=a'), body: new Uint8Array() });
    expect(none).toMatchObject({ status: 503, body: { error: 'stock-off' } });
  });
});
