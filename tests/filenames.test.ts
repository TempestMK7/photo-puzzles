import { describe, expect, it } from 'vitest';
import { Prefs } from '../src/core/prefs';
import { displayName } from '../src/store/photos';

const memoryStorage = (init: Record<string, string> = {}) => {
  const data = { ...init };
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
};

describe('displayName, a file\'s name without its extension', () => {
  it('drops the extension of a picture or a video, in any case, and nothing else', () => {
    expect(displayName('holiday.jpg')).toBe('holiday');
    expect(displayName('Holiday 2024.JPEG')).toBe('Holiday 2024');
    expect(displayName('clip.final.mp4')).toBe('clip.final');
    expect(displayName('a.webm')).toBe('a');
    expect(displayName('Mr. Smith')).toBe('Mr. Smith');
    expect(displayName('v1.2')).toBe('v1.2');
    expect(displayName('notes.txt')).toBe('notes.txt');
    expect(displayName('')).toBe('');
  });

  it('keeps a name that is all extension', () => {
    expect(displayName('.png')).toBe('.png');
  });
});

describe('the filter of the local files', () => {
  it('starts with everything shown, and remembers what was chosen', () => {
    const st = memoryStorage();
    const p = new Prefs(st);
    expect(p.data.filter).toEqual({ source: 'all', type: 'all' });
    p.data.filter.source = 'stock';
    p.data.filter.type = 'video';
    p.save();
    expect(new Prefs(st).data.filter).toEqual({ source: 'stock', type: 'video' });
  });

  it('ignores a filter that is not one of the choices', () => {
    const bad = new Prefs(memoryStorage({ 'photo-puzzles/v1': JSON.stringify({ filter: { source: 'nobody', type: 7 } }) }));
    expect(bad.data.filter).toEqual({ source: 'all', type: 'all' });
    const half = new Prefs(memoryStorage({ 'photo-puzzles/v1': JSON.stringify({ filter: { source: 'mine', type: 'x' } }) }));
    expect(half.data.filter).toEqual({ source: 'mine', type: 'all' });
  });
});
