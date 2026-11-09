import { describe, expect, it } from 'vitest';
import { bestKey, recordBest, sizeLabels, type BestTime, type BestTimes } from '../src/core/besttimes';
import { cleanPuzzleSettings, findKind, isFast, KINDS, orientationLocked, solvesByDragging } from '../src/core/kinds';
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

describe('fast mode', () => {
  it('keeps the fast mode times apart from the regular ones', () => {
    const mem = new Memory();
    const s = new BestTimeStore(mem);
    expect(s.record('jigsaw', 1, entry({ ms: 9000 }))).toBe(true);
    expect(s.record('jigsaw', 1, entry({ ms: 5000 }), true)).toBe(true);
    expect(s.record('jigsaw', 1, entry({ ms: 7000 }))).toBe(true);
    expect(s.get('jigsaw', 1)!.ms).toBe(7000);
    expect(s.get('jigsaw', 1, true)!.ms).toBe(5000);
    const again = new BestTimeStore(mem);
    expect(again.get('jigsaw', 1)!.ms).toBe(7000);
    expect(again.get('jigsaw', 1, true)!.ms).toBe(5000);
  });

  it('is a puzzle with any fast mode option away from its default, and only Jigsaw, Overlap and Strips have them', () => {
    const jig = findKind('jigsaw')!;
    expect(isFast(jig, { pieces: 200, placed: 0, lock: 0, drag: 1, edges: 1 })).toBe(false);
    expect(isFast(jig, { pieces: 200 })).toBe(false);
    for (const change of [{ placed: 5 } as Record<string, number>, { lock: 1 }, { drag: 0 }, { edges: 0 }]) expect(isFast(jig, { pieces: 200, ...change })).toBe(true);
    expect(isFast(findKind('overlap')!, { total: 100, lock: 1 })).toBe(true);
    expect(isFast(findKind('strips')!, { cells: 100, drag: 0 })).toBe(true);
    for (const id of ['focus', 'sliding', 'rotascope'] as const) expect(isFast(findKind(id)!, { pieces: 20, lock: 1, placed: 40 })).toBe(false);
  });

  it('lists the puzzles in the order Jigsaw, Overlap, Strips, Tile Swap, Sliding Tiles, Rotascope', () => {
    expect(KINDS.map((k) => k.name)).toEqual(['Jigsaw', 'Overlap', 'Strips', 'Tile Swap', 'Sliding Tiles', 'Rotascope']);
  });

  it('gives Jigsaw, Overlap and Strips the same fast mode options, in the same order, with these defaults', () => {
    const names = (id: 'jigsaw' | 'overlap' | 'strips') => findKind(id)!.options.filter((o) => o.fast).map((o) => `${o.key}=${o.def}`);
    expect(names('jigsaw')).toEqual(['placed=0', 'lock=0', 'drag=1', 'edges=1']);
    expect(names('overlap')).toEqual(['placed=0', 'lock=0', 'drag=1']);
    expect(names('strips')).toEqual(['placed=0', 'lock=0', 'drag=1']);
    expect(findKind('jigsaw')!.options.find((o) => o.key === 'placed')!.max).toBe(80);
    expect(findKind('focus')!.options.some((o) => o.fast)).toBe(false);
  });

  it('reads the names that puzzles and rooms made before these options used', () => {
    expect(orientationLocked({ turning: 0 }, 'turning')).toBe(true);
    expect(orientationLocked({ turning: 1 }, 'turning')).toBe(false);
    expect(orientationLocked({ turned: 0 }, 'turned')).toBe(true);
    expect(orientationLocked({ turned: 1 }, 'turned')).toBe(false);
    expect(orientationLocked({})).toBe(false);                                      // (Strips)
    expect(orientationLocked({ lock: 1, turning: 1 }, 'turning')).toBe(true);
    expect(orientationLocked({ lock: 0, turning: 0 }, 'turning')).toBe(false);
    expect(solvesByDragging({ snap: 0 })).toBe(true);
    expect(solvesByDragging({ snap: 1 })).toBe(false);
    expect(solvesByDragging({})).toBe(true);
    expect(solvesByDragging({ drag: 0, snap: 0 })).toBe(false);
  });

  it('keeps only puzzle options, within their limits', () => {
    expect(cleanPuzzleSettings({ 'jigsaw.placed': 500, 'jigsaw.lock': 1, 'all.light': 1, 'bogus.x': 3, 'jigsaw.drag': 'x', 'strips.size': -4 })).toEqual({ 'jigsaw.placed': 80, 'jigsaw.lock': 1, 'strips.size': 0 });
    expect(cleanPuzzleSettings(null)).toEqual({});
  });

  it('says what size sets in words, without the trays, strip length and tabs', () => {
    const ov = findKind('overlap')!;
    expect(ov.sizes!.describe(ov.sizes!.values[2])).toBe('about 200 cells');
    const st = findKind('strips')!;
    expect(st.sizes!.describe(st.sizes!.values[1])).toBe('about 100 cells');
  });
});
