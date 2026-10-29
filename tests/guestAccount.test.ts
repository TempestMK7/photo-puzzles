import { describe, expect, it } from 'vitest';
import { GuestAccount, type GuestEnv } from '../src/online/guestAccount';

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const DAY = 24 * 3600 * 1000;

function setup(opts: { local?: Storage | null; reply?: (body: { token?: string }) => Response | Promise<Response> } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const env: GuestEnv = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body)) as { token?: string };
      if (opts.reply) return opts.reply(body);
      // the server: a new guest, or a new token for the one that was shown
      const id = body.token ? body.token.split('-')[0] : `g${++n}`;
      return new Response(JSON.stringify({ ok: true, token: `${id}-${clock.t}`, id, expiresAt: clock.t + 90 * DAY }));
    }) as never,
    now: () => clock.t,
  };
  const local = opts.local === undefined ? new MemoryStorage() : opts.local;
  const guest = new GuestAccount('https://api.example', local, env);
  return { guest, clock, calls, local };
}

describe('a guest', () => {
  it('is nobody until one is made, and nothing is asked of the server before', async () => {
    const t = setup();
    expect(t.guest.who()).toBeNull();
    expect(await t.guest.token()).toBeNull();
    expect(t.calls).toHaveLength(0);
  });

  it('is made when asked for, and kept: the same guest the next time, with no more asking', async () => {
    const t = setup();
    expect(await t.guest.ensure()).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe('https://api.example/guest');
    expect(t.calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(t.calls[0].init.body))).toEqual({});
    const me = t.guest.who()!;
    expect(me.id).toBe('g1');
    expect(await t.guest.ensure()).toBe(true);
    expect(await t.guest.token()).toBe(`g1-${t.clock.t}`);
    expect(t.calls).toHaveLength(1);
    const again = new GuestAccount('https://api.example', t.local, { fetch: (() => { throw new Error('no network needed'); }) as never, now: () => t.clock.t });
    expect(again.who()!.id).toBe('g1');
    expect(await again.token()).toBe(`g1-${t.clock.t}`);
  });

  it('asks for a fresh token for the same guest when there are less than 60 days left, and shows the old one', async () => {
    const t = setup();
    await t.guest.ensure();
    const first = await t.guest.token();
    t.clock.t += 31 * DAY;                                                        // 59 days left
    expect(await t.guest.ensure()).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(JSON.parse(String(t.calls[1].init.body))).toEqual({ token: first });
    expect(t.guest.who()!.id).toBe('g1');                                          // the same guest
    expect(await t.guest.token()).not.toBe(first);
  });

  it('goes on with a token that is still good when the server cannot be reached, and has nothing when it has run out', async () => {
    const t = setup();
    await t.guest.ensure();
    const offline = new GuestAccount('https://api.example', t.local, { fetch: (() => Promise.reject(new TypeError('network'))) as never, now: () => t.clock.t });
    t.clock.t += 40 * DAY;                                                         // due for a new one, but still good
    expect(await offline.ensure()).toBe(true);
    expect(await offline.token()).not.toBeNull();
    t.clock.t += 60 * DAY;                                                         // run out
    expect(await offline.ensure()).toBe(false);
    expect(await offline.token()).toBeNull();
  });

  it('cannot be made when the server cannot be reached or says no, and makes nothing', async () => {
    for (const reply of [() => Promise.reject(new TypeError('network')), () => new Response('{"ok":false}', { status: 500 }), () => new Response('not json', { status: 200 })]) {
      const t = setup({ reply: reply as never });
      expect(await t.guest.ensure()).toBe(false);
      expect(t.guest.who()).toBeNull();
      expect(t.local!.getItem('photo-puzzles/online/guest')).toBeNull();
    }
  });

  it('asks once for all who ask together', async () => {
    const t = setup();
    expect(await Promise.all([t.guest.ensure(), t.guest.ensure(), t.guest.ensure()])).toEqual([true, true, true]);
    expect(t.calls).toHaveLength(1);
  });

  it('can be given up (the server did not know the token), and then a new guest is made', async () => {
    const t = setup();
    await t.guest.ensure();
    t.guest.forget();
    expect(t.guest.who()).toBeNull();
    await t.guest.ensure();
    expect(t.guest.who()!.id).toBe('g2');
  });

  it('is kept in memory when the browser will not store anything', async () => {
    const t = setup({ local: null });
    await t.guest.ensure();
    expect(t.guest.who()!.id).toBe('g1');
    expect(await t.guest.token()).not.toBeNull();
  });
});
