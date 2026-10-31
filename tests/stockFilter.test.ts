import { describe, expect, it, vi } from 'vitest';
import { PexelsStock, PixabayStock } from '../server/src/stock';
import { adultText, pathOf } from '../server/src/stockFilter';

describe('the words that keep adult pictures out of the stock library', () => {
  it('finds them in a search, in tags and in the words of a page address, whatever the case and the dashes', () => {
    for (const t of ['nude woman', 'Naked', 'portrait, woman, nude woman, female', 'sexy girl', 'Lingerie', 'woman in lingerie', 'eroticism', 'sensual, sensuality', 'seductive pose', 'TOPLESS', 'porn', 'boobs', 'handcuffs, fetish, bdsm', 'g-string', '/photos/woman-nude-model-1234/', 'semi_nude', 'nsfw', 'twerking']) {
      expect(adultText(t), t).toBe(true);
    }
  });

  it('lets ordinary words through, including the near ones', () => {
    for (const t of ['mountain lake', 'beach', 'bikini', 'swimsuit', 'baby bathing', 'wedding kiss', 'Essex', 'Sussex', 'sextant', 'brass band', 'embrace', 'breast cancer awareness', 'chicken breast', 'strip of land', 'butterfly', 'button', 'adult', 'woman, model, portrait, fashion', '/photos/tree-nature-736885/', '']) {
      expect(adultText(t), t).toBe(false);
    }
  });

  it('reads the path of an address, and nothing from what is not one', () => {
    expect(pathOf('https://pixabay.com/photos/nude-model-123/')).toBe('/photos/nude-model-123/');
    expect(pathOf('not an address')).toBe('');
    expect(pathOf(undefined)).toBe('');
  });
});

const fakeFetch = (body: unknown) => {
  const asked: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { asked, fetcher };
};

const pixabayHit = (id: number, tags: string, slug = `picture-${id}`) => ({
  id,
  pageURL: `https://pixabay.com/photos/${slug}/`,
  tags,
  previewURL: `https://cdn.pixabay.com/photo/p_${id}_150.jpg`,
  largeImageURL: `https://pixabay.com/get/g${id}`,
  imageWidth: 100,
  imageHeight: 100,
  user_id: 1,
  user: 'u',
});

describe('the stock sites, with the filter', () => {
  it('leaves out a Pixabay picture whose tags or page address use such a word, and keeps the others', async () => {
    const f = fakeFetch({
      totalHits: 5,
      hits: [pixabayHit(1, 'lake, mountain, nature'), pixabayHit(2, 'portrait, woman, nude woman, female'), pixabayHit(3, 'woman, model', 'lingerie-model-3'), pixabayHit(4, 'sunset, sea'), pixabayHit(5, 'bikini, beach, woman')],
    });
    const res = await new PixabayStock('K', { fetch: f.fetcher }).search('', 'photo', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res.items.map((i) => i.id)).toEqual(['1', '4', '5']);
  });

  it('leaves out Pixabay videos the same way', async () => {
    const size = { url: 'https://cdn.pixabay.com/video/a.mp4', width: 1280, height: 720, size: 1000, thumbnail: 'https://cdn.pixabay.com/video/a.jpg' };
    const vid = (id: number, tags: string) => ({ id, pageURL: `https://pixabay.com/videos/v-${id}/`, tags, duration: 10, videos: { small: size }, user_id: 1, user: 'u' });
    const res = await new PixabayStock('K', { fetch: fakeFetch({ totalHits: 2, hits: [vid(1, 'waves, sea'), vid(2, 'girl erotic dancing, show')] }).fetcher }).search('', 'video', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res.items.map((i) => i.id)).toEqual(['1']);
  });

  it('leaves out a Pexels picture by its description or its address, and a video by its address', async () => {
    const photo = (id: number, alt: string, slug: string) => ({
      id,
      width: 1,
      height: 1,
      url: `https://www.pexels.com/photo/${slug}-${id}/`,
      photographer: 'p',
      alt,
      src: { large2x: 'https://images.pexels.com/a.jpg', large: 'https://images.pexels.com/a.jpg', small: 'https://images.pexels.com/s.jpg' },
    });
    const res = await new PexelsStock('K', { fetch: fakeFetch({ photos: [photo(1, 'A lake', 'a-lake'), photo(2, 'Naked woman on a bed', 'woman-on-a-bed'), photo(3, '', 'sexy-girl')] }).fetcher }).search('', 'photo', 1);
    if (typeof res !== 'object' || !res) throw new Error('no result');
    expect(res.items.map((i) => i.id)).toEqual(['1']);
    const video = (id: number, slug: string) => ({ id, duration: 9, url: `https://www.pexels.com/video/${slug}-${id}/`, image: 'https://images.pexels.com/v.jpg', user: { name: 'u', url: 'https://www.pexels.com/@u' }, video_files: [{ file_type: 'video/mp4', width: 1280, link: 'https://videos.pexels.com/a.mp4' }] });
    const vres = await new PexelsStock('K', { fetch: fakeFetch({ videos: [video(1, 'waves'), video(2, 'woman-in-lingerie')] }).fetcher }).search('', 'video', 1);
    if (typeof vres !== 'object' || !vres) throw new Error('no result');
    expect(vres.items.map((i) => i.id)).toEqual(['1']);
  });

  it('answers a search for such things with nothing, and does not ask the site (or use up its limit)', async () => {
    const f = fakeFetch({ totalHits: 1, hits: [pixabayHit(1, 'x')] });
    const allow = vi.fn(async () => true);
    const stock = new PixabayStock('K', { fetch: f.fetcher });
    expect(await stock.search('nude woman', 'photo', 1, allow)).toEqual({ ok: true, items: [], page: 1, more: false });
    expect(await stock.search('LINGERIE', 'video', 2, allow)).toEqual({ ok: true, items: [], page: 2, more: false });
    expect(f.asked).toHaveLength(0);
    expect(allow).not.toHaveBeenCalled();
    expect(await stock.search('mountain', 'photo', 1, allow)).toMatchObject({ ok: true });
    expect(f.asked).toHaveLength(1);
  });
});
