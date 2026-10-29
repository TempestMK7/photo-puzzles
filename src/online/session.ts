import type { Offline } from './api';
import type { GuestAccount } from './guestAccount';
import type { Account } from './identity';
import { cleanName, type ApiFailure, type MeResponse } from './protocol';

const NAME_KEY = 'photo-puzzles/online/player-name';

/** The two requests about the player's own name (`OnlineApi` has them). */
export interface ProfileApi {
  me(): Promise<MeResponse | ApiFailure | Offline>;
  setName(name: string): Promise<MeResponse | ApiFailure | Offline>;
}

export type Kind = 'account' | 'guest' | 'none';

/**
 * Who is playing, to the rest of the game: the account the player signed in with, or else a guest, or nobody yet. An account can make puzzles and join them; a guest can only join. Either
 * can choose the name the others see. A guest is made when they first need to be (joining a puzzle), not before.
 *
 * The name is kept on this device and on the server. For a guest it is whatever they chose (or "Guest 1234" until they do). For an account the server's copy decides, and an account that
 * has none yet is asked for one (`needsName`): it is what the others will call them, and the sign-in service only knows an e-mail address.
 */
export class OnlineSession implements Account {
  private api: ProfileApi | null = null;
  /** What the server said about the account that is signed in: loaded once for each account. */
  private profile: { id: string; name: string | null } | null = null;
  private saved: { name: string; chosen: boolean };
  /** The guest whose name the server has been given. */
  private pushedFor = '';

  constructor(
    /** The way to sign in (Cognito, or the local build's stand-in); nothing in a build that has none. */
    private readonly account: Account | null,
    private readonly guest: GuestAccount,
    private readonly store: Storage | null,
  ) {
    this.saved = this.load();
  }

  /** The requests that go to the server; made after the session, because they need its token. */
  attach(api: ProfileApi): void {
    this.api = api;
  }

  private load(): { name: string; chosen: boolean } {
    try {
      const raw = JSON.parse(this.store?.getItem(NAME_KEY) ?? 'null') as { name?: unknown; chosen?: unknown } | null;
      const name = cleanName(raw?.name);
      if (name) return { name, chosen: raw?.chosen === true };
    } catch {
      /* unreadable: a new name is made */
    }
    const made = { name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`, chosen: false };
    this.keep(made);
    return made;
  }

  private keep(s: { name: string; chosen: boolean }): void {
    try {
      this.store?.setItem(NAME_KEY, JSON.stringify(s));
    } catch {
      /* it lasts until the page is closed */
    }
  }

  kind(): Kind {
    return this.account?.who() ? 'account' : this.guest.who() ? 'guest' : 'none';
  }

  /** Whether this build has a way to sign in at all. */
  get hasAccounts(): boolean {
    return !!this.account;
  }

  /** Making a puzzle needs an account. */
  canCreate(): boolean {
    return this.kind() === 'account';
  }

  who(): { id: string; name: string } | null {
    const a = this.account?.who();
    if (a) return { id: a.id, name: this.name() };
    const g = this.guest.who();
    return g ? { id: g.id, name: this.saved.name } : null;
  }

  token(): Promise<string | null> {
    return this.kind() === 'account' ? this.account!.token() : this.guest.token();
  }

  signIn(returnHash?: string): Promise<void> {
    return this.account?.signIn?.(returnHash) ?? Promise.resolve();
  }

  signOut(): void {
    this.account?.signOut?.();
  }

  /** The server does not know the token that was shown: a guest's is dropped (the next thing that needs one makes a new guest). */
  signInLost(): void {
    if (this.kind() === 'guest') this.guest.forget();
  }

  /** Makes sure the player is someone the server knows: an account is; a guest is made (or renewed) now. False if that could not be done. */
  async ensureGuest(): Promise<boolean> {
    if (this.kind() === 'account') return true;
    if (!(await this.guest.ensure())) return false;
    const id = this.guest.who()?.id;
    // a name chosen before there was a guest goes to the server now
    if (id && this.saved.chosen && this.pushedFor !== id && this.api && (await this.api.setName(this.saved.name)).ok) this.pushedFor = id;
    return true;
  }

  /** Asks the server for the account's name (an account is asked for one if it has none). */
  async refreshProfile(): Promise<void> {
    const who = this.account?.who();
    if (!who || !this.api) return;
    const res = await this.api.me();
    if (res.ok) this.profile = { id: who.id, name: res.name };
  }

  /** An account that has signed in and has not chosen a name yet. */
  needsName(): boolean {
    const who = this.account?.who();
    return !!who && this.profile?.id === who.id && this.profile.name === null;
  }

  /** Whether the player has chosen the name that is shown (and not just been given one). */
  nameChosen(): boolean {
    return this.kind() === 'account' ? !!this.profile?.name || this.saved.chosen : this.saved.chosen;
  }

  /** The name to show in the box where the player can change it. For an account that has none yet, the name that was chosen as a guest if there is one, otherwise what the sign-in knows. */
  name(): string {
    const a = this.account?.who();
    if (!a) return this.saved.name;
    if (this.profile?.id === a.id && this.profile.name) return this.profile.name;
    return this.saved.chosen ? this.saved.name : a.name;
  }

  /** Keeps the name (here, and on the server if the player is known to it). False if it was not valid, or the server could not be reached (it is kept here and sent when it can be). */
  async setName(raw: string): Promise<boolean> {
    const clean = cleanName(raw);
    if (!clean) return false;
    this.saved = { name: clean, chosen: true };
    this.keep(this.saved);
    const kind = this.kind();
    if (kind === 'none') return true;                                       // there is no guest yet: the name goes with the first one
    if (!this.api) return false;
    const res = await this.api.setName(clean);
    if (!res.ok) return false;
    const who = this.account?.who();
    if (kind === 'account' && who) this.profile = { id: who.id, name: res.name };
    else this.pushedFor = res.id;
    return true;
  }
}
