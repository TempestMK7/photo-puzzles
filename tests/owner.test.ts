import { describe, expect, it } from 'vitest';
import { AchievementStore } from '../src/store/achievements';
import { BestTimeStore } from '../src/store/besttimes';

class Memory {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

describe('what is kept for each account on a device', () => {
  it('goes to the first account that signs in, and the next account starts with nothing', () => {
    const mem = new Memory();
    const first = new BestTimeStore(mem);
    first.record('jigsaw', 1, { ms: 50_000, file: 'a.jpg', video: false, at: 1 });
    const t = new BestTimeStore(mem);
    t.use('annie');
    expect(t.get('jigsaw', 1)?.ms).toBe(50_000);
    t.record('jigsaw', 1, { ms: 40_000, file: 'a.jpg', video: false, at: 2 });
    t.use('bob');
    expect(t.get('jigsaw', 1)).toBeUndefined();
    t.use('annie');
    expect(t.get('jigsaw', 1)?.ms).toBe(40_000);
    t.use(null);
    expect(t.get('jigsaw', 1)?.ms).toBe(50_000);                                 // the device's own, left as it was
    expect(new BestTimeStore(mem).get('jigsaw', 1)?.ms).toBe(50_000);
  });

  it('is the same for achievements: a new account has none of the last one\'s', () => {
    const mem = new Memory();
    const a = new AchievementStore(mem);
    a.use('annie');
    a.record({ type: 'help', help: 'hint' });
    expect(a.state.counts.hints).toBe(1);
    a.use('bob');
    expect(a.state.counts.hints).toBe(0);
    expect(a.unlockedIds()).toEqual([]);
    a.record({ type: 'help', help: 'hint' });
    a.use('annie');
    expect(a.state.counts.hints).toBe(1);
  });
});
