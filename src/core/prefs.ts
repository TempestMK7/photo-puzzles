import { KINDS, type KindId, type Settings } from './kinds';
import { randomSeedText } from './rng';

/** What the game remembers between visits. */
export interface PrefsData {
  seed: string;
  kind: KindId;
  /** Id of the chosen photo ('' = the first one). */
  photo: string;
  settings: Settings;
  /** Best times in milliseconds by recordKey(). */
  best: Record<string, number>;
  /** Sound of a video puzzle is off. */
  muted: boolean;
  /** How My Files is listed: in the order the files were added, or by name. */
  sort: 'added' | 'name';
}

/** The part of the Storage interface that is used (so tests can pass a plain object). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'photo-puzzles/v1';

export class Prefs {
  data: PrefsData;

  constructor(private readonly storage: StorageLike | null) {
    this.data = { seed: randomSeedText(), kind: 'focus', photo: '', settings: {}, best: {}, muted: false, sort: 'added' };
    this.load();
  }

  private load(): void {
    try {
      const text = this.storage?.getItem(KEY);
      if (!text) return;
      const raw = JSON.parse(text) as Partial<PrefsData>;
      if (typeof raw.seed === 'string' && raw.seed) this.data.seed = raw.seed;
      if (typeof raw.kind === 'string' && KINDS.some((k) => k.id === raw.kind && k.available)) this.data.kind = raw.kind as KindId;
      if (typeof raw.photo === 'string') this.data.photo = raw.photo;
      if (raw.settings && typeof raw.settings === 'object') this.data.settings = { ...raw.settings };
      if (raw.best && typeof raw.best === 'object') this.data.best = { ...raw.best };
      if (typeof raw.muted === 'boolean') this.data.muted = raw.muted;
      if (raw.sort === 'added' || raw.sort === 'name') this.data.sort = raw.sort;
    } catch {
      // damaged or unavailable storage: start from the defaults
    }
  }

  save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // private mode or full: the game still works, it just forgets
    }
  }

  /** Records a finished puzzle; true when it is a new best. */
  recordTime(key: string, ms: number): boolean {
    const old = this.data.best[key];
    if (old !== undefined && old <= ms) return false;
    this.data.best[key] = ms;
    this.save();
    return true;
  }

  bestTime(key: string): number | undefined {
    return this.data.best[key];
  }
}

/** How long ago, roughly: "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago". */
export function formatAgo(now: number, then: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(mm % 60).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
