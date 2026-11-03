import { describe, expect, it } from 'vitest';
import { ACHIEVEMENTS, applyEvent, emptyAchievements, findAchievement, progressOf, sizeIndexOf, type GameEvent } from '../src/core/achievements';
import { findKind, KINDS } from '../src/core/kinds';
import { AchievementStore } from '../src/store/achievements';

const solved = (over: Partial<Extract<GameEvent, { type: 'solved' }>> = {}): GameEvent => ({ type: 'solved', kind: 'jigsaw', size: 1, video: false, online: false, ...over });
const ids = (list: readonly { id: string }[]) => list.map((a) => a.id);

class Memory {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
}

describe('the list', () => {
  it('has unique ids, names and descriptions', () => {
    expect(new Set(ids(ACHIEVEMENTS)).size).toBe(ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.name).not.toBe('');
      expect(a.description).not.toBe('');
      expect(a.counter || a.when).toBeTruthy();
    }
  });

  it('has a Large achievement for each kind that has sizes', () => {
    for (const k of KINDS.filter((x) => x.available && x.sizes)) expect(findAchievement(`large_${k.id}`)).toBeDefined();
  });
});

describe('applyEvent', () => {
  it('unlocks the first solve once', () => {
    const s = emptyAchievements();
    expect(ids(applyEvent(s, solved(), 5))).toEqual(['first_solve', 'first_jigsaw']);
    expect(s.unlocked.first_solve).toBe(5);
    expect(ids(applyEvent(s, solved(), 6))).toEqual([]);
    expect(s.counts.solved).toBe(2);
  });

  it('counts solves to 10', () => {
    const s = emptyAchievements();
    let last: string[] = [];
    for (let i = 0; i < 10; i++) last = ids(applyEvent(s, solved(), i));
    expect(last).toEqual(['solved_10']);
    expect(progressOf(s, findAchievement('solved_50')!)).toEqual({ current: 10, target: 50 });
  });

  it('unlocks the hint and bomb achievements', () => {
    const s = emptyAchievements();
    expect(ids(applyEvent(s, { type: 'help', help: 'hint' }, 1))).toEqual(['use_hint']);
    expect(ids(applyEvent(s, { type: 'help', help: 'bomb' }, 2))).toEqual(['use_bomb']);
    for (let i = 0; i < 48; i++) applyEvent(s, { type: 'help', help: 'hint' }, 3);
    expect(s.unlocked.hints_50).toBeUndefined();
    expect(ids(applyEvent(s, { type: 'help', help: 'hint' }, 4))).toEqual(['hints_50']);
    for (let i = 0; i < 8; i++) applyEvent(s, { type: 'help', help: 'bomb' }, 5);
    expect(s.unlocked.bombs_10).toBeUndefined();
    expect(ids(applyEvent(s, { type: 'help', help: 'bomb' }, 6))).toEqual(['bombs_10']);
  });

  it('gives a first achievement for each kind, whatever the size', () => {
    const s = emptyAchievements();
    for (const k of KINDS.filter((x) => x.available)) {
      expect(ids(applyEvent(s, solved({ kind: k.id, size: 0 }), 1))).toContain(`first_${k.id}`);
      expect(ids(applyEvent(s, solved({ kind: k.id, size: 0 }), 2))).not.toContain(`first_${k.id}`);
    }
    expect(Object.keys(s.unlocked).filter((id) => id.startsWith('first_') && id !== 'first_solve').length).toBe(KINDS.filter((x) => x.available).length);
  });

  it('gives a Large achievement for each kind only at size L or bigger', () => {
    for (const k of KINDS.filter((x) => x.available && x.sizes)) {
      const s = emptyAchievements();
      expect(ids(applyEvent(s, solved({ kind: k.id, size: 1 }), 1))).not.toContain(`large_${k.id}`);
      expect(ids(applyEvent(s, solved({ kind: k.id, size: 2 }), 2))).toEqual([`large_${k.id}`]);
      // the other kinds' stay locked
      expect(Object.keys(s.unlocked).filter((id) => id.startsWith('large_'))).toEqual([`large_${k.id}`]);
    }
  });

  it('unlocks the video and online ones', () => {
    const s = emptyAchievements();
    expect(ids(applyEvent(s, solved({ video: true }), 1))).toContain('solve_video');
    expect(ids(applyEvent(s, solved({ online: true }), 2))).toContain('solve_online');
  });

  it('counts a solve that is told twice once', () => {
    const s = emptyAchievements();
    applyEvent(s, solved({ online: true, once: 'room1' }), 1);
    expect(applyEvent(s, solved({ online: true, once: 'room1' }), 2)).toEqual([]);
    expect(s.counts.solved).toBe(1);
  });

  it('remembers only the last solves that were told', () => {
    const s = emptyAchievements();
    for (let i = 0; i < 80; i++) applyEvent(s, solved({ once: `r${i}` }), i);
    expect(s.once.length).toBe(50);
    expect(s.once.at(-1)).toBe('r79');
  });
});

describe('sizeIndexOf', () => {
  it('finds the size from what the size sets', () => {
    const jig = findKind('jigsaw')!;
    expect(jig.sizes!.values.map((v) => sizeIndexOf(jig, v))).toEqual([0, 1, 2, 3, 4, 5]);
    const rot = findKind('rotascope')!;
    expect(rot.sizes!.values.map((v) => sizeIndexOf(rot, v))).toEqual([0, 1, 2, 3]);
    expect(sizeIndexOf(findKind('focus')!, { pieces: 500 })).toBe(4);
  });
});

describe('AchievementStore', () => {
  it('keeps what was unlocked and counted', () => {
    const mem = new Memory();
    const a = new AchievementStore(mem);
    a.record(solved(), 10);
    a.record({ type: 'help', help: 'hint' }, 11);
    const b = new AchievementStore(mem);
    expect(b.unlockedIds().sort()).toEqual(['first_jigsaw', 'first_solve', 'use_hint']);
    expect(b.state.counts).toEqual({ hints: 1, bombs: 0, solved: 1 });
  });

  it('tells the listeners what an event unlocked, and nothing when nothing was', () => {
    const a = new AchievementStore(null);
    const told: string[][] = [];
    a.onUnlock((list) => told.push(ids(list)));
    a.record({ type: 'help', help: 'hint' });
    a.record({ type: 'help', help: 'hint' });
    expect(told).toEqual([['use_hint']]);
  });

  it('starts from nothing when what is kept is damaged', () => {
    const mem = new Memory();
    mem.setItem('photo-puzzles/achievements/v1', '{"unlocked":{"nope":1,"first_solve":"x"},"counts":{"hints":-3,"bombs":"2"},"once":[1,"a"]}');
    const a = new AchievementStore(mem);
    expect(a.unlockedIds()).toEqual([]);
    expect(a.state.counts).toEqual({ hints: 0, bombs: 0, solved: 0 });
    expect(a.state.once).toEqual(['a']);
    mem.setItem('photo-puzzles/achievements/v1', 'not json');
    expect(new AchievementStore(mem).unlockedIds()).toEqual([]);
  });
});
