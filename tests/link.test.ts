import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLink, LINK_IS_PAGE, LINK_REFUSED, nameFromLink, parseLink } from '../src/store/link';

describe('parseLink', () => {
  it('takes web addresses, with the quotes or brackets a paste may carry, and adds https to a bare one', () => {
    expect(parseLink('  https://example.com/a/b.jpg?x=1  ')?.href).toBe('https://example.com/a/b.jpg?x=1');
    expect(parseLink('"http://example.com/a.png"')?.href).toBe('http://example.com/a.png');
    expect(parseLink('<https://example.com/a.png>')?.href).toBe('https://example.com/a.png');
    expect(parseLink('example.com/a.png')?.href).toBe('https://example.com/a.png');
  });

  it('refuses what is not a web address', () => {
    for (const s of ['', '   ', 'hello', 'two words.jpg', 'file:///C:/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'ftp://example.com/a.jpg']) expect(parseLink(s), s).toBeNull();
  });

  it('finds the picture inside a Google image search or redirect link', () => {
    const picture = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Cat.jpg';
    expect(parseLink(`https://www.google.com/imgres?q=cat&imgurl=${encodeURIComponent(picture)}&imgrefurl=x`)?.href).toBe(picture);
    expect(parseLink(`https://www.google.co.uk/url?sa=i&url=${encodeURIComponent(picture)}`)?.href).toBe(picture);
    expect(parseLink('https://www.google.com/search?q=cat')?.href).toBe('https://www.google.com/search?q=cat');
  });
});

describe('nameFromLink', () => {
  it('uses the last part of the address, and adds an extension that fits the type when there is none', () => {
    expect(nameFromLink(new URL('https://e.com/a/My%20Cat.jpg?w=2'), 'image/jpeg')).toBe('My Cat.jpg');
    expect(nameFromLink(new URL('https://e.com/photo-1506744038136'), 'image/jpeg')).toBe('photo-1506744038136.jpg');
    expect(nameFromLink(new URL('https://e.com/'), 'image/png')).toBe('e.com.png');
    expect(nameFromLink(new URL('https://e.com/a/b.gif'), '')).toBe('b.gif');
  });
});

describe('fetchLink', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (body: BodyInit, type: string | null, status = 200) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: type ? { 'content-type': type } : {} })));

  it('gives back the file with the type the site said', async () => {
    answer(new Uint8Array([1, 2, 3]), 'image/png');
    const file = await fetchLink(new URL('https://e.com/dot'));
    expect([file.name, file.type, file.size]).toEqual(['dot.png', 'image/png', 3]);
  });

  it('says what is wrong with a web page, an error answer, an odd type and a refusing site', async () => {
    answer('<html>', 'text/html; charset=utf-8');
    await expect(fetchLink(new URL('https://e.com/page'))).rejects.toThrow(LINK_IS_PAGE);
    answer('no', 'text/plain', 200);
    await expect(fetchLink(new URL('https://e.com/a.txt'))).rejects.toThrow('not a picture or a video');
    answer('', 'image/png', 404);
    await expect(fetchLink(new URL('https://e.com/a.png'))).rejects.toThrow('404');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchLink(new URL('https://e.com/a.png'))).rejects.toThrow(LINK_REFUSED);
  });

  it('tries the secure address when an http one fails', async () => {
    const get = vi.fn(async (u: string) => {
      if (u.startsWith('http:')) throw new TypeError('blocked');
      return new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/jpeg' } });
    });
    vi.stubGlobal('fetch', get);
    expect((await fetchLink(new URL('http://e.com/a.jpg'))).name).toBe('a.jpg');
    expect(get.mock.calls.map((c) => c[0])).toEqual(['http://e.com/a.jpg', 'https://e.com/a.jpg']);
  });

  it('accepts an untyped answer only if the name says it is a picture or a video', async () => {
    answer(new Uint8Array([1]), 'application/octet-stream');
    expect((await fetchLink(new URL('https://e.com/clip.mp4'))).name).toBe('clip.mp4');
    answer(new Uint8Array([1]), null);
    await expect(fetchLink(new URL('https://e.com/thing'))).rejects.toThrow('not a picture or a video');
  });
});
