import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryMedia, MemoryPubSub, MemoryStore } from '../server/src/memory';
import { HttpPlay, parsePlaySettings, type PlaySettings } from '../server/src/play';
import { createRouter, DevAuth } from '../server/src/router';
import { RoomService } from '../server/src/service';
import type { Clock, Patreon, PatreonMember, Play, PlayPurchase, Presence, Random, Store } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, limits, type MakeStore } from './helpers/world';

// A subscription bought in the Android app makes an account paid while it is paid up: the same on both stores, with Google Play itself stood in for.

/** Google Play, as the service sees it: what each purchase token says is set by the test. */
class FakePlay implements Play {
  readonly productId = 'plus';
  purchases = new Map<string, PlayPurchase>();
  acknowledged: string[] = [];
  down = false;
  async purchase(token: string): Promise<PlayPurchase | null> {
    if (this.down) throw new Error('down');
    return this.purchases.get(token) ?? null;
  }
  async acknowledge(token: string): Promise<void> {
    this.acknowledged.push(token);
  }
  notification(body: string, key: string | null): { token?: string } | null {
    return key === 'k' ? (JSON.parse(body) as { token?: string }) : null;
  }
}

const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

function build(makeStore: MakeStore, play: Play | undefined, patreon?: Patreon) {
  const clock = { t: 1_000_000, now() { return this.t; } };
  let n = 0;
  const random: Random = { bytes: (len) => new Uint8Array(len).map((_, i) => (++n * 7 + i) % 256), below: () => 0 };
  const store: Store = makeStore(clock as Clock);
  const presence: Presence = { online: () => [] };
  const service = new RoomService({ store, media: new MemoryMedia('http://media.test', new Uint8Array(32).fill(7), clock as Clock), pubsub: new MemoryPubSub(), presence, clock: clock as Clock, random, limits, webBase: 'https://play.test', play, patreon });
  return { clock, store, service };
}

const sub = (token: string, extra: Partial<PlayPurchase> = {}): PlayPurchase => ({ token, productId: 'plus', active: true, orderId: 'GPA.1', acknowledged: false, expiresAt: 5_000_000, ...extra });

describe.each(stores)('Google Play on %s', (_name, store) => {
  it('is not offered when the server has none, and not to a guest', async () => {
    const off = build(store, undefined);
    expect(await off.service.playVerify(ann, 't1')).toMatchObject({ ok: false, error: 'play-off' });
    expect((await off.service.summary(ann)).play).toBeUndefined();
    const play = new FakePlay();
    const on = build(store, play);
    expect(await on.service.playVerify({ id: 'gAAAAAAAAAAAAAAAAAAAAAA', name: 'G', guest: true }, 't1')).toMatchObject({ ok: false, error: 'account-required' });
    expect(await on.service.summary(ann)).toMatchObject({ type: 'free', play: { on: true, productId: 'plus', active: false } });
  });

  it('makes the account paid, with a period of video credits, and acknowledges the purchase', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    expect(await w.service.playVerify(ann, 't1')).toMatchObject({ ok: true, account: { type: 'paid', video: limits.playVideoCredits, play: { on: true, active: true, expiresAt: 5_000_000 } } });
    expect(play.acknowledged).toEqual(['t1']);
  });

  it('does not acknowledge a purchase that was acknowledged, or one that is not paid for yet, and joins the latter all the same', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1', { acknowledged: true }));
    play.purchases.set('t2', sub('t2', { active: false, orderId: undefined }));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    await w.service.playVerify(bob, 't2');
    expect(play.acknowledged).toEqual([]);
    expect(await w.service.summary(bob)).toMatchObject({ type: 'free', video: 0, play: { active: false } });
    play.purchases.set('t2', sub('t2', { orderId: 'GPA.9' }));                                        // (the payment goes through: Google says so)
    expect(await w.service.playNotify(JSON.stringify({ token: 't2' }), 'k')).toBe(true);
    expect(await w.service.summary(bob)).toMatchObject({ type: 'paid', video: limits.playVideoCredits });
  });

  it('turns away a token that Google does not know, one that is not a string, and one that is another account\'s', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    expect(await w.service.playVerify(ann, 'nonsense')).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await w.service.playVerify(ann, 42)).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await w.service.playVerify(ann, 't1')).toMatchObject({ ok: true });
    expect(await w.service.playVerify(bob, 't1')).toMatchObject({ ok: false, error: 'purchase-taken' });
    expect(await w.service.summary(bob)).toMatchObject({ type: 'free', video: 0, play: { active: false } });
    expect(play.acknowledged).toEqual(['t1']);                                                         // (once: bob's attempt was not acknowledged)
    expect(await w.service.playVerify(ann, 't1')).toMatchObject({ ok: true });                         // (the same account may say it again: restoring)
    expect((await w.service.summary(ann)).video).toBe(limits.playVideoCredits);
  });

  it('says busy when Google cannot be asked, and changes nothing', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    play.down = true;
    const w = build(store, play);
    expect(await w.service.playVerify(ann, 't1')).toMatchObject({ ok: false, error: 'busy' });
    expect((await w.service.summary(ann)).type).toBe('free');
  });

  it('takes the paid type back when the subscription ends, and keeps the credits', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    play.purchases.set('t1', sub('t1', { active: false }));
    await w.service.playNotify(JSON.stringify({ token: 't1' }), 'k');
    expect(await w.service.summary(ann)).toMatchObject({ type: 'free', video: limits.playVideoCredits, play: { on: true, active: false } });
  });

  it('gives a period of video credits for each new order, and once for each', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    await w.service.playNotify(JSON.stringify({ token: 't1' }), 'k');                                  // (the same order said again)
    expect((await w.service.summary(ann)).video).toBe(limits.playVideoCredits);
    play.purchases.set('t1', sub('t1', { orderId: 'GPA.1..0', expiresAt: 9_000_000 }));
    await w.service.playNotify(JSON.stringify({ token: 't1' }), 'k');
    expect((await w.service.summary(ann)).video).toBe(2 * limits.playVideoCredits);
    expect((await w.service.summary(ann)).play?.expiresAt).toBe(9_000_000);
  });

  it('believes only a push that carries the key, and answers one that is about nobody or is a test', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    play.purchases.set('t1', sub('t1', { active: false }));
    expect(await w.service.playNotify(JSON.stringify({ token: 't1' }), 'wrong')).toBe(false);
    expect(await w.service.playNotify(JSON.stringify({ token: 't1' }), null)).toBe(false);
    expect((await w.service.summary(ann)).type).toBe('paid');
    expect(await w.service.playNotify(JSON.stringify({ token: 'nobody' }), 'k')).toBe(true);
    expect(await w.service.playNotify(JSON.stringify({}), 'k')).toBe(true);
    expect(await build(store, undefined).service.playNotify('{}', 'k')).toBe(false);
  });

  it('lets Google try again when it cannot be asked about a push', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    play.down = true;
    await expect(w.service.playNotify(JSON.stringify({ token: 't1' }), 'k')).rejects.toThrow();
  });

  it('asks Google again about a subscription that is a day old, and leaves it as it was when Google cannot be asked', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    play.purchases.set('t1', sub('t1', { active: false }));
    await w.service.profile(ann);
    expect((await w.service.summary(ann)).type).toBe('paid');                                          // (not a day yet)
    w.clock.t += DAY + 1;
    play.down = true;
    await w.service.profile(ann);
    expect((await w.service.summary(ann)).type).toBe('paid');
    play.down = false;
    await w.service.profile(ann);
    expect(await w.service.summary(ann)).toMatchObject({ type: 'free', play: { active: false } });
  });

  it('leaves a paid, family or admin type that the operator gave alone', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1', { active: false }));
    play.purchases.set('t2', sub('t2', { active: false }));
    const w = build(store, play);
    await w.service.adminSetAccount('ann', { type: 'family' });
    await w.service.playVerify(ann, 't1');
    expect((await w.service.summary(ann)).type).toBe('family');
    await w.service.adminSetAccount('bob', { type: 'paid' });
    await w.service.playVerify(bob, 't2');
    expect((await w.service.summary(bob)).type).toBe('paid');
  });

  it('forgets the join when the account is deleted, so that the purchase can join another account', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(store, play);
    await w.service.playVerify(ann, 't1');
    await w.service.deleteAccount(ann);
    expect(await w.service.playVerify(bob, 't1')).toMatchObject({ ok: true, account: { type: 'paid', video: 0 } });      // (paid, but the order had given its credits to the first account)
  });

  it('is paid while either Patreon or Google Play is paid up', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const pledge: PatreonMember = { userId: 'u1', memberId: 'm1', active: true, lastCharge: '2026-11-01T00:00:00Z' };
    const patreon: Patreon = { authorizeUrl: (s) => `https://patreon.test/?state=${s}`, identify: async () => pledge, member: async () => pledge, webhook: (b, sig) => (sig === 'signed' ? (JSON.parse(b) as PatreonMember) : null) };
    const w = build(store, play, patreon);
    const started = await w.service.patreonStart(ann);
    if (!started.ok) throw new Error('could not start');
    await w.service.patreonCallback('c', new URL(started.url).searchParams.get('state'));
    await w.service.playVerify(ann, 't1');
    expect((await w.service.summary(ann)).type).toBe('paid');
    await w.service.patreonWebhook(JSON.stringify({ ...pledge, active: false }), 'signed');            // (the pledge ends: the subscription keeps the account paid)
    expect(await w.service.summary(ann)).toMatchObject({ type: 'paid', patreon: { active: false }, play: { active: true } });
    play.purchases.set('t1', sub('t1', { active: false }));
    await w.service.playNotify(JSON.stringify({ token: 't1' }), 'k');                                  // (and when that ends too, the account is free)
    expect((await w.service.summary(ann)).type).toBe('free');
  });

  it('keeps the paid type with Google Play when the account lets Patreon go', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const pledge: PatreonMember = { userId: 'u1', memberId: 'm1', active: true, lastCharge: '2026-11-01T00:00:00Z' };
    const patreon: Patreon = { authorizeUrl: (s) => `https://patreon.test/?state=${s}`, identify: async () => pledge, member: async () => pledge, webhook: () => null };
    const w = build(store, play, patreon);
    const started = await w.service.patreonStart(ann);
    if (!started.ok) throw new Error('could not start');
    await w.service.patreonCallback('c', new URL(started.url).searchParams.get('state'));            // (Patreon made it paid)
    await w.service.playVerify(ann, 't1');
    await w.service.patreonUnlink(ann);
    expect((await w.service.summary(ann)).type).toBe('paid');
    play.purchases.set('t1', sub('t1', { active: false }));
    await w.service.playNotify(JSON.stringify({ token: 't1' }), 'k');
    expect((await w.service.summary(ann)).type).toBe('free');
  });
});

describe('the router', () => {
  it('takes a purchase token from an account, and Google\'s push only with the key', async () => {
    const play = new FakePlay();
    play.purchases.set('t1', sub('t1'));
    const w = build(() => new MemoryStore(), play);
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: { allows: async () => false } });
    const asAnn = { authorization: 'Bearer dev:ann:Ann' };
    const verify = (body: unknown, auth: object = asAnn) => route({ method: 'POST', path: '/me/play/verify', query: new URLSearchParams(), body: new TextEncoder().encode(JSON.stringify(body)), ...auth });
    expect((await verify({ token: 't1' }, {})).status).toBe(401);
    expect((await verify({ token: 'nonsense' })).status).toBe(400);
    expect(await verify({ token: 't1' })).toMatchObject({ status: 200, body: { account: { type: 'paid', play: { active: true } } } });
    expect((await verify({ token: 't1' }, { authorization: 'Bearer dev:bob:Bob' })).status).toBe(409);
    play.purchases.set('t1', sub('t1', { active: false }));
    const push = (key?: string) => route({ method: 'POST', path: '/play/notify', query: new URLSearchParams(key ? { key } : {}), body: new TextEncoder().encode(JSON.stringify({ token: 't1' })) });
    expect((await push('wrong')).status).toBe(403);
    expect((await push()).status).toBe(403);
    expect((await push('k')).status).toBe(200);
    const me = await route({ method: 'GET', path: '/me', query: new URLSearchParams(), body: new Uint8Array(), ...asAnn });
    expect(me.body).toMatchObject({ account: { type: 'free', play: { active: false } } });
    const off = createRouter({ service: build(() => new MemoryStore(), undefined).service, auth: new DevAuth(), media: { allows: async () => false } });
    expect((await off({ method: 'POST', path: '/me/play/verify', query: new URLSearchParams(), body: new TextEncoder().encode('{"token":"t1"}'), ...asAnn })).status).toBe(503);
    expect((await off({ method: 'POST', path: '/play/notify', query: new URLSearchParams({ key: 'k' }), body: new Uint8Array() })).status).toBe(403);
  });
});

describe('HttpPlay', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const settings: PlaySettings = {
    serviceAccount: { client_email: 'svc@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    packageName: 'com.example.app',
    productId: 'plus',
    notifyKey: 'secret-key',
  };
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
  const NOW = Date.parse('2026-11-10T00:00:00Z');
  const later = '2026-12-10T00:00:00Z';
  const earlier = '2026-11-01T00:00:00Z';

  /** Google as a fake: the token call checks the signature of the request that asks for it, and the purchase call answers what the test set. */
  function google(answer: () => Response) {
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        const assertion = new URLSearchParams(String(init?.body)).get('assertion')!;
        const [h, c, sig] = assertion.split('.');
        expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({ iss: settings.serviceAccount.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token' });
        expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
        return json({ access_token: 'access1', expires_in: 3600 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer access1');
      return answer();
    }) as unknown as typeof fetch;
    return { calls, play: new HttpPlay(settings, fetcher, () => NOW) };
  }
  const subscription = (state: string, expiry = later, extra: object = {}) => ({ subscriptionState: state, latestOrderId: 'GPA.7', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', lineItems: [{ productId: 'plus', expiryTime: expiry }], ...extra });

  it('reads the settings only when they are all there', () => {
    expect(parsePlaySettings(JSON.stringify(settings))).toEqual(settings);
    expect(parsePlaySettings(JSON.stringify({ ...settings, notifyKey: '' }))).toBeUndefined();
    expect(parsePlaySettings(JSON.stringify({ ...settings, serviceAccount: { client_email: 'x' } }))).toBeUndefined();
    expect(parsePlaySettings('not json')).toBeUndefined();
    expect(parsePlaySettings(undefined)).toBeUndefined();
  });

  it('asks Google about the token with a signed request, and keeps the access token it gets', async () => {
    const g = google(() => json(subscription('SUBSCRIPTION_STATE_ACTIVE')));
    const first = await g.play.purchase('tok/1');
    expect(first).toEqual({ token: 'tok/1', productId: 'plus', active: true, expiresAt: Date.parse(later), orderId: 'GPA.7', acknowledged: false });
    await g.play.purchase('tok2');
    expect(g.calls.filter((c) => c.includes('oauth2')).length).toBe(1);
    expect(g.calls[1]).toBe('GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/purchases/subscriptionsv2/tokens/tok%2F1');
  });

  it('counts a subscription that is on, late with a payment, or cancelled but not run out as paid, and any other as not', async () => {
    const active = async (state: string, expiry?: string) => (await google(() => json(subscription(state, expiry))).play.purchase('t'))?.active;
    expect(await active('SUBSCRIPTION_STATE_ACTIVE')).toBe(true);
    expect(await active('SUBSCRIPTION_STATE_IN_GRACE_PERIOD')).toBe(true);
    expect(await active('SUBSCRIPTION_STATE_CANCELED', later)).toBe(true);
    expect(await active('SUBSCRIPTION_STATE_CANCELED', earlier)).toBe(false);
    expect(await active('SUBSCRIPTION_STATE_ON_HOLD')).toBe(false);
    expect(await active('SUBSCRIPTION_STATE_PAUSED')).toBe(false);
    expect(await active('SUBSCRIPTION_STATE_EXPIRED', earlier)).toBe(false);
    expect(await active('SUBSCRIPTION_STATE_PENDING')).toBe(false);
  });

  it('says an acknowledged purchase is, and knows nothing of a token Google does not know or of another product', async () => {
    expect((await google(() => json(subscription('SUBSCRIPTION_STATE_ACTIVE', later, { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }))).play.purchase('t'))?.acknowledged).toBe(true);
    expect(await google(() => json({}, 404)).play.purchase('t')).toBeNull();
    expect(await google(() => json({}, 400)).play.purchase('t')).toBeNull();
    expect(await google(() => json({ ...subscription('SUBSCRIPTION_STATE_ACTIVE'), lineItems: [{ productId: 'other', expiryTime: later }] }, 200)).play.purchase('t')).toBeNull();
    await expect(google(() => json({}, 500)).play.purchase('t')).rejects.toThrow(/500/);
  });

  it('acknowledges a purchase', async () => {
    const g = google(() => json({}));
    await g.play.acknowledge('t/1', 'plus');
    expect(g.calls[1]).toBe('POST https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/purchases/subscriptions/plus/tokens/t%2F1:acknowledge');
    await expect(google(() => json({}, 400)).play.acknowledge('t', 'plus')).rejects.toThrow(/400/);
  });

  it('refuses a request for a token when Google does not like the key', async () => {
    const fetcher = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    await expect(new HttpPlay(settings, fetcher, () => NOW).purchase('t')).rejects.toThrow(/token/);
  });

  describe('a push from Google', () => {
    const push = (notice: unknown) => JSON.stringify({ message: { data: Buffer.from(JSON.stringify(notice)).toString('base64'), messageId: '1' }, subscription: 'projects/p/subscriptions/s' });
    const play = new HttpPlay(settings, fetch, () => NOW);

    it('says which purchase token it is about, when its address has the key', () => {
      const notice = { version: '1.0', packageName: 'com.example.app', subscriptionNotification: { version: '1.0', notificationType: 2, purchaseToken: 'tok1', subscriptionId: 'plus' } };
      expect(play.notification(push(notice), 'secret-key')).toEqual({ token: 'tok1' });
      expect(play.notification(push({ packageName: 'com.example.app', voidedPurchaseNotification: { purchaseToken: 'tok2', orderId: 'o', productType: 1 } }), 'secret-key')).toEqual({ token: 'tok2' });
    });

    it('is not genuine without the key, with a wrong one, or when it is not a push', () => {
      const notice = { packageName: 'com.example.app', subscriptionNotification: { purchaseToken: 'tok1' } };
      expect(play.notification(push(notice), null)).toBeNull();
      expect(play.notification(push(notice), 'secret-kex')).toBeNull();
      expect(play.notification(push(notice), 'short')).toBeNull();
      expect(play.notification('not json', 'secret-key')).toBeNull();
    });

    it('is genuine but about no purchase for a test, or for another app', () => {
      expect(play.notification(push({ packageName: 'com.example.app', testNotification: { version: '1.0' } }), 'secret-key')).toEqual({});
      expect(play.notification(push({ packageName: 'com.other', subscriptionNotification: { purchaseToken: 'tok1' } }), 'secret-key')).toEqual({});
    });
  });
});
