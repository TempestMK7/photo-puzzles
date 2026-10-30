import { describe, expect, it } from 'vitest';
import { SHARED_MAX, takeShared } from '../src/store/shared';

const list = (...items: unknown[]) => JSON.stringify(items);
const body = (text: string, type = 'image/jpeg') => new Response(text, { headers: { 'content-type': type } });

describe('what other apps share with the app', () => {
  it('is nothing in a browser, or when nothing was shared', async () => {
    expect(await takeShared(undefined, (async () => body('x')) as never)).toEqual([]);
    expect(await takeShared({}, (async () => body('x')) as never)).toEqual([]);
    expect(await takeShared({ takeShared: () => '[]' }, (async () => body('x')) as never)).toEqual([]);
    expect(await takeShared({ takeShared: () => 'not json' }, (async () => body('x')) as never)).toEqual([]);
    expect(await takeShared({ takeShared: () => '{"a":1}' }, (async () => body('x')) as never)).toEqual([]);
    expect(await takeShared({ takeShared: () => { throw new Error('gone'); } }, (async () => body('x')) as never)).toEqual([]);
  });

  it('becomes files with the names and types the sharing app gave, read from the app\'s own address', async () => {
    const asked: string[] = [];
    const files = await takeShared(
      { takeShared: () => list({ url: '/shared/1/Holiday.JPG', name: 'Holiday.JPG', type: 'image/jpeg' }, { url: '/shared/2/clip.mp4', name: 'clip.mp4', type: 'video/mp4' }) },
      (async (url: string) => (asked.push(url), body(`bytes of ${url}`))) as never,
    );
    expect(asked).toEqual(['/shared/1/Holiday.JPG', '/shared/2/clip.mp4']);
    expect(files.map((f) => [f.name, f.type])).toEqual([['Holiday.JPG', 'image/jpeg'], ['clip.mp4', 'video/mp4']]);
    expect(await files[0].text()).toBe('bytes of /shared/1/Holiday.JPG');
  });

  it('fetches nothing but the app\'s own shared files', async () => {
    const asked: string[] = [];
    const get = (async (url: string) => (asked.push(url), body('x'))) as never;
    const files = await takeShared(
      { takeShared: () => list({ url: 'https://evil.example/a.jpg', name: 'a' }, { url: '//evil.example/shared/1/a', name: 'b' }, { url: '/other/1/a.jpg', name: 'c' }, { url: '/shared/1/../../x', name: 'd' }, { url: 7 }, null, 'text', { url: '/shared/9/ok.png', name: 'ok.png', type: 'image/png' }) },
      get,
    );
    expect(asked).toEqual(['/shared/9/ok.png']);
    expect(files.map((f) => f.name)).toEqual(['ok.png']);
  });

  it('leaves out a file that cannot be read and still adds the others', async () => {
    const files = await takeShared(
      { takeShared: () => list({ url: '/shared/1/a.jpg', name: 'a.jpg' }, { url: '/shared/2/b.jpg', name: 'b.jpg' }, { url: '/shared/3/c.jpg', name: 'c.jpg' }) },
      (async (url: string) => {
        if (url.includes('/2/')) return new Response('', { status: 404 });
        if (url.includes('/3/')) throw new TypeError('network');
        return body('x');
      }) as never,
    );
    expect(files.map((f) => f.name)).toEqual(['a.jpg']);
  });

  it('takes a type from the bytes when the sharing app gave none, and a name when it gave none', async () => {
    const [f] = await takeShared({ takeShared: () => list({ url: '/shared/1/x' }) }, (async () => body('x', 'video/webm')) as never);
    expect(f.type).toBe('video/webm');
    expect(f.name).toBe('Shared');
  });

  it('takes no more than a limit', async () => {
    const many = Array.from({ length: SHARED_MAX + 20 }, (_, i) => ({ url: `/shared/${i}/a.jpg`, name: `a${i}.jpg`, type: 'image/jpeg' }));
    const files = await takeShared({ takeShared: () => list(...many) }, (async () => body('x')) as never);
    expect(files).toHaveLength(SHARED_MAX);
  });
});
