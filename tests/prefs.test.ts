import { describe, expect, it } from 'vitest';
import { findKind, KINDS, optionValue, optionsOf, puzzleSeedText, recordKey } from '../src/core/kinds';
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
    const pieces = focus.options[0];
    expect(optionValue({}, 'focus', pieces)).toBe(pieces.def);
    expect(optionValue({ 'focus.pieces': 1000 }, 'focus', pieces)).toBe(pieces.max);
    expect(optionValue({ 'focus.pieces': -3 }, 'focus', pieces)).toBe(pieces.min);
    expect(optionValue({ 'focus.pieces': NaN }, 'focus', pieces)).toBe(pieces.def);
    expect(optionsOf({}, focus)).toEqual({ pieces: 20, irregular: 1, grid: 1, animate: 1, haptics: 1 });
  });

  it('a record belongs to photo, type and difficulty - not to the seed', () => {
    const a = recordKey(focus, 'p1', {});
    expect(recordKey(focus, 'p1', { 'focus.pieces': 20 })).toBe(a);
    expect(recordKey(focus, 'p1', { 'focus.pieces': 30 })).not.toBe(a);
    expect(recordKey(focus, 'p2', {})).not.toBe(a);
    expect(recordKey(focus, 'p1', { 'focus.grid': 0, 'focus.animate': 0 })).toBe(a);        // how it is shown is not a difficulty
  });

  it('Focus Point steps by ten pieces from 10 to 300, and Overlap by ten cells from 50 to 500; every slider starts on one of its steps', () => {
    const range = (kind: string, key: string) => findKind(kind)!.options.find((o) => o.key === key)!;
    expect(range('focus', 'pieces')).toMatchObject({ min: 10, max: 300, step: 10 });
    expect(range('overlap', 'total')).toMatchObject({ min: 50, max: 500, step: 10 });
    for (const k of KINDS) for (const o of k.options) if (o.step) expect((o.def - o.min) % o.step, `${k.id}.${o.key}`).toBe(0);
  });

  it('the jigsaw background is dark unless chosen, and is not a difficulty', () => {
    const jigsaw = findKind('jigsaw')!;
    expect(optionsOf({}, jigsaw).light).toBe(0);
    expect(optionsOf({ 'jigsaw.light': 1 }, jigsaw).light).toBe(1);
    expect(recordKey(jigsaw, 'p1', { 'jigsaw.light': 1 })).toBe(recordKey(jigsaw, 'p1', {}));
  });

  it('the jigsaw start options are difficulties, but at their defaults the key is what it was before they existed', () => {
    const jigsaw = findKind('jigsaw')!;
    expect(optionsOf({}, jigsaw)).toMatchObject({ placed: 0, edges: 0 });
    expect(recordKey(jigsaw, 'p1', {})).toBe('jigsaw|p1|pieces=300|snap=0|turning=0');
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
    p.data.settings['focus.pieces'] = 30;
    p.save();
    const q = new Prefs(st);
    expect(q.data.seed).toBe('ABCD2345');
    expect(q.data.photo).toBe('p9');
    expect(q.data.settings['focus.pieces']).toBe(30);
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
