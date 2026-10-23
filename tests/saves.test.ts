import { describe, expect, it } from 'vitest';
import { FocusGame } from '../src/core/focus';
import { JigsawGame, layoutJigsaw } from '../src/core/jigsaw';
import { generateOverlap, OverlapGame } from '../src/core/overlap';
import { Rng } from '../src/core/rng';
import { generateStrips, StripsGame } from '../src/core/strips';
import { SaveStore, type SaveRecord } from '../src/store/saves';

/** What is written to storage and read back. */
const viaJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('Focus Point state', () => {
  const make = () => new FocusGame(1200, 800, { seed: 5, pieces: 16, irregular: true });

  it('comes back as it was left', () => {
    const a = make();
    a.swap(0, 3);
    a.swap(2, 5);
    a.selected = 4;
    const b = make();
    b.restore(viaJson(a.snapshot()));
    expect(b.slotOf).toEqual(a.slotOf);
    expect(b.selected).toBe(4);
    expect(b.swaps).toBe(2);
  });

  it('refuses a state that is not a shuffle of this puzzle', () => {
    const g = make();
    const s = g.snapshot();
    expect(() => g.restore({ ...s, slotOf: s.slotOf.slice(1) })).toThrow();
    expect(() => g.restore({ ...s, slotOf: s.slotOf.map(() => 0) })).toThrow();
  });
});

describe('Overlap state', () => {
  const setup = generateOverlap(new Rng(7), { cols: 7, rows: 5, turned: true, placed: 20, windows: true });

  it('comes back as it was left', () => {
    const a = new OverlapGame(setup);
    a.rot[1] = (a.rot[1] + 1) % 4;
    a.misses = 3;
    const stack = a.stacks.findIndex((s) => s.length > 1);
    a.stacks[stack].push(a.stacks[stack].shift()!);
    const b = new OverlapGame(setup);
    b.restore(viaJson(a.snapshot()));
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.misses).toBe(3);
  });

  it('refuses a state of another size', () => {
    const other = new OverlapGame(generateOverlap(new Rng(7), { cols: 9, rows: 6, turned: true, placed: 20, windows: true }));
    expect(() => new OverlapGame(setup).restore(other.snapshot())).toThrow();
  });
});

describe('Strips state', () => {
  const setup = generateStrips(new Rng(9), { picCols: 14, picRows: 10, maxLen: 6, placed: 20, tabs: 3 });

  it('comes back as it was left', () => {
    const a = new StripsGame(setup);
    const id = a.state.findIndex((s) => !s.locked);
    a.state[id].angle = 2;
    a.state[id].tab = 1;
    a.bringToFront(id);
    a.moves = 4;
    const b = new StripsGame(setup);
    b.restore(viaJson(a.snapshot()));
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('refuses a state with a strip on a tab that does not exist, or the wrong number of strips', () => {
    const a = new StripsGame(setup);
    const s = a.snapshot();
    expect(() => new StripsGame(setup).restore({ ...s, state: s.state.map((t) => ({ ...t, tab: 9 })) })).toThrow();
    expect(() => new StripsGame(setup).restore({ ...s, z: s.z.slice(1) })).toThrow();
  });
});

describe('Jigsaw state', () => {
  const layout = layoutJigsaw(new Rng(3), 1200, 800, 200);
  const start = (i: number) => ({ dx: 900 + i * 7, dy: -700 - i * 5, rot: i % 4 });

  it('comes back as it was left: groups, turns, positions and the order they lie in', () => {
    const a = new JigsawGame(layout, start);
    const p = 5 + layout.cols * 3;
    a.moveTo(a.groupOf[p], 100, 100);
    a.groups.get(a.groupOf[p])!.rot = 1;
    a.moveTo(a.groupOf[p + 1], 100, 100);
    a.groups.get(a.groupOf[p + 1])!.rot = 1;
    a.connect(a.groupOf[p + 1], 8);
    a.moveTo(a.groupOf[1], 2, 1);
    a.groups.get(a.groupOf[1])!.rot = 0;
    a.connect(a.groupOf[1], 8);
    a.bringToFront(a.groupOf[p + 7]);
    const b = new JigsawGame(layout, () => ({ dx: 0, dy: 0 }));
    b.restore(viaJson(a.snapshot()));
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.anchoredCount).toBe(a.anchoredCount);
    expect(b.groupOf[p]).toBe(b.groupOf[p + 1]);
    expect(b.groups.get(b.groupOf[p])!.rot).toBe(1);
    expect(b.groups.get(b.groupOf[1])!.anchored).toBe(true);
  });

  it('refuses a state that loses a piece, holds one twice, or lets a corner go', () => {
    const a = new JigsawGame(layout, start);
    const s = a.snapshot();
    const b = () => new JigsawGame(layout, start);
    expect(() => b().restore({ ...s, groups: s.groups.slice(1) })).toThrow();
    expect(() => b().restore({ ...s, groups: [...s.groups, s.groups[5]] })).toThrow();
    expect(() => b().restore({ ...s, groups: s.groups.map((g) => ({ ...g, anchored: false })) })).toThrow();
  });
});

describe('SaveStore', () => {
  const rec = (key: string, photoId: string): SaveRecord => ({ key, photoId, kind: 'focus', seed: 'ABC', width: 100, height: 80, elapsed: 5000, savedAt: 1, state: { n: 1 } });

  it('keeps, replaces and forgets a save (in memory when the browser has no IndexedDB)', async () => {
    const store = new SaveStore(null);
    expect(await store.get('k')).toBeUndefined();
    await store.put(rec('k', 'p1'));
    expect((await store.get('k'))?.elapsed).toBe(5000);
    await store.put({ ...rec('k', 'p1'), elapsed: 9000 });
    expect((await store.get('k'))?.elapsed).toBe(9000);
    await store.remove('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('forgets every save of a deleted photo and none of the others', async () => {
    const store = new SaveStore(null);
    await store.put(rec('focus|p1|a', 'p1'));
    await store.put(rec('strips|p1|b', 'p1'));
    await store.put(rec('focus|p2|a', 'p2'));
    await store.removeForPhoto('p1');
    expect(await store.get('focus|p1|a')).toBeUndefined();
    expect(await store.get('strips|p1|b')).toBeUndefined();
    expect(await store.get('focus|p2|a')).toBeDefined();
  });
});
