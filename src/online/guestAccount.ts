import type { Account } from './identity';
import type { GuestResponse } from './protocol';

const KEY = 'photo-puzzles/online/guest';
/** The server's token lasts 90 days; when a token has less than this left, the game asks for a fresh one for the same guest (it does so whenever it is used). */
const RENEW_WHEN_MS = 60 * 24 * 3600 * 1000;

interface Stored {
  token: string;
  id: string;
  expiresAt: number;
}

export interface GuestEnv {
  fetch: typeof fetch;
  now(): number;
}

/**
 * A player without an account. The server gives them an id and a token (`POST /guest`); the game keeps both on this device, so that they are the same player the next time, and
 * shows the token wherever an account's token would go. A guest can join puzzles and play in them, not make them. Nothing is made until it is needed: a visitor who only looks at
 * the game is not a guest.
 */
export class GuestAccount implements Account {
  private memory: Stored | null = null;
  private pending: Promise<Stored | null> | null = null;

  constructor(
    private readonly base: string,
    private readonly local: Storage | null,
    private readonly env: GuestEnv = { fetch: (...a) => fetch(...a), now: () => Date.now() },
  ) {}

  private read(): Stored | null {
    try {
      const raw = this.local?.getItem(KEY);
      if (raw) return JSON.parse(raw) as Stored;
    } catch {
      /* unreadable: as if nothing were kept */
    }
    return this.memory;
  }

  private write(s: Stored | null): void {
    this.memory = s;
    try {
      if (s) this.local?.setItem(KEY, JSON.stringify(s));
      else this.local?.removeItem(KEY);
    } catch {
      /* the memory copy lasts until the page is closed */
    }
  }

  /** The guest's id (the name is the player's own choice: see `OnlineSession`). Nobody until a guest has been made. */
  who(): { id: string; name: string } | null {
    const s = this.read();
    return s ? { id: s.id, name: 'Guest' } : null;
  }

  /** Makes sure there is a guest with a token that is good for a while: makes one, or renews the one there is. False if that could not be done. */
  async ensure(): Promise<boolean> {
    const s = this.read();
    if (s && s.expiresAt - this.env.now() > RENEW_WHEN_MS) return true;
    return (await this.fresh()) !== null;
  }

  async token(): Promise<string | null> {
    const s = this.read();
    if (!s) return null;
    if (s.expiresAt - this.env.now() <= RENEW_WHEN_MS) return (await this.fresh())?.token ?? null;
    return s.token;
  }

  /** Gives up this guest (the server did not know the token): the next `ensure` makes a new one. */
  forget(): void {
    this.write(null);
  }

  private fresh(): Promise<Stored | null> {
    this.pending ??= this.request().finally(() => (this.pending = null));
    return this.pending;
  }

  private async request(): Promise<Stored | null> {
    const had = this.read();
    try {
      const res = await this.env.fetch(`${this.base}/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(had ? { token: had.token } : {}) });
      const body = (await res.json()) as GuestResponse | { ok: false };
      if (!res.ok || !body.ok) throw new Error('refused');
      const s: Stored = { token: body.token, id: body.id, expiresAt: body.expiresAt };
      this.write(s);
      return s;
    } catch {
      // no network, or the server said no: a token that is still good goes on being used
      return had && had.expiresAt > this.env.now() ? had : null;
    }
  }
}
