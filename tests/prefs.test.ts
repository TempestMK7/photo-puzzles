import { describe, expect, it } from 'vitest';
import { findKind, KINDS, optionValue, optionsOf, puzzleSeedText, recordKey } from '../src/core/kinds';
import { formatTime, Prefs, type StorageLike } from '../src/core/prefs';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { map: Record<string, string> } {
  const map = { ...initial };
  return { map, getItem: (k) => map[k] ?? null, setItem: (k, v) => void (map[k] = v) };
}

describe('kinds', () => {
  const focus = findKind('focus')!;

  it('lists Focus Point, Overlap and Strips as playable, the rest as coming', () => {
    expect(KINDS.filter((k) => k.available).map((k) => k.id)).toEqual(['focus', 'overlap', 'strips']);
    expect(KINDS.length).toBeGreaterThan(1);
  });

  it('falls back to defaults and clamps option values', () => {
    const pieces = focus.options[0];
    expect(optionValue({}, 'focus', pieces)).toBe(pieces.def);
    expect(optionValue({ 'focus.pieces': 1000 }, 'focus', pieces)).toBe(pieces.max);
    expect(optionValue({ 'focus.pieces': -3 }, 'focus', pieces)).toBe(pieces.min);
    expect(optionValue({ 'focus.pieces': NaN }, 'focus', pieces)).toBe(pieces.def);
    expect(optionsOf({}, focus)).toEqual({ pieces: 16, irregular: 1, grid: 1, animate: 1 });
  });

  it('a record belongs to photo, type and difficulty - not to the seed', () => {
    const a = recordKey(focus, 'p1', {});
    expect(recordKey(focus, 'p1', { 'focus.pieces': 16 })).toBe(a);
    expect(recordKey(focus, 'p1', { 'focus.pieces': 20 })).not.toBe(a);
    expect(recordKey(focus, 'p2', {})).not.toBe(a);
    expect(recordKey(focus, 'p1', { 'focus.grid': 0, 'focus.animate': 0 })).toBe(a);        // how it is shown is not a difficulty
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

  it('ignores damaged storage and types that cannot be played', () => {
    expect(new Prefs(memoryStorage({ 'photo-puzzles/v1': '{nope' })).data.kind).toBe('focus');
    expect(new Prefs(memoryStorage({ 'photo-puzzles/v1': JSON.stringify({ kind: 'jigsaw' }) })).data.kind).toBe('focus');
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
