import { ACHIEVEMENTS, applyEvent, emptyAchievements, type AchievementDef, type AchievementState, type Counter, type GameEvent } from '../core/achievements';
import type { StorageLike } from '../core/prefs';
import { adoptDeviceData, ownerKey } from './owner';

const KEY = 'photo-puzzles/achievements/v1';
const COUNTERS: Counter[] = ['hints', 'bombs', 'solved'];

/**
 * The player's achievements on this device: what is unlocked and the counters, kept in the browser's local storage (nothing is sent anywhere). The platforms' own services (Google Play,
 * Steam, Game Center) are told through `onUnlock` by the shell of each, and given `unlockedIds()` again when the game starts, so that an unlock that could not be told (no connection,
 * not signed in yet) is not lost.
 */
export class AchievementStore {
  state: AchievementState = emptyAchievements();
  private listeners: ((unlocked: AchievementDef[]) => void)[] = [];
  /** The account whose achievements these are (nobody: the device's own, for a guest). */
  private owner: string | null = null;

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  /** Switches to the achievements of another player (an account's id, or null for nobody). */
  use(owner: string | null): void {
    if (owner === this.owner) return;
    this.owner = owner;
    if (owner) adoptDeviceData(this.storage, KEY, owner);
    this.state = emptyAchievements();
    this.load();
  }

  private load(): void {
    try {
      const text = this.storage?.getItem(ownerKey(KEY, this.owner));
      if (!text) return;
      const raw = JSON.parse(text) as Partial<AchievementState>;
      const known = new Set(ACHIEVEMENTS.map((a) => a.id));
      if (raw.unlocked && typeof raw.unlocked === 'object') {
        for (const [id, at] of Object.entries(raw.unlocked)) if (known.has(id) && typeof at === 'number') this.state.unlocked[id] = at;
      }
      for (const c of COUNTERS) {
        const n = raw.counts?.[c];
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) this.state.counts[c] = Math.floor(n);
      }
      if (Array.isArray(raw.once)) this.state.once = raw.once.filter((x): x is string => typeof x === 'string');
    } catch {
      // damaged or unavailable storage: start with nothing
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(ownerKey(KEY, this.owner), JSON.stringify(this.state));
    } catch {
      // private mode or full: the game still works, it just forgets
    }
  }

  /** Something the player did: the achievements it unlocked (all of them are told to the listeners at once). */
  record(e: GameEvent, now = Date.now()): AchievementDef[] {
    const unlocked = applyEvent(this.state, e, now);
    this.save();
    if (unlocked.length) for (const l of this.listeners) l(unlocked);
    return unlocked;
  }

  /** Calls `f` with what each event unlocked. */
  onUnlock(f: (unlocked: AchievementDef[]) => void): void {
    this.listeners.push(f);
  }

  isUnlocked(id: string): boolean {
    return this.state.unlocked[id] !== undefined;
  }

  unlockedIds(): string[] {
    return ACHIEVEMENTS.filter((a) => this.isUnlocked(a.id)).map((a) => a.id);
  }
}
