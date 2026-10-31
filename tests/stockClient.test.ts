import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StockItem } from '../src/online/protocol';
import { downloadStock, searchStock, stockCredit, trustedItem } from '../src/store/stock';

const item = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '417074',
  type: 'photo',
  title: 'A lake',
  by: 'Ada',
  byUrl: 'https://www.pexels.com/@ada',
  url: 'https://www.pexels.com/photo/lake-417074/',
  thumb: 'https://images.pexels.com/photos/417074/a.jpeg?h=130',
  preview: 'https://images.pexels.com/photos/417074/a.jpeg?w=940',
  file: 'https://images.pexels.com/photos/417074/a.jpeg?dpr=2&w=940',
  fileType: 'image/jpeg',
  width: 4000,
  height: 3000,
  duration: 0,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('what the page trusts of the stock library', () => {
  it('takes an item whose addresses are all Pexels’, and refuses one with any other (the page fetches what these say)', () => {
    expect(trustedItem(item())).toMatchObject({ id: '417074', type: 'photo', file: 'https://images.pexels.com/photos/417074/a.jpeg?dpr=2&w=940' });
    for (const bad of [{ file: 'https://evil.example/a.jpg' }, { thumb: 'http://images.pexels.com/a.jpg' }, { preview: 'https://pexels.com.evil.example/a' }, { url: 'javascript:alert(1)' }, { byUrl: undefined }, { type: 'audio' }, { id: '' }, { by: '' }]) {
      expect(trustedItem(item(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(trustedItem(null)).toBeNull();
    expect(trustedItem('x')).toBeNull();
  });

  it('gives a title when there is none, and says what the file is from the type', () => {
    expect(trustedItem(item({ title: '' }))?.title).toBe('Photo by Ada');
    const v = trustedItem(item({ type: 'video', title: '', fileType: 'image/png', duration: 12 }));
    expect(v).toMatchObject({ title: 'Video by Ada', fileType: 'video/mp4', duration: 12 });
  });

  it('keeps the credit that Pexels asks for with a picture', () => {
    expect(stockCredit(trustedItem(item()) as StockItem)).toEqual({ source: 'pexels', id: '417074', by: 'Ada', byUrl: 'https://www.pexels.com/@ada', url: 'https://www.pexels.com/photo/lake-417074/' });
  });
});

describe('searching the stock library', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('asks the server, and keeps only the items it can trust', async () => {
    const f = answer(200, { ok: true, items: [item(), item({ file: 'https://evil.example/x.jpg' })], page: 2, more: true });
    vi.stubGlobal('fetch', f);
    const res = await searchStock('https://api.example', 'a lake', 'video', 2);
    expect(res).toMatchObject({ ok: true, page: 2, more: true });
    expect(res.ok && res.items).toHaveLength(1);
    const asked = new URL((f.mock.calls[0] as unknown as [string])[0]);
    expect(asked.pathname).toBe('/stock/search');
    expect([asked.searchParams.get('q'), asked.searchParams.get('type'), asked.searchParams.get('page')]).toEqual(['a lake', 'video', '2']);
  });

  it('tells apart the library being busy, being off, and there being no connection', async () => {
    vi.stubGlobal('fetch', answer(429, { ok: false, error: 'rate-limited' }));
    expect(await searchStock('https://api.example', '', 'photo', 1)).toEqual({ ok: false, error: 'busy' });
    vi.stubGlobal('fetch', answer(503, { ok: false, error: 'stock-off' }));
    expect(await searchStock('https://api.example', '', 'photo', 1)).toEqual({ ok: false, error: 'unavailable' });
    vi.stubGlobal('fetch', answer(200, 'not json'));
    expect(await searchStock('https://api.example', '', 'photo', 1)).toEqual({ ok: false, error: 'unavailable' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await searchStock('https://api.example', '', 'photo', 1)).toEqual({ ok: false, error: 'offline' });
  });
});

describe('downloading from the stock library', () => {
  it('downloads the file from Pexels and names it for the library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } })));
    const file = await downloadStock(trustedItem(item({ title: 'Lake: "dawn"/mist' })) as StockItem);
    expect(file.name).toBe('Lake dawn mist.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(file.size).toBe(3);
  });

  it('will not fetch an address that is not Pexels’, and gives a plain message when the download fails', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(downloadStock({ ...(trustedItem(item()) as StockItem), file: 'https://evil.example/a.jpg' })).rejects.toThrow(/cannot be downloaded/);
    expect(f).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('blocked'))));
    await expect(downloadStock(trustedItem(item()) as StockItem)).rejects.toThrow(/from Pexels/);
  });
});
