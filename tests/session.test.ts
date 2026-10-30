import { describe, expect, it } from 'vitest';
import type { Offline } from '../src/online/api';
import { GuestAccount } from '../src/online/guestAccount';
import type { Account } from '../src/online/identity';
import type { ApiFailure, MeResponse } from '../src/online/protocol';
import { OnlineSession, type ProfileApi } from '../src/online/session';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

/** An account that can be signed in and out, with the name its sign-in knows. */
class FakeAccount implements Account {
  user: { id: string; name: string; email?: string; picture?: string } | null = null;
  who() { return this.user; }
  async token() { return this.user ? `account-token-${this.user.id}` : null; }
  async signIn() { this.user = { id: 'acc1', name: 'ann.lee', email: 'ann.lee@example.com' }; }
  signOut() { this.user = null; return false; }
}

function setup(opts: { account?: boolean; storage?: Storage } = {}) {
  const store = opts.storage ?? new MemoryStorage();
  const server = { names: new Map<string, string>(), down: false, calls: [] as string[], guests: 0 };
  const guestFetch = (async (_url: string, init: RequestInit) => {
    if (server.down) throw new TypeError('network');
    const body = JSON.parse(String(init.body)) as { token?: string };
    const id = body.token ? body.token.replace('guest-token-', '') : `g${++server.guests}`;
    return new Response(JSON.stringify({ ok: true, token: `guest-token-${id}`, id, expiresAt: Date.now() + 90 * 24 * 3600 * 1000 }));
  }) as never;
  const guest = new GuestAccount('https://api.example', new MemoryStorage(), { fetch: guestFetch, now: () => Date.now() });
  const account = opts.account === false ? null : new FakeAccount();
  const session = new OnlineSession(account, guest, store);
  const api: ProfileApi = {
    async me(): Promise<MeResponse | ApiFailure | Offline> {
      server.calls.push('me');
      if (server.down) return { ok: false, error: 'offline' };
      const id = session.who()?.id ?? '';
      return { ok: true, id, name: server.names.get(id) ?? null, guest: session.kind() === 'guest' };
    },
    async setName(name: string): Promise<MeResponse | ApiFailure | Offline> {
      server.calls.push(`setName ${name}`);
      if (server.down) return { ok: false, error: 'offline' };
      const id = session.who()!.id;
      server.names.set(id, name);
      return { ok: true, id, name, guest: session.kind() === 'guest' };
    },
  };
  session.attach(api);
  return { session, account, guest, server, store, api };
}

describe('who is playing', () => {
  it('is nobody to begin with, a guest once one is made, and the account when signed in', async () => {
    const t = setup();
    expect(t.session.kind()).toBe('none');
    expect(t.session.who()).toBeNull();
    expect(await t.session.token()).toBeNull();
    expect(await t.session.ensureGuest()).toBe(true);
    expect(t.session.kind()).toBe('guest');
    expect(await t.session.token()).toBe('guest-token-g1');
    await t.session.signIn();
    expect(t.session.kind()).toBe('account');
    expect(await t.session.token()).toBe('account-token-acc1');
    t.session.signOut();
    expect(t.session.kind()).toBe('guest');                                       // the guest is still there
  });

  it('lets only an account make puzzles', async () => {
    const t = setup();
    expect(t.session.canCreate()).toBe(false);
    await t.session.ensureGuest();
    expect(t.session.canCreate()).toBe(false);
    await t.session.signIn();
    expect(t.session.canCreate()).toBe(true);
  });

  it('does not make a guest for an account, and does not need the server for one that exists', async () => {
    const t = setup();
    await t.session.signIn();
    expect(await t.session.ensureGuest()).toBe(true);
    expect(t.server.guests).toBe(0);
  });

  it('cannot make a guest when the server cannot be reached', async () => {
    const t = setup();
    t.server.down = true;
    expect(await t.session.ensureGuest()).toBe(false);
    expect(t.session.kind()).toBe('none');
  });

  it('knows whether this build has a way to sign in', () => {
    expect(setup().session.hasAccounts).toBe(true);
    expect(setup({ account: false }).session.hasAccounts).toBe(false);
  });

  it('drops a guest that the server no longer knows, and never an account', async () => {
    const t = setup();
    await t.session.ensureGuest();
    t.session.signInLost();
    expect(t.session.kind()).toBe('none');
    await t.session.signIn();
    t.session.signInLost();
    expect(t.session.kind()).toBe('account');
  });
});

describe('the name of a guest', () => {
  it('is "Guest" and four digits until chosen, and stays the same', () => {
    const storage = new MemoryStorage();
    const a = setup({ storage });
    expect(a.session.name()).toMatch(/^Guest \d{4}$/);
    expect(a.session.nameChosen()).toBe(false);
    expect(setup({ storage }).session.name()).toBe(a.session.name());
  });

  it('is what the player chose, kept here and sent to the server once there is a guest to send it for', async () => {
    const t = setup();
    expect(await t.session.setName('  Zed  ')).toBe(true);
    expect(t.session.name()).toBe('Zed');
    expect(t.session.nameChosen()).toBe(true);
    expect(t.server.calls).toEqual([]);                                           // nobody to say it for yet
    await t.session.ensureGuest();
    expect(t.server.names.get('g1')).toBe('Zed');
    await t.session.ensureGuest();
    expect(t.server.calls.filter((c) => c.startsWith('setName'))).toHaveLength(1);
    expect(t.session.who()).toEqual({ id: 'g1', name: 'Zed' });
  });

  it('is sent at once when changed by a guest who exists', async () => {
    const t = setup();
    await t.session.ensureGuest();
    expect(await t.session.setName('Zed')).toBe(true);
    expect(await t.session.setName('Zee')).toBe(true);
    expect(t.server.names.get('g1')).toBe('Zee');
    expect(t.session.who()!.name).toBe('Zee');
  });

  it('is kept here when the server cannot be reached, and sent the next time the guest is used', async () => {
    const t = setup();
    await t.session.ensureGuest();
    t.server.down = true;
    expect(await t.session.setName('Zed')).toBe(false);
    expect(t.session.name()).toBe('Zed');
    t.server.down = false;
    await t.session.ensureGuest();
    expect(t.server.names.get('g1')).toBe('Zed');
  });

  it('is refused when it has nothing in it, and the old one stays', async () => {
    const t = setup();
    await t.session.setName('Zed');
    for (const bad of ['', '   ', '\u0000‎']) expect(await t.session.setName(bad)).toBe(false);
    expect(t.session.name()).toBe('Zed');
  });
});

describe('the name of an account', () => {
  it('is the name the sign-in knows when the server has none: kept on the server, and the account is not asked', async () => {
    const t = setup();
    await t.session.signIn();
    expect(t.session.profileLoaded()).toBe(false);
    expect(t.session.needsName()).toBe(false);                                    // not known yet
    await t.session.refreshProfile();
    expect(t.session.profileLoaded()).toBe(true);
    expect(t.session.needsName()).toBe(false);
    expect(t.session.name()).toBe('ann.lee');
    expect(t.server.names.get('acc1')).toBe('ann.lee');
  });

  it('does not leave that name on the device as one the player chose (a guest after signing out is not called by it)', async () => {
    const t = setup();
    await t.session.signIn();
    await t.session.refreshProfile();
    expect(t.session.nameChosen()).toBe(true);                                    // for the account: the server has it
    t.session.signOut();
    expect(t.session.nameChosen()).toBe(false);
    expect(t.session.name()).toMatch(/^Guest \d{4}$/);
  });

  it('is only asked for when the server cannot be given the name that the sign-in knows', async () => {
    const t = setup();
    await t.session.signIn();
    t.api.setName = async () => ({ ok: false, error: 'offline' });
    await t.session.refreshProfile();
    expect(t.session.needsName()).toBe(true);
    expect(t.session.name()).toBe('ann.lee');
  });

  it('is the name the player chose as a guest, if they did', async () => {
    const t = setup();
    await t.session.setName('Zed');
    await t.session.signIn();
    await t.session.refreshProfile();
    expect(t.session.needsName()).toBe(false);
    expect(t.session.name()).toBe('Zed');
    expect(t.server.names.get('acc1')).toBe('Zed');
  });

  it('is kept on the server once chosen, and the account is not asked again', async () => {
    const t = setup();
    await t.session.signIn();
    await t.session.refreshProfile();
    expect(await t.session.setName('Annie')).toBe(true);
    expect(t.session.needsName()).toBe(false);
    expect(t.server.names.get('acc1')).toBe('Annie');
    expect(t.session.who()).toEqual({ id: 'acc1', name: 'Annie' });
    expect(t.session.nameChosen()).toBe(true);
  });

  it('is the server\'s when it has one (signing in on another device), and is not asked for', async () => {
    const t = setup();
    t.server.names.set('acc1', 'Annie');
    await t.session.signIn();
    await t.session.refreshProfile();
    expect(t.session.needsName()).toBe(false);
    expect(t.session.who()!.name).toBe('Annie');
    expect(t.session.nameChosen()).toBe(true);
  });

  it('does not carry over to another account that signs in on the same device', async () => {
    const t = setup();
    t.server.names.set('acc1', 'Annie');
    await t.session.signIn();
    await t.session.refreshProfile();
    t.session.signOut();
    (t.account as FakeAccount).user = { id: 'acc2', name: 'bob' };
    expect(t.session.needsName()).toBe(false);                                    // not asked about yet
    expect(t.session.who()!.name).not.toBe('Annie');
    await t.session.refreshProfile();
    expect(t.session.needsName()).toBe(false);
    expect(t.session.name()).toBe('bob');
    expect(t.server.names.get('acc2')).toBe('bob');
    expect(t.server.names.get('acc1')).toBe('Annie');
  });

  it('is not asked for when the server cannot say (the account can still be used)', async () => {
    const t = setup();
    await t.session.signIn();
    t.server.down = true;
    await t.session.refreshProfile();
    expect(t.session.needsName()).toBe(false);
  });
});

describe('signing in with Google', () => {
  it('is offered only when the account can do it, and goes to Google when used', async () => {
    const went: string[] = [];
    const google = Object.assign(new FakeAccount(), { hasGoogle: true, async signInWithGoogle(hash?: string) { went.push(hash ?? ''); } });
    const guest = new GuestAccount('https://api.example', new MemoryStorage(), { fetch: (async () => new Response('{}')) as never, now: () => Date.now() });
    await new OnlineSession(google, guest, new MemoryStorage()).google!();
    expect(went).toEqual(['']);
    expect(new OnlineSession(Object.assign(new FakeAccount(), { hasGoogle: false, async signInWithGoogle() {} }), guest, new MemoryStorage()).google).toBeUndefined();
    expect(setup().session.google).toBeUndefined();                      // an account that has no Google at all
    expect(setup({ account: false }).session.google).toBeUndefined();
  });
});

describe('the profile picture', () => {
  it('is the one the account has, when its sign-in has one, and nothing for a guest or nobody', async () => {
    const t = setup();
    expect(t.session.picture()).toBeNull();
    (t.account as FakeAccount).user = { id: 'acc1', name: 'Ann', picture: 'https://pictures.example/ann.png' };
    expect(t.session.picture()).toBe('https://pictures.example/ann.png');
    (t.account as FakeAccount).user = { id: 'acc1', name: 'Ann' };
    expect(t.session.picture()).toBeNull();
    expect(setup({ account: false }).session.picture()).toBeNull();
  });
});
