import { describe, expect, it } from 'vitest';
import { describeDifficulty, findKind, KINDS, optionsOf, recordKey, settingsOfKey } from '../src/core/kinds';
import { formatAgo } from '../src/core/prefs';
import { SaveStore, type SaveRecord } from '../src/store/saves';

describe('settingsOfKey', () => {
  it('gives back the difficulty a puzzle was saved with, for every type', () => {
    for (const kind of KINDS) {
      // every option away from its default, as far as it can go
      const chosen: Record<string, number> = {};
      for (const o of kind.options) chosen[`${kind.id}.${o.key}`] = o.def === o.max ? o.min : o.max;
      const key = recordKey(kind, 'photo1', chosen);
      const back = settingsOfKey(kind, key);
      expect(recordKey(kind, 'photo1', back)).toBe(key);
      for (const o of kind.options.filter((x) => !x.display)) expect(back[`${kind.id}.${o.key}`]).toBe(chosen[`${kind.id}.${o.key}`]);
    }
  });

  it('leaves out display settings, and what it does not know', () => {
    const jig = findKind('jigsaw')!;
    expect(settingsOfKey(jig, 'jigsaw|p|pieces=900|bogus=3|haptics=0')).toEqual({ 'jigsaw.pieces': 900 });
    expect(settingsOfKey(jig, 'jigsaw|p|pieces=abc')).toEqual({});
  });
});

describe('describeDifficulty', () => {
  it('names each difficulty option and its value, but not the display settings', () => {
    const jig = findKind('jigsaw')!;
    const text = describeDifficulty(jig, { 'jigsaw.pieces': 900, 'jigsaw.turning': 1, 'jigsaw.snap': 2 });
    expect(text).toBe('Approximate pieces: 900 · Turned pieces: on · Snap on release');
    expect(text).not.toContain('Vibration');
  });

  it('leaves out options added later while they are at their default, and says them once they are not', () => {
    const jig = findKind('jigsaw')!;
    expect(describeDifficulty(jig, { 'jigsaw.placed': 0, 'jigsaw.edges': 0 })).toBe('Approximate pieces: 300 · Turned pieces: off · Snap while dragging');
    expect(describeDifficulty(jig, { 'jigsaw.placed': 25, 'jigsaw.edges': 1 })).toBe(
      'Approximate pieces: 300 · Placed at the start (%): 25 · Edge pieces start in the picture area: on · Turned pieces: off · Snap while dragging',
    );
  });

  it('uses the defaults for what is missing', () => {
    expect(describeDifficulty(findKind('sliding')!, {})).toBe('Approximate tiles: 15');
    expect(optionsOf({}, findKind('sliding')!).tiles).toBe(15);
  });
});

describe('formatAgo', () => {
  const now = 1_000_000_000_000;
  it('says how long ago in the biggest fitting unit', () => {
    expect(formatAgo(now, now - 20_000)).toBe('just now');
    expect(formatAgo(now, now - 5 * 60_000)).toBe('5 min ago');
    expect(formatAgo(now, now - 3 * 3_600_000 - 1000)).toBe('3 h ago');
    expect(formatAgo(now, now - 30 * 3_600_000)).toBe('yesterday');
    expect(formatAgo(now, now - 4 * 86_400_000)).toBe('4 days ago');
    expect(formatAgo(now, now + 5000)).toBe('just now');
  });
});

describe('SaveStore.list', () => {
  const rec = (key: string, savedAt: number): SaveRecord => ({ key, photoId: 'p', kind: 'focus', seed: 'S', width: 10, height: 10, elapsed: 0, savedAt, state: null });

  it('lists every unfinished puzzle, the one played last first, and not one that was removed', async () => {
    const store = new SaveStore(null);
    await store.put(rec('a', 100));
    await store.put(rec('b', 300));
    await store.put(rec('c', 200));
    expect((await store.list()).map((r) => r.key)).toEqual(['b', 'c', 'a']);
    await store.remove('b');
    expect((await store.list()).map((r) => r.key)).toEqual(['c', 'a']);
  });
});
