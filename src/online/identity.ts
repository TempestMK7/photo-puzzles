import type { Identity } from './api';

/** Who the player is, as the rest of the game needs to know it: the local build's stand-in, a guest, and the cloud's Cognito account all are one. */
export interface Account {
  /** Who is signed in, from what is kept here (no network); nothing when nobody is. */
  who(): { id: string; name: string } | null;
  /** What goes in the `Authorization` header and in the broker's address: made fresh if it is about to run out. Nothing when nobody is signed in (or the sign-in has ended). */
  token(): Promise<string | null>;
  /** Only an account that needs signing in has these. */
  signIn?(returnHash?: string): Promise<void>;
  signOut?(): void;
}

const ID_KEY = 'photo-puzzles/online/id';
const NAME_KEY = 'photo-puzzles/online/name';
const OUT_KEY = 'photo-puzzles/online/dev-signed-out';

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Who this player is while there is no real sign-in: a made-up id and a name, kept for this browser tab only (so two tabs are two players, which is what trying it out needs). The
 * local server takes whatever it is told; the real server wants a Cognito token in its place.
 */
export class DevIdentity implements Account {
  private store = session();
  private idValue: string;
  private nameValue: string;

  constructor() {
    const random = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    this.idValue = this.store?.getItem(ID_KEY) ?? random(12);
    this.nameValue = this.store?.getItem(NAME_KEY) ?? `Player ${Math.floor(1000 + Math.random() * 9000)}`;
    this.store?.setItem(ID_KEY, this.idValue);
    this.store?.setItem(NAME_KEY, this.nameValue);
  }

  setName(name: string): void {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    this.nameValue = clean;
    this.store?.setItem(NAME_KEY, clean);
  }

  who(): { id: string; name: string } {
    return { id: this.idValue, name: this.nameValue };
  }

  async token(): Promise<string> {
    return this.get().token;
  }

  get(): Identity {
    return { id: this.idValue, name: this.nameValue, token: `dev:${this.idValue}:${encodeURIComponent(this.nameValue)}` };
  }
}

/**
 * The local build's stand-in for an account: the made-up identity above, which can be "signed out" and in again, so that the way a guest plays (and what a guest cannot do) can be tried on
 * a developer's machine without a sign-in service. It starts signed in.
 */
export class DevAccount implements Account {
  private store = session();

  constructor(private readonly dev: DevIdentity) {}

  private get out(): boolean {
    return this.store?.getItem(OUT_KEY) === '1';
  }

  who(): { id: string; name: string } | null {
    return this.out ? null : this.dev.who();
  }

  async token(): Promise<string | null> {
    return this.out ? null : this.dev.get().token;
  }

  async signIn(): Promise<void> {
    this.store?.removeItem(OUT_KEY);
  }

  signOut(): void {
    this.store?.setItem(OUT_KEY, '1');
  }
}
