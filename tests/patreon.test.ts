import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryMedia, MemoryPubSub, MemoryStore } from '../server/src/memory';
import { HttpPatreon, parsePatreonSettings, type PatreonSettings } from '../server/src/patreon';
import { createRouter, DevAuth } from '../server/src/router';
import { RoomService } from '../server/src/service';
import type { Clock, Patreon, PatreonMember, Presence, Random, Store } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, limits, type MakeStore } from './helpers/world';

// Patreon makes an account paid while a pledge is paid up: the same on both stores, with Patreon itself stood in for.

/** Patreon, as the service sees it: what each code, member and webhook says is set by the test. */
class FakePatreon implements Patreon {
  codes = new Map<string, PatreonMember>();
  members = new Map<string, PatreonMember | null>();
  down = false;
  authorizeUrl(state: string): string {
    return `https://patreon.test/authorize?state=${state}`;
  }
  async identify(code: string): Promise<PatreonMember> {
    const m = this.codes.get(code);
    if (!m) throw new Error('refused');
    return m;
  }
  async member(id: string): Promise<PatreonMember | null> {
    if (this.down) throw new Error('down');
    return this.members.get(id) ?? null;
  }
  webhook(body: string, signature: string | undefined): PatreonMember | null {
    return signature === 'signed' ? (JSON.parse(body) as PatreonMember) : null;
  }
}

const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

function build(makeStore: MakeStore, patreon: Patreon | undefined) {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const random: Random = { bytes: (len) => new Uint8Array(len).map((_, i) => (++n * 7 + i) % 256), below: () => 0 };
  const store: Store = makeStore(clock as Clock);
  const presence: Presence = { online: () => [] };
  const service = new RoomService({ store, media: new MemoryMedia('http://media.test', new Uint8Array(32).fill(7), clock as Clock), pubsub: new MemoryPubSub(), presence, clock: clock as Clock, random, limits, webBase: 'https://play.test', patreon });
  return { clock, store, service };
}

const pledge = (userId: string, extra: Partial<PatreonMember> = {}): PatreonMember => ({ userId, memberId: `m-${userId}`, active: true, lastCharge: '2026-11-01T00:00:00Z', ...extra });
const stateOf = (url: string): string => new URL(url).searchParams.get('state')!;

describe.each(stores)('Patreon on %s', (_name, store) => {
  async function joinedAs(w: ReturnType<typeof build>, p: FakePatreon, who = ann, member = pledge('u1'), code = 'c1') {
    p.codes.set(code, member);
    const started = await w.service.patreonStart(who);
    if (!started.ok) throw new Error('could not start');
    return w.service.patreonCallback(code, stateOf(started.url));
  }

  it('is not offered when the server has no Patreon, and not to a guest', async () => {
    const off = build(store, undefined);
    expect(await off.service.patreonStart(ann)).toMatchObject({ ok: false, error: 'patreon-off' });
    expect((await off.service.summary(ann)).patreon).toBeUndefined();
    const on = build(store, new FakePatreon());
    expect(await on.service.patreonStart({ id: 'gAAAAAAAAAAAAAAAAAAAAAA', name: 'G', guest: true })).toMatchObject({ ok: false, error: 'account-required' });
    expect(await on.service.summary(ann)).toMatchObject({ type: 'free', patreon: { on: true, linked: false, active: false } });
  });

  it('makes the account paid, with a period of video credits, when a pledge that is paid up is joined', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    expect(await joinedAs(w, p)).toBe('https://play.test/?patreon=linked');
    expect(await w.service.summary(ann)).toMatchObject({ type: 'paid', video: limits.paidVideoCredits, patreon: { on: true, linked: true, active: true } });
  });

  it('joins a Patreon user with no pledge, and makes the account paid when the pledge comes', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p, ann, { userId: 'u1', active: false });
    expect(await w.service.summary(ann)).toMatchObject({ type: 'free', video: 0, patreon: { linked: true, active: false } });
    expect(await w.service.patreonWebhook(JSON.stringify(pledge('u1')), 'signed')).toBe(true);
    expect(await w.service.summary(ann)).toMatchObject({ type: 'paid', video: limits.paidVideoCredits });
  });

  it('takes the paid type back when the pledge ends, and keeps the credits', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    await w.service.patreonWebhook(JSON.stringify(pledge('u1', { active: false })), 'signed');
    expect(await w.service.summary(ann)).toMatchObject({ type: 'free', video: limits.paidVideoCredits, patreon: { linked: true, active: false } });
  });

  it('gives a period of video credits for each new payment, and once for each', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    await w.service.patreonWebhook(JSON.stringify(pledge('u1')), 'signed');                            // (the same payment said again)
    expect((await w.service.summary(ann)).video).toBe(limits.paidVideoCredits);
    await w.service.patreonWebhook(JSON.stringify(pledge('u1', { lastCharge: '2026-12-01T00:00:00Z' })), 'signed');
    expect((await w.service.summary(ann)).video).toBe(2 * limits.paidVideoCredits);
  });

  it('believes only a webhook that is signed, and answers one that is about nobody', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    expect(await w.service.patreonWebhook(JSON.stringify(pledge('u1', { active: false })), 'forged')).toBe(false);
    expect((await w.service.summary(ann)).type).toBe('paid');
    expect(await w.service.patreonWebhook(JSON.stringify(pledge('nobody')), 'signed')).toBe(true);
  });

  it('lets one Patreon user join one account only, and the state only once', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    expect(await joinedAs(w, p, bob, pledge('u1'), 'c2')).toBe('https://play.test/?patreon=taken');
    expect(await w.service.summary(bob)).toMatchObject({ type: 'free', video: 0, patreon: { linked: false } });
    const started = await w.service.patreonStart(bob);
    if (!started.ok) throw new Error('could not start');
    p.codes.set('c3', pledge('u2'));
    expect(await w.service.patreonCallback('c3', stateOf(started.url))).toBe('https://play.test/?patreon=linked');
    expect(await w.service.patreonCallback('c3', stateOf(started.url))).toBe('https://play.test/?patreon=error');
  });

  it('turns away a state that is unknown, has run out, or comes with a code Patreon refuses', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    expect(await w.service.patreonCallback('c1', 'nonsense')).toBe('https://play.test/?patreon=error');
    expect(await w.service.patreonCallback(null, null)).toBe('https://play.test/?patreon=error');
    const late = await w.service.patreonStart(ann);
    if (!late.ok) throw new Error('could not start');
    p.codes.set('c1', pledge('u1'));
    w.clock.t += 11 * 60 * 1000;
    expect(await w.service.patreonCallback('c1', stateOf(late.url))).toBe('https://play.test/?patreon=error');
    const fresh = await w.service.patreonStart(ann);
    if (!fresh.ok) throw new Error('could not start');
    expect(await w.service.patreonCallback('refused', stateOf(fresh.url))).toBe('https://play.test/?patreon=error');
    expect((await w.service.summary(ann)).type).toBe('free');
  });

  it('lets go of the Patreon user on request: the paid type goes, the credits stay, and joining again gives none twice', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    expect(await w.service.patreonUnlink(ann)).toMatchObject({ ok: true, account: { type: 'free', video: limits.paidVideoCredits, patreon: { linked: false } } });
    expect(await joinedAs(w, p, ann, pledge('u1'), 'c2')).toBe('https://play.test/?patreon=linked');
    expect(await w.service.summary(ann)).toMatchObject({ type: 'paid', video: limits.paidVideoCredits });
    expect(await w.service.patreonWebhook(JSON.stringify(pledge('u1')), 'signed')).toBe(true);        // (the user is the account's again)
  });

  it('leaves a paid, family or admin type that the operator gave alone', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await w.service.adminSetAccount('ann', { type: 'family' });
    await joinedAs(w, p, ann, pledge('u1', { active: false }));
    expect((await w.service.summary(ann)).type).toBe('family');
    await w.service.adminSetAccount('bob', { type: 'paid' });
    await joinedAs(w, p, bob, pledge('u2', { active: false }), 'c2');
    expect((await w.service.summary(bob)).type).toBe('paid');
    await w.service.patreonUnlink(bob);
    expect((await w.service.summary(bob)).type).toBe('paid');
  });

  it('asks Patreon again about a pledge that is a day old, and leaves it as it was when Patreon cannot be asked', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    p.members.set('m-u1', pledge('u1', { active: false }));
    await w.service.profile(ann);
    expect((await w.service.summary(ann)).type).toBe('paid');                                           // (not a day yet)
    w.clock.t += DAY + 1;
    p.down = true;
    await w.service.profile(ann);
    expect((await w.service.summary(ann)).type).toBe('paid');
    p.down = false;
    await w.service.profile(ann);
    expect(await w.service.summary(ann)).toMatchObject({ type: 'free', patreon: { linked: true, active: false } });
  });

  it('forgets the join when the account is deleted, so that the Patreon user can join another', async () => {
    const p = new FakePatreon();
    const w = build(store, p);
    await joinedAs(w, p);
    await w.service.deleteAccount(ann);
    expect(await joinedAs(w, p, bob, pledge('u1'), 'c2')).toBe('https://play.test/?patreon=linked');
  });
});

describe('the router', () => {
  it('answers the callback with a redirect, and the webhook only when it is signed', async () => {
    const p = new FakePatreon();
    const w = build(() => new MemoryStore(), p);
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: { allows: async () => false } });
    const asAnn = { authorization: 'Bearer dev:ann:Ann' };
    const empty = new Uint8Array();
    const start = await route({ method: 'POST', path: '/me/patreon', query: new URLSearchParams(), body: empty, ...asAnn });
    expect(start.status).toBe(200);
    const state = stateOf((start.body as { url: string }).url);
    p.codes.set('code', pledge('u1'));
    const back = await route({ method: 'GET', path: '/patreon/callback', query: new URLSearchParams({ code: 'code', state }), body: empty });
    expect(back).toMatchObject({ status: 302, location: 'https://play.test/?patreon=linked' });
    const hook = (signature?: string) => route({ method: 'POST', path: '/patreon/webhook', query: new URLSearchParams(), headers: { 'x-patreon-signature': signature }, body: new TextEncoder().encode(JSON.stringify(pledge('u1', { active: false }))) });
    expect((await hook('forged')).status).toBe(403);
    expect((await hook()).status).toBe(403);
    expect((await hook('signed')).status).toBe(200);
    const me = await route({ method: 'GET', path: '/me', query: new URLSearchParams(), body: empty, ...asAnn });
    expect(me.body).toMatchObject({ account: { type: 'free', patreon: { linked: true, active: false } } });
    const gone = await route({ method: 'POST', path: '/me/patreon/unlink', query: new URLSearchParams(), body: empty, ...asAnn });
    expect(gone.body).toMatchObject({ account: { patreon: { linked: false } } });
  });
});

describe('HttpPatreon', () => {
  const settings: PatreonSettings = { clientId: 'cid', clientSecret: 'secret', webhookSecret: 'hook', creatorToken: 'creator', campaignId: 'camp' };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  const member = (id: string, campaign: string, attributes: Record<string, unknown>) => ({ id, type: 'member', attributes, relationships: { campaign: { data: { id: campaign, type: 'campaign' } }, user: { data: { id: 'u1', type: 'user' } } } });

  it('sends the player to Patreon with the client, the way back, the scope and the state', () => {
    const url = new URL(new HttpPatreon(settings, 'https://api.test/patreon/callback').authorizeUrl('S1'));
    expect(url.origin + url.pathname).toBe('https://www.patreon.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ response_type: 'code', client_id: 'cid', redirect_uri: 'https://api.test/patreon/callback', scope: 'identity identity.memberships', state: 'S1' });
  });

  it('says who the player is and whether they pledge to our campaign (and not to another)', async () => {
    const seen: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${String(url).split('?')[0]}`);
      if (String(url).includes('/token')) return json({ access_token: 'tok' });
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
      return json({
        data: { id: 'u1', type: 'user' },
        included: [member('other', 'elsewhere', { patron_status: 'active_patron', currently_entitled_amount_cents: 5000 }), member('m1', 'camp', { patron_status: 'active_patron', currently_entitled_amount_cents: 500, last_charge_status: 'Paid', last_charge_date: '2026-11-01T00:00:00Z' })],
      });
    }) as unknown as typeof fetch;
    const got = await new HttpPatreon(settings, 'https://api.test/patreon/callback', fetcher).identify('code');
    expect(got).toEqual({ userId: 'u1', memberId: 'm1', active: true, lastCharge: '2026-11-01T00:00:00Z' });
    expect(seen).toEqual(['POST https://www.patreon.com/api/oauth2/token', 'GET https://www.patreon.com/api/oauth2/v2/identity']);
  });

  it('counts a pledge as active only when it is paid up and at least the tier', async () => {
    const ask = async (attributes: Record<string, unknown>, minCents?: number) => {
      const fetcher = (async () => json({ data: member('m1', 'camp', attributes) })) as unknown as typeof fetch;
      return new HttpPatreon({ ...settings, minCents }, 'x', fetcher).member('m1');
    };
    expect((await ask({ patron_status: 'active_patron', currently_entitled_amount_cents: 500, last_charge_status: 'Paid' }))?.active).toBe(true);
    expect((await ask({ patron_status: 'active_patron', currently_entitled_amount_cents: 300, last_charge_status: 'Paid' }))?.active).toBe(false);
    expect((await ask({ patron_status: 'active_patron', currently_entitled_amount_cents: 300, last_charge_status: 'Paid' }, 300))?.active).toBe(true);
    expect((await ask({ patron_status: 'declined_patron', currently_entitled_amount_cents: 500, last_charge_status: 'Declined' }))?.active).toBe(false);
    expect((await ask({ patron_status: 'former_patron', currently_entitled_amount_cents: 0 }))?.active).toBe(false);
    expect((await ask({ patron_status: 'active_patron', currently_entitled_amount_cents: 500, last_charge_status: 'Declined' }))?.active).toBe(false);
  });

  it('says nothing of a member that is gone, and fails when Patreon does', async () => {
    const gone = new HttpPatreon(settings, 'x', (async () => json({}, 404)) as unknown as typeof fetch);
    expect(await gone.member('m1')).toBeNull();
    const broken = new HttpPatreon(settings, 'x', (async () => json({}, 500)) as unknown as typeof fetch);
    await expect(broken.member('m1')).rejects.toThrow();
    await expect(broken.identify('code')).rejects.toThrow();
  });

  it('checks the webhook signature (MD5 HMAC of the body under the webhook secret) and reads the member', () => {
    const patreon = new HttpPatreon(settings, 'x');
    const body = JSON.stringify({ data: member('m1', 'camp', { patron_status: 'active_patron', currently_entitled_amount_cents: 500 }) });
    const sign = (text: string, secret = 'hook') => createHmac('md5', secret).update(text).digest('hex');
    expect(patreon.webhook(body, sign(body))).toEqual({ userId: 'u1', memberId: 'm1', active: true });
    expect(patreon.webhook(body, sign(body, 'other'))).toBeNull();
    expect(patreon.webhook(body + ' ', sign(body))).toBeNull();
    expect(patreon.webhook(body, undefined)).toBeNull();
    expect(patreon.webhook('not json', sign('not json'))).toBeNull();
  });

  it('reads the secret only when it is complete', () => {
    expect(parsePatreonSettings(JSON.stringify(settings))).toEqual(settings);
    expect(parsePatreonSettings(JSON.stringify({ ...settings, creatorToken: '' }))).toBeUndefined();
    expect(parsePatreonSettings('nonsense')).toBeUndefined();
    expect(parsePatreonSettings(undefined)).toBeUndefined();
  });
});
