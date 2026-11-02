import { describe, expect, it } from 'vitest';
import type { Offline } from '../src/online/api';
import type { GuestAccount } from '../src/online/guestAccount';
import type { Account } from '../src/online/identity';
import { GUEST_ACCOUNT, type AccountSummary, type ApiFailure, type ItemResponse } from '../src/online/protocol';
import { OnlineSession, type ProfileApi } from '../src/online/session';
import { SpendQueue } from '../src/online/spends';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const stock = (more: Partial<AccountSummary> = {}): AccountSummary => ({ ...GUEST_ACCOUNT, type: 'free', hints: 10, bombs: 2, ...more });

describe('the hints and bombs that wait to be sent', () => {
  it('are kept on the device, and come back with the page', () => {
    const store = new MemoryStorage();
    const q = new SpendQueue(store);
    const a = q.add('hint');
    const b = q.add('bomb');
    q.add('hint');
    expect([q.count('hint'), q.count('bomb'), q.size]).toEqual([2, 1, 3]);
    expect(a.id).toMatch(/^[0-9a-f]{24}$/);
    expect(a.id).not.toBe(b.id);
    const again = new SpendQueue(store);
    expect([again.count('hint'), again.count('bomb')]).toEqual([2, 1]);
    expect(again.first()?.id).toBe(a.id);                           // (the one that has waited longest)
    again.remove(a.id);
    expect(new SpendQueue(store).count('hint')).toBe(1);
  });

  it('are nothing when what was kept cannot be read, or is not what it should be', () => {
    const store = new MemoryStorage();
    store.setItem('photo-puzzles/online/spends', 'not json');
    expect(new SpendQueue(store).size).toBe(0);
    store.setItem('photo-puzzles/online/spends', JSON.stringify([{ id: 'x', item: 'hint' }, { id: 'abcdefgh12', item: 'rocket' }, { id: 'abcdefgh12', item: 'bomb' }]));
    expect(new SpendQueue(store).size).toBe(1);
    expect(new SpendQueue(null).add('hint').item).toBe('hint');                  // (no storage: they wait in memory)
  });
});

function setup(account: Partial<AccountSummary> = {}) {
  const store = new MemoryStorage();
  const server = { down: false, calls: [] as { item: string; id: string }[], held: { hints: 10, bombs: 2, ...account }, seen: new Set<string>(), lostAnswers: 0 };
  const user = { id: 'acc1', name: 'Ann' };
  const acct: Account = { who: () => user, token: async () => 't' };
  const guest = { who: () => null, token: async () => null, ensure: async () => false, forget: () => undefined };
  const session = new OnlineSession(acct, guest as unknown as GuestAccount, store);
  const me = () => ({ ok: true as const, id: 'acc1', name: 'Ann', guest: false, account: stock(server.held) });
  const api: ProfileApi = {
    async me() { return me(); },
    async setName() { return me(); },
    async carryGuest() { return me(); },
    async useItem(item, id): Promise<ItemResponse | ApiFailure | Offline> {
      if (server.down) return { ok: false, error: 'offline' };
      server.calls.push({ item, id });
      const key = item === 'hint' ? 'hints' : 'bombs';
      if (!server.seen.has(id)) {
        if (server.held[key] < 1) return { ok: false, error: 'no-credits', item, account: stock(server.held) } as ApiFailure;
        server.held[key]--;
        server.seen.add(id);
      }
      if (server.lostAnswers > 0) {
        server.lostAnswers--;
        return { ok: false, error: 'offline' };                       // (it arrived, and the answer did not)
      }
      return { ok: true, account: stock(server.held) };
    },
  };
  session.attach(api);
  return { session, server, store };
}

describe('the counters, with hints and bombs that the server has not been told about', () => {
  it('go down at once, and stay down while the server cannot be reached', async () => {
    const t = setup();
    await t.session.refreshProfile();
    expect(t.session.summary()).toMatchObject({ hints: 10, bombs: 2 });
    t.server.down = true;
    t.session.spend('hint');
    t.session.spend('hint');
    t.session.spend('bomb');
    await t.session.flushSpends();
    expect(t.session.summary()).toMatchObject({ hints: 8, bombs: 1 });
    expect(t.server.held).toMatchObject({ hints: 10, bombs: 2 });
    await t.session.refreshProfile();                                  // (the server still says 10 and 2: the counters keep the spends)
    expect(t.session.summary()).toMatchObject({ hints: 8, bombs: 1 });
  });

  it('are sent when there is a connection again, one after the other, and then the server\'s own count is shown', async () => {
    const t = setup();
    await t.session.refreshProfile();
    t.server.down = true;
    t.session.spend('hint');
    t.session.spend('bomb');
    await t.session.flushSpends();
    t.server.down = false;
    await t.session.flushSpends();
    expect(t.server.calls.map((c) => c.item)).toEqual(['hint', 'bomb']);
    expect(t.server.held).toMatchObject({ hints: 9, bombs: 1 });
    expect(t.session.summary()).toMatchObject({ hints: 9, bombs: 1 });
    t.server.calls.length = 0;
    await t.session.flushSpends();
    expect(t.server.calls).toEqual([]);                                // (nothing is left to send)
  });

  it('count a spend once when it was sent twice (its answer was lost the first time)', async () => {
    const t = setup();
    await t.session.refreshProfile();
    t.server.lostAnswers = 1;
    t.session.spend('hint');
    await t.session.flushSpends();                                     // the server has taken it, and the answer did not come
    expect(t.server.held.hints).toBe(9);
    expect(t.session.summary().hints).toBe(9);
    await t.session.flushSpends();                                     // sent again with the same id
    expect(t.server.held.hints).toBe(9);
    expect(t.server.calls[0].id).toBe(t.server.calls[1].id);
    expect(t.session.summary().hints).toBe(9);
  });

  it('are dropped, and the player told, when the server had none left', async () => {
    const t = setup({ hints: 0 });
    await t.session.refreshProfile();
    expect(t.session.summary().hints).toBe(0);
    const refused: string[] = [];
    t.session.onSpendRefused = (item) => refused.push(item);
    t.session.spend('hint');
    await t.session.flushSpends();
    expect(refused).toEqual(['hint']);
    expect(t.session.summary().hints).toBe(0);
    t.server.calls.length = 0;
    await t.session.flushSpends();
    expect(t.server.calls).toEqual([]);                                // (not sent again)
  });

  it('count down in a puzzle played with friends without waiting to be sent (the room takes them)', async () => {
    const t = setup();
    await t.session.refreshProfile();
    t.session.countDown('bomb');
    expect(t.session.summary()).toMatchObject({ hints: 10, bombs: 1 });
    expect(t.server.calls).toEqual([]);
  });

  it('show the same object while nothing changes, for the displays that tell by identity', async () => {
    const t = setup();
    await t.session.refreshProfile();
    t.server.down = true;
    t.session.spend('hint');
    expect(t.session.summary()).toBe(t.session.summary());
  });
});
