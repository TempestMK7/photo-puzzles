import { describe, expect, it } from 'vitest';
import { bestKey, recordBest, sizeLabels, type BestTime, type BestTimes } from '../src/core/besttimes';
import { countsForBestTimes, findKind, KINDS } from '../src/core/kinds';
import { BestTimeStore } from '../src/store/besttimes';

const entry = (over: Partial<BestTime> = {}): BestTime => ({ ms: 60_000, file: 'dog.jpg', video: false, at: 1000, ...over });

class Memory {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

describe('recordBest', () => {
  it('keeps the faster of two times for a size, whatever the file', () => {
    const all: BestTimes = {};
    expect(recordBest(all, bestKey('jigsaw', 2), entry({ ms: 90_000, file: 'photo.jpg' }))).toBe(true);
    expect(recordBest(all, bestKey('jigsaw', 2), entry({ ms: 70_000, file: 'clip.mp4', video: true }))).toBe(true);
    expect(recordBest(all, bestKey('jigsaw', 2), entry({ ms: 80_000 }))).toBe(false);
    expect(all['jigsaw|2']).toMatchObject({ ms: 70_000, file: 'clip.mp4', video: true });
  });

  it('keeps each kind and size apart', () => {
    const all: BestTimes = {};
    recordBest(all, bestKey('jigsaw', 2), entry());
    expect(recordBest(all, bestKey('jigsaw', 1), entry({ ms: 99_000 }))).toBe(true);
    expect(recordBest(all, bestKey('focus', 2), entry({ ms: 99_000 }))).toBe(true);
  });

  it('does not replace an equal time', () => {
    const all: BestTimes = {};
    recordBest(all, 'focus|0', entry({ file: 'first' }));
    expect(recordBest(all, 'focus|0', entry({ file: 'second' }))).toBe(false);
    expect(all['focus|0'].file).toBe('first');
  });
});

describe('sizeLabels', () => {
  it('names every size of every kind', () => {
    for (const k of KINDS.filter((x) => x.available)) {
      const labels = sizeLabels(k);
      expect(labels.length).toBe(k.sizes!.values.length);
      expect(labels[0].name).toBe('S');
    }
    expect(sizeLabels(findKind('jigsaw')!)[2]).toEqual({ name: 'L', detail: 'about 200 pieces' });
  });
});

describe('BestTimeStore', () => {
  it('keeps the times, with the moves, file and time of the solution', () => {
    const mem = new Memory();
    const a = new BestTimeStore(mem);
    expect(a.record('sliding', 1, entry({ moves: 40, file: 'cat.png', at: 5 }))).toBe(true);
    expect(a.record('sliding', 1, entry({ ms: 70_000 }))).toBe(false);
    expect(new BestTimeStore(mem).get('sliding', 1)).toEqual({ ms: 60_000, moves: 40, file: 'cat.png', video: false, at: 5 });
    expect(new BestTimeStore(mem).get('sliding', 0)).toBeUndefined();
  });

  it('starts from nothing when what is kept is damaged, and drops entries that do not fit', () => {
    const mem = new Memory();
    mem.setItem('photo-puzzles/besttimes/v1', JSON.stringify({ 'jigsaw|9': entry(), 'jigsaw|1': { ms: 'x' }, 'focus|0': { ms: 5, at: 1, moves: -3 } }));
    const s = new BestTimeStore(mem);
    expect(Object.keys(s.data)).toEqual(['focus|0']);
    expect(s.get('focus', 0)!.moves).toBeUndefined();
    mem.setItem('photo-puzzles/besttimes/v1', 'nope');
    expect(new BestTimeStore(mem).data).toEqual({});
  });
});

describe('what counts for best times', () => {
  it('leaves out a puzzle that starts with pieces placed', () => {
    expect(countsForBestTimes({ pieces: 200, placed: 0 })).toBe(true);
    expect(countsForBestTimes({ pieces: 200 })).toBe(true);
    expect(countsForBestTimes({ total: 100, placed: 5 })).toBe(false);
  });

  it('says so on the options that place pieces, and the size descriptions leave out the trays, strip length and tabs', () => {
    for (const id of ['jigsaw', 'overlap'] as const) expect(findKind(id)!.options.find((o) => o.key === 'placed')!.note).toMatch(/best times/);
    const ov = findKind('overlap')!;
    expect(ov.sizes!.describe(ov.sizes!.values[2])).toBe('about 200 cells');
    const st = findKind('strips')!;
    expect(st.sizes!.describe(st.sizes!.values[1])).toBe('about 100 cells');
  });
});
