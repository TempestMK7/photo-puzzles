import type { Offline } from './api';
import type { GuestAccount } from './guestAccount';
import type { Account, PasswordAccount } from './identity';
import { cleanName, GUEST_ACCOUNT, type AccountSummary, type ApiFailure, type HelpItem, type ItemResponse, type MeResponse } from './protocol';
import { SpendQueue } from './spends';

const NAME_KEY = 'photo-puzzles/online/player-name';

/** The two requests about the player's own name (`OnlineApi` has them). */
export interface ProfileApi {
  me(): Promise<MeResponse | ApiFailure | Offline>;
  setName(name: string): Promise<MeResponse | ApiFailure | Offline>;
  /** A new account takes the hints and bombs of the guest it was (`guest` is the guest's token). */
  carryGuest(guest: string): Promise<MeResponse | ApiFailure | Offline>;
  /** Spends a hint or a bomb (`id` makes it count once, however often it is sent). */
  useItem?(item: HelpItem, id: string): Promise<ItemResponse | Offline>;
}

/** How long after a spend could not be sent the game tries again, if nothing else has reminded it (the connection coming back, the page being shown). */
const SPEND_RETRY_MS = 20_000;

export type Kind = 'account' | 'guest' | 'none';

/**
 * Who is playing, to the rest of the game: the account the player signed in with, or else a guest, or nobody yet. An account can make puzzles and join them; a guest can only join. Either
 * can choose the name the others see. A guest is made when the game opens (or the player signs out) and nobody is signed in: a guest has hints and bombs, and an ad to watch for more, so
 * the server has to know them.
 *
 * The name is kept on this device and on the server. For a guest it is whatever they chose (or "Guest 1234" until they do). For an account the server's copy decides; one that has none
 * yet gets the name its sign-in knows (see `refreshProfile`).
 */
export class OnlineSession implements Account {
  private api: ProfileApi | null = null;
  /** What the server said about the account that is signed in: loaded once for each account. */
  private profile: { id: string; name: string | null } | null = null;
  /** What the server said the signed-in account has (its type and credits), as of the last time it was asked or told. */
  private standing: { id: string; summary: AccountSummary } | null = null;
  private listeners = new Set<() => void>();
  /** The hints and bombs that were used and have not reached the server yet: the counters show what is held less these. */
  private spends: SpendQueue;
  private flushing = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private derived: { from: AccountSummary; key: string; value: AccountSummary } | null = null;
  /** Told when the server had no hint or bomb left for a spend that was counted here (the account it was told about had fewer). */
  onSpendRefused: ((item: HelpItem) => void) | null = null;
  /** The guests whose hints and bombs have been offered to the account that they became (guest id > account id), so that it is done once a page. */
  private carried = new Set<string>();
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
    this.spends = new SpendQueue(store);
  }

  /** The requests that go to the server; made after the session, because they need its token. */
  attach(api: ProfileApi): void {
    this.api = api;
    if (this.spends.size) void this.flushSpends();                    // (the spends of an earlier visit that could not be sent)
  }

  private load(): { name: string; chosen: boolean } {
    try {
      const raw = JSON.parse(this.store?.getItem(NAME_KEY) ?? 'null') as { name?: unknown; chosen?: unknown } | null;
      const name = cleanName(raw?.name);
      if (name) return { name, chosen: raw?.chosen === true };
    } catch {
      /* unreadable: a new name is made */
    }
    const made = this.freshName();
    this.keep(made);
    return made;
  }

  private freshName(): { name: string; chosen: boolean } {
    return { name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`, chosen: false };
  }

  /** The name that was chosen here before there was an account has gone to the account (or is the account's already): the device goes back to a name of its own, so that it is not given to the next one who signs in. */
  private releaseName(): void {
    this.saved = this.freshName();
    this.keep(this.saved);
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

  /** True if signing out takes the page away and brings it back. */
  signOut(): boolean {
    return this.account?.signOut?.() ?? false;
  }

  /** The game's own e-mail and password pages, in a build whose accounts have them. */
  get passwords(): PasswordAccount | undefined {
    return this.account?.passwords;
  }

  /** The way to sign in with Google, in a build whose user pool has it. */
  get google(): (() => Promise<void>) | undefined {
    const a = this.account;
    return a?.signInWithGoogle && a.hasGoogle ? () => a.signInWithGoogle!() : undefined;
  }

  /** The way to add Google to the account that is signed in, in a build whose user pool has it (ask the server first: `OnlineApi.linkIntent`). */
  get addGoogle(): (() => Promise<void>) | undefined {
    const a = this.account;
    return a?.linkWithGoogle && a.hasGoogle ? () => a.linkWithGoogle!() : undefined;
  }

  /** The account is an administrator (the server says so, or the sign-in is in the administrators' group): it may try a video of any size. */
  isAdmin(): boolean {
    return this.summary().type === 'admin' || this.account?.who()?.admin === true;
  }

  /**
   * The type and credits of the player: a guest has hints and bombs and nothing else, and both show zeros until the server has been asked (`refreshProfile`).
   */
  summary(): AccountSummary {
    const who = this.account?.who() ?? this.guest.who();
    const base = who && this.standing?.id === who.id ? this.standing.summary : GUEST_ACCOUNT;
    const hints = this.spends.count('hint');
    const bombs = this.spends.count('bomb');
    if (!hints && !bombs) return base;
    // (the same object while nothing changes: the displays tell by identity whether the account has said something new)
    const key = `${hints}|${bombs}`;
    if (this.derived?.from === base && this.derived.key === key) return this.derived.value;
    const value = { ...base, hints: Math.max(0, base.hints - hints), bombs: Math.max(0, base.bombs - bombs) };
    this.derived = { from: base, key, value };
    return value;
  }

  /** A hint or bomb was used in a puzzle played alone: the counters show it at once, and the server is told when it can be (now, or when there is a connection again). */
  spend(item: HelpItem): void {
    this.spends.add(item);
    this.changed();
    void this.flushSpends();
  }

  /** A hint or bomb was used in a puzzle played with friends: the room takes it, and the counter is only brought down until the server says. */
  countDown(item: HelpItem): void {
    const s = this.standing;
    if (!s) return;
    const key = item === 'hint' ? 'hints' : 'bombs';
    this.standing = { id: s.id, summary: { ...s.summary, [key]: Math.max(0, s.summary[key] - 1) } };
    this.changed();
  }

  /** Sends the spends that are waiting, one after the other, until the server cannot be reached (they are kept, and tried again). */
  async flushSpends(): Promise<void> {
    if (this.flushing || !this.api?.useItem) return;
    this.flushing = true;
    try {
      for (let next = this.spends.first(); next; next = this.spends.first()) {
        const res = await this.api.useItem(next.item, next.id);
        if (res.ok) {
          this.spends.remove(next.id);
          this.heard(res.account);
          continue;
        }
        if (res.error === 'no-credits' || res.error === 'bad-request') {
          this.spends.remove(next.id);
          if ('account' in res && res.account) this.heard(res.account);
          else this.changed();
          if (res.error === 'no-credits') this.onSpendRefused?.(next.item);
          continue;
        }
        break;                                                           // offline, or not now: it stays
      }
    } finally {
      this.flushing = false;
      if (this.retry) clearTimeout(this.retry);
      this.retry = this.spends.size ? setTimeout(() => void this.flushSpends(), SPEND_RETRY_MS) : null;
    }
  }

  /** What the server said of the player who is here now. */
  private heard(summary: AccountSummary): void {
    const who = this.account?.who() ?? this.guest.who();
    if (!who) return;
    this.standing = { id: who.id, summary };
    this.changed();
  }

  /** The server has said where the player stands (after a puzzle was started, or an ad watched): the displays follow. */
  setSummary(summary: AccountSummary): void {
    const who = this.account?.who() ?? this.guest.who();
    if (!who) return;
    this.standing = { id: who.id, summary };
    this.changed();
  }

  /** Calls `fn` whenever the account's type or credits may have changed (or who is signed in has). Returns the way to stop. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tells those who show the account's standing that it may have changed. */
  changed(): void {
    for (const fn of this.listeners) fn();
  }

  /** The address of the account's profile picture, if the sign-in service has one (a Google sign-in does). */
  picture(): string | null {
    return this.account?.who()?.picture ?? null;
  }

  /** The e-mail address the account was made with (what the sign-in service says), if this is an account. */
  email(): string | null {
    return this.account?.who()?.email ?? null;
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

  /**
   * Asks the server for the account's name. An account that has none yet is given the one its sign-in knows (the name it was made with, or the start of the e-mail address) and can
   * change it in its profile; it is only asked for one if the server cannot be told (`needsName`).
   */
  async refreshProfile(): Promise<void> {
    if (!this.api) return;
    const who = this.account?.who();
    if (!who) {
      // nobody is signed in: the guest (made now if there is none) is asked where they stand, which is hints, bombs and the wait for an ad
      if (!(await this.ensureGuest())) return;
      const id = this.guest.who()?.id;
      const seen = await this.api.me();
      if (seen.ok && id) {
        this.standing = { id, summary: seen.account };
        this.changed();
        if (this.spends.size) void this.flushSpends();
      }
      return;
    }
    await this.carryGuest(who.id);
    const res = await this.api.me();
    if (!res.ok) return;
    this.profile = { id: who.id, name: res.name };
    this.standing = { id: who.id, summary: res.account };
    this.changed();
    if (this.spends.size) void this.flushSpends();
    if (res.name !== null) {
      if (this.saved.chosen && this.saved.name === res.name) this.releaseName();
      return;
    }
    // only the server is told: on this device the name stays what it was, so that it is not taken for a name that the player chose (a guest on the same device would be called by it)
    const given = await this.api.setName(this.name());
    if (given.ok) {
      this.profile = { id: who.id, name: given.name };
      if (this.saved.chosen) this.releaseName();
    }
  }

  /** An account that has just signed in takes the hints and bombs that the guest it was on this device has left (the server decides whether it may: once, and only for a new account). */
  private async carryGuest(account: string): Promise<void> {
    const guest = this.guest.who()?.id;
    if (!guest || !this.api || this.carried.has(`${guest}>${account}`)) return;
    const token = await this.guest.token();
    if (!token) return;
    const res = await this.api.carryGuest(token);
    if (res.ok || res.error !== 'offline') this.carried.add(`${guest}>${account}`);
  }

  /** Whether the server has been asked about the account that is signed in (so that what the pages show for its name will not change when it answers). */
  profileLoaded(): boolean {
    const who = this.account?.who();
    return !who || this.profile?.id === who.id;
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
    const kind = this.kind();
    // an account's name is the server's: kept here as well it would be taken for the name of the next account (or guest) on this device
    if (kind !== 'account') {
      this.saved = { name: clean, chosen: true };
      this.keep(this.saved);
    }
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
