import type { HelpItem } from './protocol';

const KEY = 'photo-puzzles/online/spends';

/** A hint or a bomb that the player used and the server has not been told about yet. `id` is one-time, so that a spend that is sent again (its answer was lost) is counted once. */
export interface Spend {
  id: string;
  item: HelpItem;
}

/**
 * The hints and bombs that were used while the server could not be reached, kept on this device (and in memory if the browser refuses storage) until they have been sent. The counters
 * show what is held less these, so a puzzle played with no connection spends them like any other.
 */
export class SpendQueue {
  private list: Spend[];

  constructor(private readonly store: Storage | null) {
    this.list = this.load();
  }

  private load(): Spend[] {
    try {
      const raw = JSON.parse(this.store?.getItem(KEY) ?? '[]') as unknown;
      if (Array.isArray(raw)) {
        return raw.filter((s): s is Spend => typeof s?.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s.id) && (s.item === 'hint' || s.item === 'bomb'));
      }
    } catch {
      /* unreadable: nothing is waiting */
    }
    return [];
  }

  private save(): void {
    try {
      if (this.list.length) this.store?.setItem(KEY, JSON.stringify(this.list));
      else this.store?.removeItem(KEY);
    } catch {
      /* they wait in memory until the page is closed */
    }
  }

  get size(): number {
    return this.list.length;
  }

  /** How many of this item are waiting to be sent. */
  count(item: HelpItem): number {
    return this.list.filter((s) => s.item === item).length;
  }

  /** The one that has waited longest. */
  first(): Spend | undefined {
    return this.list[0];
  }

  add(item: HelpItem): Spend {
    const spend: Spend = { id: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''), item };
    this.list.push(spend);
    this.save();
    return spend;
  }

  remove(id: string): void {
    this.list = this.list.filter((s) => s.id !== id);
    this.save();
  }
}
