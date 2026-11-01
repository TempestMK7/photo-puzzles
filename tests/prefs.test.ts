import { describe, expect, it } from 'vitest';
import { findKind, GENERAL, generalValue, KINDS, migrateGeneral, optionValue, optionsOf, puzzleSeedText, recordKey, type Settings } from '../src/core/kinds';
import { formatTime, Prefs, type StorageLike } from '../src/core/prefs';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Record<string, string> } {
  const map = { ...initial };
  return { map, getItem: (k) => map[k] ?? null, setItem: (k, v) => void (map[k] = v) };
}

describe('kinds', () => {
  const focus = findKind('focus')!;

  it('lists every puzzle type as playable', () => {
    expect(KINDS.filter((k) => k.available).map((k) => k.id)).toEqual(['focus', 'overlap', 'strips', 'jigsaw', 'sliding', 'rotascope']);
    expect(KINDS.length).toBeGreaterThan(1);
  });

  it('falls back to defaults and clamps option values', () => {
    const size = focus.options[0];
    expect(optionValue({}, 'focus', size)).toBe(size.def);
    expect(optionValue({ 'focus.size': 1000 }, 'focus', size)).toBe(size.max);
    expect(optionValue({ 'focus.size': -3 }, 'focus', size)).toBe(size.min);
    expect(optionValue({ 'focus.size': NaN }, 'focus', size)).toBe(size.def);
    expect(optionsOf({}, focus)).toEqual({ size: 1, pieces: 50, irregular: 1 });
  });

  it('a record belongs to photo, type and difficulty - not to the seed', () => {
    const a = recordKey(focus, 'p1', {});
    expect(recordKey(focus, 'p1', { 'focus.size': 1 })).toBe(a);
    expect(recordKey(focus, 'p1', { 'focus.size': 2 })).not.toBe(a);
    expect(recordKey(focus, 'p2', {})).not.toBe(a);
    expect(recordKey(focus, 'p1', { 'all.grid': 0, 'all.animate': 0 })).toBe(a);        // how it is shown is not a difficulty
  });

  it('each type has its sizes: a slider between named steps, and what every step sets', () => {
    const at = (kind: string, size: number) => optionsOf({ [`${kind}.size`]: size }, findKind(kind)!);
    const column = (kind: string, key: string) => findKind(kind)!.sizes!.values.map((v) => v[key]);
    expect(findKind('focus')!.options[0].tiers).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
    expect(findKind('jigsaw')!.options[0].tiers).toEqual(['S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
    expect(findKind('sliding')!.options[0].tiers).toEqual(['S', 'M', 'L', 'XL']);
    expect(column('focus', 'pieces')).toEqual([20, 50, 100, 200, 500]);
    expect(column('overlap', 'total')).toEqual([50, 100, 200, 500, 1000]);
    expect(column('overlap', 'stacks')).toEqual([3, 4, 5, 6, 7]);
    expect(column('strips', 'cells')).toEqual([50, 100, 200, 500, 1000]);
    expect(column('strips', 'length')).toEqual([4, 6, 8, 10, 12]);
    expect(column('strips', 'tabs')).toEqual([4, 6, 8, 10, 12]);
    expect(column('jigsaw', 'pieces')).toEqual([50, 100, 200, 500, 1000, 2000]);
    expect(column('sliding', 'tiles')).toEqual([20, 50, 100, 200]);
    expect(column('rotascope', 'rings')).toEqual([2, 3, 4, 5]);
    expect(column('rotascope', 'wedges')).toEqual([4, 4, 5, 5]);
    expect(at('jigsaw', 5).pieces).toBe(2000);
    expect(at('rotascope', 2)).toMatchObject({ rings: 4, wedges: 5 });
    for (const k of KINDS) {
      const size = k.options.find((o) => o.key === 'size')!;
      expect(size.max, k.id).toBe(k.sizes!.values.length - 1);
      expect(size.tiers, k.id).toHaveLength(k.sizes!.values.length);
      expect(k.options.map((o) => o.key).filter((key) => key in k.sizes!.values[0]), k.id).toEqual([]);          // what a size sets is not an option of its own as well
    }
  });

  it('the settings for every type are kept apart from the options of a type, and are not difficulties', () => {
    expect(GENERAL.map((o) => o.label)).toEqual(['Grid lines', 'Animations', 'Vibration', 'Raise piece above touch point', 'Light background']);
    expect(generalValue({}, 'light')).toBe(0);
    expect(generalValue({}, 'grid')).toBe(1);
    expect(generalValue({ 'all.light': 1, 'all.grid': 0 }, 'light')).toBe(1);
    expect(generalValue({ 'all.grid': 0 }, 'grid')).toBe(0);
    for (const k of KINDS) for (const o of GENERAL) expect(k.options.some((x) => x.key === o.key), `${k.id}.${o.key}`).toBe(false);
    const jigsaw = findKind('jigsaw')!;
    expect(recordKey(jigsaw, 'p1', { 'all.light': 1 })).toBe(recordKey(jigsaw, 'p1', {}));
  });

  it('takes what a player had set for one type before the settings were shared', () => {
    const s: Settings = { 'jigsaw.light': 1, 'sliding.animate': 0, 'focus.grid': 1, 'overlap.haptics': 0, 'strips.offset': 0, 'focus.pieces': 30 };
    migrateGeneral(s);
    expect(generalValue(s, 'light')).toBe(1);
    expect(generalValue(s, 'animate')).toBe(0);
    expect(generalValue(s, 'grid')).toBe(1);
    expect(generalValue(s, 'haptics')).toBe(0);
    expect(generalValue(s, 'offset')).toBe(0);
    const chosen: Settings = { 'all.grid': 1, 'focus.grid': 0 };
    migrateGeneral(chosen);
    expect(chosen['all.grid']).toBe(1);                                                    // (a choice made since stays)
  });

  it('the jigsaw start options are difficulties, but at their defaults the key is what it was before they existed', () => {
    const jigsaw = findKind('jigsaw')!;
    expect(optionsOf({}, jigsaw)).toMatchObject({ placed: 0, edges: 0 });
    expect(recordKey(jigsaw, 'p1', {})).toBe('jigsaw|p1|size=1|snap=0|turning=0');
    expect(recordKey(jigsaw, 'p1', { 'jigsaw.placed': 40 })).not.toBe(recordKey(jigsaw, 'p1', {}));
    expect(recordKey(jigsaw, 'p1', { 'jigsaw.edges': 1 })).not.toBe(recordKey(jigsaw, 'p1', {}));
    expect(optionValue({ 'jigsaw.placed': 500 }, 'jigsaw', jigsaw.options.find((o) => o.key === 'placed')!)).toBe(80);
  });

  it('every photo and type gets its own puzzle from one seed', () => {
    expect(puzzleSeedText('abc', 'p1', 'focus')).toBe(puzzleSeedText(' ABC ', 'p1', 'focus'));
    expect(puzzleSeedText('abc', 'p1', 'focus')).not.toBe(puzzleSeedText('abc', 'p2', 'focus'));
    expect(puzzleSeedText('abc', 'p1', 'focus')).not.toBe(puzzleSeedText('abc', 'p1', 'jigsaw'));
  });
});

describe('prefs', () => {
  it('remembers what was chosen', () => {
    const st = memoryStorage();
    const p = new Prefs(st);
    p.data.seed = 'ABCD2345';
    p.data.photo = 'p9';
    p.data.settings['focus.size'] = 3;
    p.save();
    const q = new Prefs(st);
    expect(q.data.seed).toBe('ABCD2345');
    expect(q.data.photo).toBe('p9');
    expect(q.data.settings['focus.size']).toBe(3);
  });

  it('remembers how My Files is sorted, and ignores a sort it does not know', () => {
    const st = memoryStorage();
    expect(new Prefs(st).data.sort).toBe('added');
    const p = new Prefs(st);
    p.data.sort = 'name';
    p.save();
    expect(new Prefs(st).data.sort).toBe('name');
    expect(new Prefs(memoryStorage({ 'photo-puzzles/v1': JSON.stringify({ sort: 'size' }) })).data.sort).toBe('added');
  });

  it('keeps the sound effects switch apart from the video sound, on unless it was turned off', () => {
    const st = memoryStorage();
    const p = new Prefs(st);
    expect(p.data.sfx).toBe(true);
    p.data.sfx = false;
    p.save();
    const q = new Prefs(st);
    expect(q.data.sfx).toBe(false);
    expect(q.data.muted).toBe(false);
    expect(new Prefs(memoryStorage({ 'photo-puzzles/v1': JSON.stringify({ sfx: 'no' }) })).data.sfx).toBe(true);
  });

  it('ignores damaged storage and types that cannot be played', () => {
    expect(new Prefs(memoryStorage({ 'photo-puzzles/v1': '{nope' })).data.kind).toBe('focus');
    expect(new Prefs(memoryStorage({ 'photo-puzzles/v1': JSON.stringify({ kind: 'nonsense' }) })).data.kind).toBe('focus');
    expect(() => new Prefs(null)).not.toThrow();
  });

  it('keeps only better times', () => {
    const st = memoryStorage();
    const p = new Prefs(st);
    expect(p.recordTime('k', 50_000)).toBe(true);
    expect(p.recordTime('k', 60_000)).toBe(false);
    expect(p.recordTime('k', 40_000)).toBe(true);
    expect(new Prefs(st).bestTime('k')).toBe(40_000);
  });

  it('formats times', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65_400)).toBe('1:05');
    expect(formatTime(3_725_000)).toBe('1:02:05');
  });
});
