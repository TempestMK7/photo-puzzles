import { bestKey, recordBest, type BestTime, type BestTimes } from '../core/besttimes';
import { KINDS, type KindId } from '../core/kinds';
import type { StorageLike } from '../core/prefs';
import { adoptDeviceData, ownerKey } from './owner';

const KEY = 'photo-puzzles/besttimes/v1';

/** The player's best time for each kind of puzzle and size, on this device (local storage; nothing is sent anywhere). */
export class BestTimeStore {
  data: BestTimes = {};
  /** The account whose times these are (nobody: the device's own, for a guest). */
  private owner: string | null = null;

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  /** Switches to the times of another player (an account's id, or null for nobody). */
  use(owner: string | null): void {
    if (owner === this.owner) return;
    this.owner = owner;
    if (owner) adoptDeviceData(this.storage, KEY, owner);
    this.data = {};
    this.load();
  }

  private load(): void {
    try {
      const text = this.storage?.getItem(ownerKey(KEY, this.owner));
      if (!text) return;
      const raw = JSON.parse(text) as Record<string, Partial<BestTime>>;
      for (const k of KINDS) {
        for (let size = 0; size < (k.sizes?.values.length ?? 0); size++) for (const fast of [false, true]) {
          const e = raw[bestKey(k.id, size, fast)];
          if (!e || typeof e !== 'object') continue;
          if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms < 0 || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
          this.data[bestKey(k.id, size, fast)] = {
            ms: e.ms,
            ...(typeof e.moves === 'number' && e.moves >= 0 ? { moves: Math.floor(e.moves) } : {}),
            file: typeof e.file === 'string' ? e.file : '',
            video: e.video === true,
            at: e.at,
          };
        }
      }
    } catch {
      // damaged or unavailable storage: start with nothing
    }
  }

  /** A solved puzzle: true when it is the new best of its kind and size. */
  record(kind: KindId, size: number, entry: BestTime, fast = false): boolean {
    const isBest = recordBest(this.data, bestKey(kind, size, fast), entry);
    if (isBest) {
      try {
        this.storage?.setItem(ownerKey(KEY, this.owner), JSON.stringify(this.data));
      } catch {
        // private mode or full: the game still works, it just forgets
      }
    }
    return isBest;
  }

  get(kind: KindId, size: number, fast = false): BestTime | undefined {
    return this.data[bestKey(kind, size, fast)];
  }
}
