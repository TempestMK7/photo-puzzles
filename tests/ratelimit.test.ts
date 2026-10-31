import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/online/protocol';
import { DynamoRates } from '../server/src/aws/dynamo';
import { GuestTokens, TokenAuth } from '../server/src/guest';
import { MemoryRates } from '../server/src/memory';
import { DEFAULT_RATES, RateLimiter, clientKey, type Rates } from '../server/src/ratelimit';
import { createRouter, DevAuth } from '../server/src/router';
import type { RateCounter } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { open, request, world } from './helpers/world';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe('clientKey', () => {
  it('keeps an IPv4 address, and an IPv6 one by its network (the first four groups)', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2');
    expect(clientKey('2001:DB8:1:2::5')).toBe('2001:db8:1:2');
    expect(clientKey('2001:db8::1')).toBe('2001:db8');
    expect(clientKey(undefined)).toBe('unknown');
  });
});

const counters: [string, (clock: { now(): number }) => { counter: RateCounter; db?: FakeDynamo }][] = [
  ['memory', (clock) => ({ counter: new MemoryRates(clock) })],
  ['DynamoDB', (clock) => { const db = new FakeDynamo(); return { counter: new DynamoRates(db, 'table', clock), db }; }],
];

describe.each(counters)('counting in windows, on %s', (_name, make) => {
  const clock = { t: 10 * HOUR + 5 * MIN, now() { return this.t; } };

  it('counts per key and per window, and starts again with the next window', async () => {
    const { counter } = make(clock);
    expect(await counter.count('a', HOUR)).toBe(0);
    expect(await counter.add('a', HOUR)).toBe(1);
    expect(await counter.add('a', HOUR)).toBe(2);
    expect(await counter.add('b', HOUR)).toBe(1);
    expect(await counter.count('a', HOUR)).toBe(2);
    expect(await counter.count('a', 15 * MIN)).toBe(0);                                     // another length of window is another count
    clock.t = 11 * HOUR + 1;
    expect(await counter.count('a', HOUR)).toBe(0);
    expect(await counter.add('a', HOUR)).toBe(1);
  });

  it('counts exactly when many ask at once', async () => {
    const { counter } = make(clock);
    const n = await Promise.all(Array.from({ length: 10 }, () => counter.add('k', HOUR)));
    expect([...n].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('what DynamoDB is left with', () => {
  it('one item per key and window, which DynamoDB may delete a window or two later', async () => {
    const clock = { t: 10 * HOUR + 5 * MIN, now() { return this.t; } };
    const db = new FakeDynamo();
    await new DynamoRates(db, 'table', clock).add('guest#1.2.3.4', HOUR);
    const [item] = [...db.items.values()];
    expect(item).toMatchObject({ pk: 'RATE#guest#1.2.3.4#10', sk: 'COUNT', n: 1 });
    expect(item.ttl).toBe(Math.ceil((12 * HOUR) / 1000));
  });
});

describe('the limits on the API', () => {
  const rates: Rates = {
    newGuests: { perIp: 3, windowMs: HOUR },
    failedJoins: { perIp: 5, perPlayer: 3, windowMs: 15 * MIN },
    creations: { perIp: 2, windowMs: HOUR },
    reports: { perPlayer: 2, windowMs: HOUR },
    playback: { perPlayer: 2, windowMs: MIN },
  };
  const KEY = new Uint8Array(32).fill(9);

  function setup(counter?: (clock: { now(): number }) => RateCounter) {
    const w = world({ freeRoomsPerWeek: 50 });
    const guests = new GuestTokens(KEY, w.clock);
    const logged: unknown[] = [];
    const limiter = new RateLimiter(counter ? counter(w.clock) : new MemoryRates(w.clock), w.clock, rates, (e) => logged.push(e));
    const route = createRouter({ service: w.service, auth: new TokenAuth(guests, new DevAuth()), media: w.media, guests, limiter });
    const call = async (method: string, path: string, o: { token?: string; ip?: string; body?: unknown } = {}) => {
      const res = await route({ method, path, query: new URLSearchParams(), ip: o.ip ?? '198.51.100.1', authorization: o.token ? `Bearer ${o.token}` : undefined, body: new TextEncoder().encode(o.body === undefined ? '' : JSON.stringify(o.body)) });
      return { status: res.status, body: res.body as Record<string, any> };
    };
    const join = (token: string, code: string, ip?: string, secret?: string) => call('POST', '/join', { token, ip, body: { protocol: PROTOCOL_VERSION, code, ...(secret ? { secret } : {}) } });
    return { w, call, join, logged };
  }
  const ann = 'dev:ann1:Ann';

  describe('guests', () => {
    it('lets an address make only so many new ones in a window, and then starts again', async () => {
      const { call, w } = setup();
      for (let i = 0; i < 3; i++) expect((await call('POST', '/guest')).status).toBe(200);
      const refused = await call('POST', '/guest');
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ ok: false, error: 'rate-limited' });
      expect(refused.body.retryAt).toBeGreaterThan(w.clock.t);
      expect(refused.body.retryAt - w.clock.t).toBeLessThanOrEqual(HOUR);
      expect((await call('POST', '/guest', { ip: '198.51.100.2' })).status).toBe(200);        // another address is not held back
      w.clock.t = refused.body.retryAt;
      expect((await call('POST', '/guest')).status).toBe(200);
    });

    it('does not count a guest who comes back with a good token', async () => {
      const { call } = setup();
      const first = (await call('POST', '/guest')).body;
      for (let i = 0; i < 10; i++) {
        const again = await call('POST', '/guest', { body: { token: first.token } });
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(first.id);
      }
      expect((await call('POST', '/guest')).status).toBe(200);                                // two new ones are still left
      expect((await call('POST', '/guest')).status).toBe(200);
    });

    it('counts a token that is not good as a new guest', async () => {
      const { call } = setup();
      for (let i = 0; i < 3; i++) expect((await call('POST', '/guest', { body: { token: 'g1.forged.token' } })).status).toBe(200);
      expect((await call('POST', '/guest', { body: { token: 'g1.forged.token' } })).status).toBe(429);
    });

    it('takes the addresses of one IPv6 network for one', async () => {
      const { call } = setup();
      for (let i = 0; i < 3; i++) expect((await call('POST', '/guest', { ip: `2001:db8:1:2::${i + 1}` })).status).toBe(200);
      expect((await call('POST', '/guest', { ip: '2001:db8:1:2:aaaa::9' })).status).toBe(429);
      expect((await call('POST', '/guest', { ip: '2001:db8:1:3::1' })).status).toBe(200);
    });
  });

  describe('codes', () => {
    it('turns a player away after so many tries that found nothing, even with the right code, and forgives them in the next window', async () => {
      const { join, w } = setup();
      const made = await open(w);
      const code = made.invite.code;
      for (let i = 0; i < 3; i++) expect((await join('dev:cyn:Cy', '00000')).status).toBe(404);
      const refused = await join('dev:cyn:Cy', code, undefined, made.invite.secret);
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe('rate-limited');
      expect(refused.body.retryAt).toBeGreaterThan(w.clock.t);
      expect((await join('dev:bob:Bob', code, '198.51.100.9', made.invite.secret)).status).toBe(200);        // someone else, elsewhere, is not
      w.clock.t = refused.body.retryAt;
      expect((await join('dev:cyn:Cy', code, undefined, made.invite.secret)).status).toBe(200);
    });

    it('turns an address away when its players between them have tried too often', async () => {
      const { join, w } = setup();
      const made = await open(w);
      for (let i = 0; i < 5; i++) expect((await join(`dev:pl${i}:P`, '00000')).status).toBe(404);        // each player once: the address five times
      expect((await join('dev:late:Late', made.invite.code, undefined, made.invite.secret)).status).toBe(429);
      expect((await join('dev:late:Late', made.invite.code, '198.51.100.9', made.invite.secret)).status).toBe(200);
    });

    it('counts a wrong secret, and a join that cannot be understood, as tries that found nothing', async () => {
      const { join, call, w } = setup();
      const made = await open(w);
      expect((await join('dev:cyn:Cy', made.invite.code, undefined, 'wrong')).status).toBe(404);
      expect((await call('POST', '/join', { token: 'dev:cyn:Cy', body: { protocol: PROTOCOL_VERSION } })).status).toBe(400);
      expect((await join('dev:cyn:Cy', '00000')).status).toBe(404);
      expect((await join('dev:cyn:Cy', '00000')).status).toBe(429);
    });

    it('does not count joining, being in the room already, or waiting for a member to say yes', async () => {
      const { join, w } = setup();
      const made = await open(w);
      for (let i = 0; i < 10; i++) expect((await join('dev:bob:Bob', made.invite.code, undefined, made.invite.secret)).status).toBe(200);
      for (let i = 0; i < 10; i++) {
        const waiting = await join('dev:cyn:Cy', made.invite.code);                            // the code alone only knocks
        expect(waiting.status).toBe(202);
        expect(waiting.body.error).toBe('knock-pending');
      }
      expect((await join('dev:cyn:Cy', '00000')).status).toBe(404);                            // still has its tries
    });
  });

  describe('making puzzles', () => {
    it('lets an address make only so many in a window', async () => {
      const { call, w } = setup();
      const make = (token: string, ip?: string) => call('POST', '/rooms', { token, ip, body: request() });
      expect((await make(ann)).status).toBe(200);
      expect((await make('dev:bob:Bob')).status).toBe(200);                                   // another player, the same address
      const refused = await make('dev:cyn:Cy');
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe('rate-limited');
      expect((await make('dev:cyn:Cy', '198.51.100.9')).status).toBe(200);
      w.clock.t = refused.body.retryAt;
      expect((await make('dev:dee:Dee')).status).toBe(200);
    });

    it('does not count a request that cannot be understood', async () => {
      const { call } = setup();
      for (let i = 0; i < 5; i++) expect((await call('POST', '/rooms', { token: ann, body: undefined })).status).toBe(400);
      expect((await call('POST', '/rooms', { token: ann, body: request() })).status).toBe(200);
    });
  });

  describe('reports and bans', () => {
    it('lets a player report a few puzzles an hour and then asks them to wait', async () => {
      const { call, w } = setup();
      const made = await open(w, { id: 'ann1', name: 'Ann' });
      const body = { reason: 'other', note: 'look' };
      expect((await call('POST', `/rooms/${made.roomId}/report`, { token: ann, body })).status).toBe(200);
      expect((await call('POST', `/rooms/${made.roomId}/report`, { token: ann, body })).status).toBe(200);
      const refused = await call('POST', `/rooms/${made.roomId}/report`, { token: ann, body });
      expect(refused).toMatchObject({ status: 429, body: { ok: false, error: 'rate-limited' } });
      expect(await w.service.adminReports()).toHaveLength(2);                                  // the one that was refused was not kept
      expect((await call('POST', `/rooms/${made.roomId}/report`, { token: ann, body: { reason: 'nonsense' } })).status).toBe(429);
    });

    it('turns a banned player away from everything but their own account, and lets them in again when it is lifted', async () => {
      const { call, w } = setup();
      const made = await open(w, { id: 'bob1', name: 'Bob' });
      await w.service.adminBan('ann1', 'no');
      expect(await call('GET', '/me', { token: ann })).toMatchObject({ status: 200, body: { ok: true } });
      for (const [method, path] of [['GET', '/rooms'], ['GET', `/rooms/${made.roomId}`], ['POST', '/join'], ['POST', `/rooms/${made.roomId}/report`]] as const) {
        expect(await call(method, path, { token: ann, body: { protocol: PROTOCOL_VERSION, code: made.invite.code, reason: 'other' } }), `${method} ${path}`).toMatchObject({ status: 403, body: { ok: false, error: 'banned' } });
      }
      expect((await call('POST', '/me/delete', { token: ann })).status).toBe(200);
      await w.service.adminUnban('ann1');
      expect((await call('GET', '/rooms', { token: ann })).status).toBe(200);
    });
  });

  describe('the counter on DynamoDB', () => {
    it('limits the same way', async () => {
      const { call } = setup((clock) => new DynamoRates(new FakeDynamo(), 'table', clock));
      for (let i = 0; i < 3; i++) expect((await call('POST', '/guest')).status).toBe(200);
      expect((await call('POST', '/guest')).status).toBe(429);
    });
  });

  describe('a counter that does not work', () => {
    it('does not stop anyone, and says so in the log', async () => {
      const broken: RateCounter = { add: () => Promise.reject(new Error('throttled')), count: () => Promise.reject(new Error('throttled')) };
      const { call, join, w, logged } = setup(() => broken);
      const made = await open(w);
      for (let i = 0; i < 5; i++) expect((await call('POST', '/guest')).status).toBe(200);
      for (let i = 0; i < 5; i++) expect((await join('dev:cyn:Cy', '00000')).status).toBe(404);
      expect((await join('dev:cyn:Cy', made.invite.code, undefined, made.invite.secret)).status).toBe(200);
      expect(logged.length).toBeGreaterThan(0);
    });
  });

  it('has defaults that leave a household alone and stop a script', () => {
    expect(DEFAULT_RATES.failedJoins.perPlayer).toBeLessThan(DEFAULT_RATES.failedJoins.perIp);
    expect(DEFAULT_RATES.failedJoins.perIp * (HOUR / DEFAULT_RATES.failedJoins.windowMs)).toBeLessThan(1000);        // far fewer than the 100,000 five-digit codes an hour
  });
});
