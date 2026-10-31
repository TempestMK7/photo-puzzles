import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AdMobCallbacks, fetchAdMobKeys } from '../server/src/admob';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { createRouter, DevAuth } from '../server/src/router';
import type { AdCallbacks } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, world as makeWorld, type MakeStore, type World } from './helpers/world';

// AdMob signs the call that says a rewarded ad was watched. Here the signing is done with a key of our own, in AdMob's format.
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NOW = 1_000_000;
const clock = { now: () => NOW };

/** A callback query as AdMob sends it: the values, then `signature` and `key_id` last, the signature over everything before it. */
function callback(values: Record<string, string | number>, key = privateKey, keyId = '1234'): string {
  const text = Object.entries({ ad_network: '5450213213286189855', ad_unit: '2747237720', reward_amount: 5, reward_item: 'credits', timestamp: NOW, transaction_id: 'AAAA1111', ...values })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const signature = sign('sha256', Buffer.from(text), { key, dsaEncoding: 'der' }).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${text}&signature=${signature}&key_id=${keyId}`;
}

const keys = async () => new Map([['1234', PEM]]);

describe('the check of what AdMob says', () => {
  const verifier = (source = keys, units = ['ca-app-pub-1111111111111111/2747237720']) => new AdMobCallbacks(units, clock, source);

  it('believes a call signed by AdMob’s key, for one of our ad units, and gives what it says', async () => {
    const out = await verifier().verify(callback({ custom_data: 'nonce one', transaction_id: 'TX-1' }));
    expect(out).toEqual({ transactionId: 'TX-1', customData: 'nonce one', at: NOW });
    expect(await verifier(keys, ['2747237720']).verify(callback({ transaction_id: 'TX-2' }))).toMatchObject({ transactionId: 'TX-2', customData: '' });     // the number alone will do
  });

  it('believes nothing that has been changed, signed by another key, or not signed', async () => {
    const good = callback({ custom_data: 'n' });
    expect(await verifier().verify(good.replace('reward_amount=5', 'reward_amount=500'))).toBeNull();
    expect(await verifier().verify(good.replace('custom_data=n', 'custom_data=other'))).toBeNull();
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect(await verifier().verify(callback({}, other))).toBeNull();
    expect(await verifier().verify(callback({}, privateKey, '999'))).toBeNull();                       // a key we do not know
    expect(await verifier().verify(good.replace(/signature=[^&]+/, 'signature=AAAA'))).toBeNull();
    expect(await verifier().verify(good.replace(/&signature=.*/, ''))).toBeNull();
    expect(await verifier().verify('')).toBeNull();
    expect(await verifier().verify('hello=world&signature=x&key_id=1234')).toBeNull();
  });

  it('believes only a call for our own ad units, that is not too old, and that has a transaction number', async () => {
    expect(await verifier().verify(callback({ ad_unit: '555' }))).toBeNull();
    expect(await verifier().verify(callback({ timestamp: NOW - DAY - 1 }))).toBeNull();
    expect(await verifier().verify(callback({ timestamp: NOW - DAY + 1000 }))).not.toBeNull();
    expect(await verifier().verify(callback({ transaction_id: '' }))).toBeNull();
    expect(await verifier().verify(callback({ transaction_id: 'a b' }))).toBeNull();
    expect(await verifier().verify(callback({ timestamp: 'soon' }))).toBeNull();
  });

  it('reads the keys again when a call names one it does not know (they rotate), but not more than once a minute, and keeps what it has when AdMob cannot be reached', async () => {
    let now = NOW;
    let calls = 0;
    let mode: 'old' | 'new' | 'down' = 'old';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const source = async () => {
      calls++;
      if (mode === 'down') throw new Error('gstatic is down');
      return new Map(mode === 'old' ? [['1234', PEM]] : [['1234', PEM], ['777', PEM]]);
    };
    const v = new AdMobCallbacks(['2747237720'], { now: () => now }, source);
    expect(await v.verify(callback({}, privateKey, '1234'))).not.toBeNull();
    expect(calls).toBe(1);
    expect(await v.verify(callback({}, privateKey, '1234'))).not.toBeNull();
    expect(calls).toBe(1);                                                                        // known, and fresh: no trip
    mode = 'new';
    expect(await v.verify(callback({}, privateKey, '777'))).toBeNull();                           // asked for it a moment ago: not again yet
    expect(calls).toBe(1);
    now += 61_000;
    expect(await v.verify(callback({ timestamp: now }, privateKey, '777'))).not.toBeNull();
    expect(calls).toBe(2);
    mode = 'down';
    now += 7 * 3600 * 1000;                                                                       // (the keys are old: they are asked for, and it fails)
    expect(await v.verify(callback({ timestamp: now }, privateKey, '1234'))).not.toBeNull();       // the keys it has are still used
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it('reads AdMob’s list of keys', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ keys: [{ keyId: 3335741209, pem: PEM, base64: 'x' }, { keyId: 5, pem: PEM }, { nope: true }] }))) as typeof fetch;
    expect([...(await fetchAdMobKeys(fetcher)).keys()]).toEqual(['3335741209', '5']);
    await expect(fetchAdMobKeys((async () => new Response('', { status: 500 })) as typeof fetch)).rejects.toThrow('500');
    await expect(fetchAdMobKeys((async () => new Response('{"keys":[]}')) as typeof fetch)).rejects.toThrow('no keys');
  });
});

const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (c) => new DynamoStore(new FakeDynamo(), 'table', c)],
];

describe.each(stores)('a rewarded ad, from the game to the credits, on %s', (_name, store) => {
  /** A world whose server believes AdMob's calls (made with our own key and a clock that is the world's). */
  function worldWithAds(extra: Parameters<typeof makeWorld>[0] = {}) {
    const w = makeWorld({ freePhotoCredits: 5, ...extra }, store);
    const callbacks = new AdMobCallbacks(['ca-app-pub-1111111111111111/2747237720'], { now: () => w.clock.t }, keys);
    (w.service as unknown as { d: { adCallbacks: AdCallbacks } }).d.adCallbacks = callbacks;
    return w;
  }
  const start = (w: World, who = ann, kind: 'photo' | 'video' = 'photo') => w.service.adStart(who, { kind, platform: 'android' });
  const reward = (w: World, nonce: string, tx: string, extra: Record<string, string | number> = {}) => w.service.adCallback(callback({ custom_data: nonce, transaction_id: tx, timestamp: w.clock.t, ...extra }));
  const credits = async (w: World, who = ann) => (await w.service.summary(who)).photo;
  const zero = (w: World, id = 'ann', c: { photo?: number; video?: number } = { photo: 0 }) => w.service.adminSetAccount(id, c);

  it('is not started for an account that is not owed credits, or from where there are no ads, or by a guest', async () => {
    const w = worldWithAds();
    expect(await start(w)).toMatchObject({ ok: false, error: 'ad-refused', reason: 'has-credits', account: { photo: 5 } });
    await zero(w);
    expect(await w.service.adStart(ann, { kind: 'photo', platform: 'web' as never })).toMatchObject({ ok: false, reason: 'platform' });
    expect(await w.service.adStart(ann, { kind: 'audio' as never, platform: 'ios' })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.adStart({ id: 'gx1', name: 'G', guest: true }, { kind: 'photo', platform: 'ios' })).toEqual({ ok: false, error: 'account-required' });
    expect(await start(w, ann, 'video')).toMatchObject({ ok: false, reason: 'plan' });                    // a free account gets nothing for a video ad
  });

  it('is refused when the server has no way to tell that an ad was watched, unless the operator takes the game’s word', async () => {
    const none = makeWorld({ freePhotoCredits: 5 }, store);
    await zero(none);
    expect(await start(none)).toEqual({ ok: false, error: 'ads-off' });
    const trusting = makeWorld({ freePhotoCredits: 5, adsTrusted: 1 }, store);
    await zero(trusting);
    const out = await start(trusting);
    expect(out).toMatchObject({ ok: true, mode: 'trusted' });
    expect(await trusting.service.claimAd(ann, { kind: 'photo', platform: 'android' })).toMatchObject({ ok: true, account: { photo: 5 } });
  });

  it('gives the credits when AdMob says the ad was watched, once, and not again for a call it repeats', async () => {
    const w = worldWithAds();
    await zero(w);
    const out = await start(w);
    if (!out.ok) throw new Error(out.error);
    expect(out.mode).toBe('verified');
    expect(out.nonce).toMatch(/^[a-z0-9]{10,}$/);
    expect(await credits(w)).toBe(0);                                                                  // nothing yet: the game only asked
    expect(await reward(w, out.nonce, 'TX-1')).toBe(true);
    expect(await w.service.summary(ann)).toMatchObject({ photo: 5, photoAdsLeft: 4 });
    expect(await reward(w, out.nonce, 'TX-1')).toBe(true);                                             // AdMob asks again when it did not hear us: no second grant
    expect(await credits(w)).toBe(5);
    await zero(w);
    expect(await reward(w, out.nonce, 'TX-2')).toBe(true);                                             // the number was used: another reward for it earns nothing
    expect(await credits(w)).toBe(0);
    expect(await w.store.getAdNonce(out.nonce)).toBeUndefined();
  });

  it('gives a paid account one video credit for a video ad, and counts the ads of each kind apart', async () => {
    const w = worldWithAds();
    await w.service.adminSetAccount('ann', { type: 'paid', video: 0, photo: 0 });
    const out = await start(w, ann, 'video');
    if (!out.ok) throw new Error(out.error);
    await reward(w, out.nonce, 'TX-V');
    expect(await w.service.summary(ann)).toMatchObject({ video: 1, videoAdsLeft: 4, photo: 0 });
    expect(await start(w, ann, 'video')).toMatchObject({ ok: false, reason: 'has-credits' });
  });

  it('gives nothing for a reward nobody asked for, one that came too late, or a number that belongs to someone else’s account', async () => {
    const w = worldWithAds();
    await zero(w);
    await zero(w, 'bob');
    expect(await reward(w, 'never-given', 'TX-A')).toBe(true);                                         // (a reward AdMob stands behind: it is answered, and earns nothing)
    expect(await reward(w, '', 'TX-B')).toBe(true);
    const out = await start(w);
    if (!out.ok) throw new Error();
    w.clock.t += 31 * 60 * 1000;
    expect(await reward(w, out.nonce, 'TX-C')).toBe(true);
    expect(await credits(w)).toBe(0);
    const mine = await start(w);
    if (!mine.ok) throw new Error();
    await reward(w, mine.nonce, 'TX-D');
    expect(await credits(w, bob)).toBe(0);                                                             // it went to the account that asked, and only to it
    expect(await credits(w)).toBe(5);
  });

  it('gives nothing when the account has been given credits since the ad was asked for, and still answers AdMob', async () => {
    const w = worldWithAds();
    await zero(w);
    const out = await start(w);
    if (!out.ok) throw new Error();
    await zero(w, 'ann', { photo: 2 });
    expect(await reward(w, out.nonce, 'TX-1')).toBe(true);
    expect(await credits(w)).toBe(2);
  });

  it('allows five ads a day, and starts again the next day', async () => {
    const w = worldWithAds();
    for (let i = 1; i <= 5; i++) {
      await zero(w);
      const out = await start(w);
      if (!out.ok) throw new Error(`ad ${i}: ${out.error}`);
      await reward(w, out.nonce, `TX-${i}`);
    }
    await zero(w);
    expect(await start(w)).toMatchObject({ ok: false, reason: 'daily-limit' });
    w.clock.t += DAY;
    expect((await start(w)).ok).toBe(true);
  });

  it('turns away a call that is not AdMob’s, and writes down how many ads were rewarded', async () => {
    const w = worldWithAds();
    await zero(w);
    const out = await start(w);
    if (!out.ok) throw new Error();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await w.service.adCallback(callback({ custom_data: out.nonce }).replace('reward_amount=5', 'reward_amount=50'))).toBe(false);
    expect(await credits(w)).toBe(0);
    expect(await reward(w, out.nonce, 'TX-1')).toBe(true);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ ad: 'rewarded', kind: 'photo', given: true, transaction: 'TX-1' }));
    log.mockRestore();
    expect(await makeWorld({}, store).service.adCallback(callback({}))).toBe(false);                      // a server with no ad network believes no call
  });

  it('is answered as the router does', async () => {
    const w = worldWithAds();
    await zero(w);
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
    const json = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
    const begin = await route({ method: 'POST', path: '/credits/ad/start', query: new URLSearchParams(), authorization: 'Bearer dev:ann:Ann', body: json({ kind: 'photo', platform: 'ios' }) });
    expect(begin.status).toBe(200);
    const nonce = (begin.body as { nonce: string }).nonce;
    const raw = callback({ custom_data: nonce, transaction_id: 'TX-R', timestamp: w.clock.t });
    const get = (rawQuery: string) => route({ method: 'GET', path: '/credits/ad/callback', query: new URLSearchParams(rawQuery), rawQuery, body: new Uint8Array() });
    expect((await get(raw.replace('reward_amount=5', 'reward_amount=6'))).status).toBe(403);
    expect(await get(raw)).toEqual({ status: 200, body: { ok: true } });                               // (no sign-in: AdMob has none)
    expect(await credits(w)).toBe(5);
    expect((await get('')).status).toBe(403);
    expect((await route({ method: 'POST', path: '/credits/ad/start', query: new URLSearchParams(), body: json({}) })).status).toBe(401);
    const cold = makeWorld({}, store);
    const r2 = createRouter({ service: cold.service, auth: new DevAuth(), media: cold.media });
    expect((await r2({ method: 'POST', path: '/credits/ad/start', query: new URLSearchParams(), authorization: 'Bearer dev:ann:Ann', body: json({ kind: 'photo', platform: 'ios' }) })).status).toBe(503);
  });
});
