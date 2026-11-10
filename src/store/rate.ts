import { NO_RATING, shouldAskToRate, type RateState } from '../core/ratePrompt';
import type { StorageLike } from '../core/prefs';

const KEY = 'photo-puzzles/rate/v1';

/** What this device has counted and shown for the "Rate Me!" prompt (local storage; nothing is sent anywhere). It is the device's, not the account's: the store rating is for the app on this phone. */
export class RateStore {
  data: RateState = { ...NO_RATING };

  constructor(private readonly storage: StorageLike | null) {
    try {
      const raw = JSON.parse(storage?.getItem(KEY) ?? 'null') as Partial<RateState> | null;
      if (raw && typeof raw === 'object') {
        this.data = {
          solved: typeof raw.solved === 'number' && raw.solved >= 0 ? Math.floor(raw.solved) : 0,
          asked: typeof raw.asked === 'number' ? raw.asked : null,
          rated: raw.rated === true,
        };
      }
    } catch {
      /* nothing kept, or unreadable: counting starts again */
    }
  }

  /** A puzzle was solved. */
  solved(): void {
    this.data.solved++;
    this.save();
  }

  /** Whether the prompt is to be shown now. */
  shouldAsk(now = Date.now()): boolean {
    return shouldAskToRate(this.data, now);
  }

  /** The prompt was shown (whatever the player does with it, it is not shown again for three days). */
  asked(now = Date.now()): void {
    this.data.asked = now;
    this.save();
  }

  /** The player pressed Rate Me!. */
  rated(): void {
    this.data.rated = true;
    this.save();
  }

  private save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked: the count is lost, and the prompt comes a little later */
    }
  }
}
