import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, cleanName, NAME_MAX } from '../src/online/protocol';
import { DynamoStore } from '../server/src/aws/dynamo';
import { GUEST_LIFE_MS, GuestTokens, TokenAuth } from '../server/src/guest';
import { MemoryStore } from '../server/src/memory';
import { createRouter, DevAuth } from '../server/src/router';
import { FakeDynamo } from './helpers/fakeDynamo';
import { DAY, open, request, world, type MakeStore } from './helpers/world';

const KEY = new Uint8Array(32).fill(9);

describe('the names that are kept', () => {
  it('squeezes spaces, drops control and direction characters, and cuts to the longest a name may be', () => {
    expect(cleanName('  Ann   Lee ')).toBe('Ann Lee');
    expect(cleanName('A\u0000n‮n')).toBe('Ann');
    expect(cleanName('x'.repeat(NAME_MAX + 10))).toBe('x'.repeat(NAME_MAX));
    expect(cleanName('Zoë 🎉')).toBe('Zoë 🎉');
    expect(Array.from(cleanName('🎉'.repeat(40))!)).toHaveLength(NAME_MAX);
  });
  it('is nothing when nothing is left, or when it is not text', () => {
    for (const bad of ['', '   ', '\u0000‎', 5, null, undefined, {}]) expect(cleanName(bad), String(bad)).toBeNull();
  });
});

describe('GuestTokens', () => {
  const clock = { t: 1_700_000_000_000, now() { return this.t; } };
  const guests = () => new GuestTokens(KEY, clock);

  it('makes a token for a new guest, and knows it again', async () => {
    const g = guests();
    const a = await g.issue();
    expect(a.id).toMatch(/^g[A-Za-z0-9_-]{22}$/);
    expect(a.expiresAt).toBe(clock.t + GUEST_LIFE_MS);
    expect(await g.verify(a.token)).toBe(a.id);
    expect((await g.issue()).id).not.toBe(a.id);
  });

  it('makes a new token for the same guest when asked with their id', async () => {
    const g = guests();
    const a = await g.issue();
    clock.t += 30 * DAY;
    const b = await g.issue(a.id);
    expect(b.id).toBe(a.id);
    expect(b.expiresAt).toBeGreaterThan(a.expiresAt);
    expect(await g.verify(b.token)).toBe(a.id);
  });

  it('turns away a token that was changed, signed with another key, or has run out', async () => {
    const g = guests();
    const a = await g.issue();
    const [prefix, payload, sig] = a.token.split('.');
    const other = JSON.stringify({ i: `g${'A'.repeat(22)}`, e: clock.t + 1e9 });
    const forged = `${prefix}.${Buffer.from(other).toString('base64url')}.${sig}`;
    expect(await g.verify(forged)).toBeNull();                                   // another guest's id on this signature
    expect(await g.verify(`${prefix}.${payload}.${'0'.repeat(sig.length)}`)).toBeNull();
    expect(await new GuestTokens(new Uint8Array(32).fill(1), clock).verify(a.token)).toBeNull();
    for (const junk of ['', 'g1.', 'g1.a', 'g1.a.b.c', 'g2.x.y', `${a.token}.extra`, 'Bearer x', 'dev:ann:Ann']) expect(await g.verify(junk), junk).toBeNull();
    clock.t += GUEST_LIFE_MS + 1;
    expect(await g.verify(a.token)).toBeNull();
  });

  it('does not take an id that is not a guest id, even with a good signature', async () => {
    const g = guests();
    const t = await g.issue('not-a-guest-id');
    expect(await g.verify(t.token)).toBeNull();
  });
});

describe('TokenAuth', () => {
  const clock = { now: () => 1_700_000_000_000 };
  const guests = new GuestTokens(KEY, clock);
  const auth = new TokenAuth(guests, new DevAuth());

  it('knows a guest by their token, and leaves the other kinds to the accounts', async () => {
    const g = await guests.issue();
    expect(await auth.verify(g.token)).toEqual({ id: g.id, name: 'Guest', guest: true });
    expect(await auth.verify('dev:ann1:Ann')).toEqual({ id: 'ann1', name: 'Ann' });
  });
  it('does not hand a bad guest token to the accounts', async () => {
    expect(await auth.verify('g1.forged.token')).toBeNull();
  });
});

const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

describe.each(stores)('guests and names on %s', (_name, makeStore) => {
  const setup = () => {
    const w = world({ freeRoomsPerWeek: 50 }, makeStore);
    const guests = new GuestTokens(KEY, w.clock);
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests });
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await route({ method, path, query: new URLSearchParams(), authorization: token ? `Bearer ${token}` : undefined, body: new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body)) });
      return { status: res.status, body: res.body as Record<string, any> };
    };
    return { w, guests, call };
  };
  const ann = 'dev:ann1:Ann';

  describe('getting a guest token', () => {
    it('gives one to whoever asks, and the same guest again to one who shows a good token', async () => {
      const { call, guests } = setup();
      const first = await call('POST', '/guest');
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);
      expect(await guests.verify(first.body.token)).toBe(first.body.id);
      const again = await call('POST', '/guest', undefined, { token: first.body.token });
      expect(again.body.id).toBe(first.body.id);
      const stranger = await call('POST', '/guest', undefined, { token: 'g1.forged.token' });
      expect(stranger.body.id).not.toBe(first.body.id);
    });
  });

  describe('the name', () => {
    it('is nothing until it is chosen, then is what was chosen (cleaned), for a guest and for an account', async () => {
      const { call } = setup();
      const g = (await call('POST', '/guest')).body;
      expect((await call('GET', '/me', g.token)).body).toEqual({ ok: true, id: g.id, name: null, guest: true });
      expect((await call('PUT', '/me', g.token, { name: '  Zed   Zee ' })).body).toMatchObject({ ok: true, name: 'Zed Zee', guest: true });
      expect((await call('GET', '/me', g.token)).body.name).toBe('Zed Zee');
      expect((await call('GET', '/me', ann)).body).toEqual({ ok: true, id: 'ann1', name: null, guest: false });
      await call('PUT', '/me', ann, { name: 'Annie' });
      expect((await call('GET', '/me', ann)).body.name).toBe('Annie');
    });

    it('is refused when there is nothing to keep, and needs a sign-in', async () => {
      const { call } = setup();
      const g = (await call('POST', '/guest')).body;
      for (const name of ['', '   ', '\u0000', 7, null]) {
        const r = await call('PUT', '/me', g.token, { name });
        expect(r.status, String(name)).toBe(400);
        expect(r.body.error).toBe('bad-request');
      }
      expect((await call('PUT', '/me', g.token)).status).toBe(400);
      expect((await call('GET', '/me')).status).toBe(401);
      expect((await call('PUT', '/me', undefined, { name: 'X' })).status).toBe(401);
      expect((await call('GET', '/me', 'g1.forged.token')).status).toBe(401);
    });
  });

  describe('what a guest may do', () => {
    it('may not make a puzzle', async () => {
      const { call } = setup();
      const g = (await call('POST', '/guest')).body;
      const r = await call('POST', '/rooms', g.token, request());
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ ok: false, error: 'account-required' });
    });

    it('may join a puzzle with the link, under the name they chose, and see it, play in it and list it', async () => {
      const { w, call } = setup();
      const made = await open(w, { id: 'ann1', name: 'Ann' });
      const g = (await call('POST', '/guest')).body;
      await call('PUT', '/me', g.token, { name: 'Zed' });
      const joined = await call('POST', '/join', g.token, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
      expect(joined.status).toBe(200);
      expect(joined.body.room.members.map((m: { name: string }) => m.name)).toEqual(['Ann', 'Zed']);
      expect((await call('GET', `/rooms/${made.roomId}`, g.token)).status).toBe(200);
      expect((await call('GET', '/rooms', g.token)).body.rooms).toHaveLength(1);
      expect((await call('POST', `/rooms/${made.roomId}/leave`, g.token, {})).status).toBe(200);
      expect((await call('GET', '/rooms', g.token)).body.rooms).toHaveLength(0);
    });

    it('joins with the name "Guest" until they choose one', async () => {
      const { w, call } = setup();
      const made = await open(w, { id: 'ann1', name: 'Ann' });
      const g = (await call('POST', '/guest')).body;
      const joined = await call('POST', '/join', g.token, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
      expect(joined.body.room.members.map((m: { name: string }) => m.name)).toEqual(['Ann', 'Guest']);
    });

    it('knocks like anyone, with the chosen name', async () => {
      const { w, call } = setup();
      const made = await open(w, { id: 'ann1', name: 'Ann' });
      const g = (await call('POST', '/guest')).body;
      await call('PUT', '/me', g.token, { name: 'Zed' });
      const knock = await call('POST', '/join', g.token, { protocol: PROTOCOL_VERSION, code: made.invite.code });
      expect(knock.body.error).toBe('knock-pending');
      expect((await call('POST', `/rooms/${made.roomId}/knock/${g.id}`, ann, { allow: true })).status).toBe(200);
      const joined = await call('POST', '/join', g.token, { protocol: PROTOCOL_VERSION, code: made.invite.code });
      expect(joined.body.room.members.map((m: { name: string }) => m.name)).toContain('Zed');
    });
  });

  describe('what an account may do', () => {
    it('makes a puzzle under the name they chose, not the one their token came with', async () => {
      const { w, call } = setup();
      await call('PUT', '/me', ann, { name: 'Annie' });
      const made = await open(w, { id: 'ann1', name: 'ann-from-the-token' });
      const got = await call('GET', `/rooms/${made.roomId}`, ann);
      expect(got.body.room.members[0].name).toBe('Annie');
    });

    it('sends a player out of a puzzle through the router, and only for the owner', async () => {
      const { w, call, guests } = setup();
      const made = await open(w, { id: 'ann1', name: 'Annie' });
      const g = await guests.issue();
      await w.service.join({ id: g.id, name: 'Zed', guest: true }, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
      expect((await call('POST', `/rooms/${made.roomId}/members/${g.id}/remove`, g.token)).status).toBe(403);
      expect((await call('POST', `/rooms/${made.roomId}/members/${g.id}/remove`, ann)).status).toBe(200);
      expect((await call('GET', `/rooms/${made.roomId}`, g.token)).status).toBe(404);
      expect((await call('POST', `/rooms/${made.roomId}/members/${g.id}`, ann)).status).toBe(404);
    });

    it('makes a puzzle through the router too', async () => {
      const { call } = setup();
      const r = await call('POST', '/rooms', ann, request());
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    });
  });

  it('forgets a guest\'s name after a while, and an account\'s never', async () => {
    const { w, call } = setup();
    const g = (await call('POST', '/guest')).body;
    await call('PUT', '/me', g.token, { name: 'Zed' });
    await call('PUT', '/me', ann, { name: 'Annie' });
    w.clock.t += 101 * DAY;
    // (the memory store does not forget: only a store with an expiry does, and DynamoDB's is checked when the name is read)
    const guestName = (await w.store.getName(g.id)) ?? null;
    if (_name === 'DynamoDB') expect(guestName).toBeNull();
    expect(await w.store.getName('ann1')).toBe('Annie');
  });
});
