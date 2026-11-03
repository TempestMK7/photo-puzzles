import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ACHIEVEMENTS } from '../src/core/achievements';
import { tellAchievements } from '../src/platform';

const dir = 'android/app/src/main';
const java = readFileSync(`${dir}/java/com/tempest/photopuzzles/Games.java`, 'utf8');
const xml = readFileSync(`${dir}/res/values/games-ids.xml`, 'utf8');
const names = new Map([...java.matchAll(/NAMES\.put\("([a-z_0-9]+)", "([a-z_0-9]+)"\)/g)].map((m) => [m[1], m[2]]));
const resources = new Set([...xml.matchAll(/name="achievement_([a-z_0-9]+)"/g)].map((m) => m[1]));

describe('Google Play Games ids', () => {
  it('has a Play achievement for each of ours, and each Play achievement is used once', () => {
    const used = ACHIEVEMENTS.map((a) => names.get(a.id) ?? a.id);
    for (const n of used) expect(resources, n).toContain(n);
    expect(new Set(used).size).toBe(used.length);
    expect(resources.size).toBe(used.length);
  });

  it('only renames achievements that exist', () => {
    for (const id of names.keys()) expect(ACHIEVEMENTS.some((a) => a.id === id), id).toBe(true);
  });
});

describe('tellAchievements', () => {
  it('hands the shell the ids as JSON, and does nothing without a shell or without ids', () => {
    const unlockAchievements = vi.fn();
    tellAchievements(['first_solve', 'use_hint'], { unlockAchievements });
    expect(unlockAchievements).toHaveBeenCalledWith('["first_solve","use_hint"]');
    tellAchievements([], { unlockAchievements });
    expect(unlockAchievements).toHaveBeenCalledTimes(1);
    expect(() => tellAchievements(['first_solve'], {})).not.toThrow();
    expect(() => tellAchievements(['first_solve'], { unlockAchievements: () => { throw new Error('x'); } })).not.toThrow();
  });
});
