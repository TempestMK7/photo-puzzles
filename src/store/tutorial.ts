import { NO_PROGRESS, type Progress, type Step } from '../core/tutorial';
import type { StorageLike } from '../core/prefs';

const KEY = 'photo-puzzles/tutorial/v1';

/** What this device has shown the player (local storage; nothing is sent anywhere). It is the device's, not the account's: the player has seen it whoever is signed in. */
export class TutorialStore {
  data: Progress = { ...NO_PROGRESS, howto: [] };
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly storage: StorageLike | null) {
    try {
      const raw = JSON.parse(storage?.getItem(KEY) ?? 'null') as Partial<Progress> | null;
      if (raw && typeof raw === 'object') {
        this.data = {
          howto: Array.isArray(raw.howto) ? raw.howto.filter((k): k is string => typeof k === 'string') : [],
          hint: raw.hint === true,
          bomb: raw.bomb === true,
          ad: raw.ad === true,
        };
      }
    } catch {
      /* nothing kept, or unreadable: the player is shown everything again */
    }
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** The player has opened How To Play for this kind of puzzle. */
  seenHowto(kind: string): void {
    if (this.data.howto.includes(kind)) return;
    this.data.howto.push(kind);
    this.save();
  }

  /** The player has taken a step of the walk through hints, bombs and ads. */
  done(step: Exclude<Step, 'howto'>): void {
    if (this.data[step]) return;
    this.data[step] = true;
    this.save();
  }

  private save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked: it is shown again next time */
    }
    for (const fn of this.listeners) fn();
  }
}
