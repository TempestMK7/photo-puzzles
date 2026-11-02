import { describe, expect, it } from 'vitest';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { createRouter, DevAuth } from '../server/src/router';
import type { Player } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, world as makeWorld, type MakeStore, type World } from './helpers/world';

// Ads (and the same without an ad) for hints and bombs are rules of the service: the same on both stores.
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

const guest: Player = { id: 'gAAAAAAAAAAAAAAAAAAAAAA', name: 'Guest', guest: true };
const MIN = 60_000;
/** Makes the accounts of the test and lets the first wait (15 minutes after an account is made) pass. */
const grown = async (w: World): Promise<World> => {
  for (const who of [ann, bob]) await w.service.summary(who);
  w.clock.t += 16 * MIN;
  return w;
};
const ad = (kind: 'hint' | 'bomb', platform: 'android' | 'ios' | 'web' = 'android') => ({ kind, platform }) as Parameters<World['service']['claimAd']>[1];

describe.each(stores)('ads for hints and bombs on %s', (_name, store) => {
  const world = (extra: Parameters<typeof makeWorld>[0] = {}) => makeWorld({ adsTrusted: 1, ...extra }, store);

  it('is not ready for a new account for 15 minutes, and then is, for 5 hints or 1 bomb; it says whether the account is given them without an ad', async () => {
    const w = world();
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: false, helpAdIn: 15 * MIN, helpAdHints: 5, helpAdBombs: 1, helpAdNoAd: false });
    expect(await w.service.claimAd(ann, ad('hint'))).toMatchObject({ ok: false, error: 'ad-refused', reason: 'wait', account: { hints: 10 } });
    expect(await w.service.adStart(ann, { kind: 'hint', platform: 'ios' })).toMatchObject({ ok: false, reason: 'wait' });
    w.clock.t += 14 * MIN;
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: false, helpAdIn: MIN });
    w.clock.t += MIN;
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: true, helpAdIn: 0 });
    await w.service.adminSetAccount('ann', { type: 'paid' });
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: true, helpAdNoAd: true });
    expect(await w.service.rewardHelp(bob, { item: 'hint' })).toMatchObject({ ok: false, reason: 'watch' });
    expect(await w.service.summary(guest)).toMatchObject({ helpAdReady: false, helpAdNoAd: false });
  });

  it('counts the 15 minutes from when the account was made, for an account that has not had one, paid ones too', async () => {
    const w = world();
    await w.service.summary(ann);
    w.clock.t += 10 * MIN;
    await w.service.summary(bob);
    await w.service.adminSetAccount('bob', { type: 'paid' });
    expect(await w.service.rewardHelp(bob, { item: 'hint' })).toMatchObject({ ok: false, reason: 'wait', account: { helpAdIn: 15 * MIN } });
    w.clock.t += 5 * MIN;
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: true });
    expect(await w.service.summary(bob)).toMatchObject({ helpAdReady: false, helpAdIn: 10 * MIN });
  });

  it('gives a free account 5 hints for an ad, or 1 bomb, and then not again for 20 to 30 minutes', async () => {
    const w = await grown(world());
    expect(await w.service.claimAd(ann, ad('hint'))).toMatchObject({ ok: true, account: { hints: 15, bombs: 2, helpAdReady: false } });
    const waits = await w.service.summary(ann);
    expect(waits.helpAdIn).toBeGreaterThanOrEqual(20 * MIN);
    expect(waits.helpAdIn).toBeLessThanOrEqual(30 * MIN);
    // one ad at a time, whichever it was for
    expect(await w.service.claimAd(ann, ad('hint'))).toMatchObject({ ok: false, error: 'ad-refused', reason: 'wait', account: { hints: 15 } });
    expect(await w.service.claimAd(ann, ad('bomb'))).toMatchObject({ ok: false, reason: 'wait' });
    expect(await w.service.adStart(ann, { kind: 'bomb', platform: 'ios' })).toMatchObject({ ok: false, reason: 'wait' });          // (no ad is shown for nothing)
    w.clock.t += 31 * MIN;
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: true, helpAdIn: 0 });
    expect(await w.service.claimAd(ann, ad('bomb'))).toMatchObject({ ok: true, account: { hints: 15, bombs: 3, helpAdReady: false } });
  });

  it('makes the wait different every time, never under 20 minutes nor over 30', async () => {
    const w = await grown(world());
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      await w.service.claimAd(ann, ad('hint'));
      const s = await w.service.summary(ann);
      expect(s.helpAdIn).toBeGreaterThanOrEqual(20 * MIN);
      expect(s.helpAdIn).toBeLessThanOrEqual(30 * MIN);
      seen.add(s.helpAdIn);
      w.clock.t += 31 * MIN;
    }
    expect(seen.size).toBeGreaterThan(6);
  });

  it('does not need the account to be out of hints or credits, is not held to the cap on earned hints, and does not touch it', async () => {
    const w = await grown(world());
    for (let i = 0; i < 5; i++) await w.service.awardSolved(ann, { size: 2 });                 // (all of today's earned)
    expect(await w.service.summary(ann)).toMatchObject({ hints: 20, earnLeft: 0, photo: 1000 });
    expect(await w.service.claimAd(ann, ad('hint'))).toMatchObject({ ok: true, account: { hints: 25, earnLeft: 0 } });
  });

  it('is for the apps, and for an account that has one', async () => {
    const w = await grown(world());
    expect(await w.service.claimAd(ann, ad('hint', 'web'))).toMatchObject({ ok: false, reason: 'platform' });
    expect(await w.service.claimAd(guest, ad('hint'))).toEqual({ ok: false, error: 'account-required' });
    expect(await w.service.claimAd(ann, { kind: 'rocket' as never, platform: 'ios' })).toEqual({ ok: false, error: 'bad-request' });
    await w.service.adminSetAccount('bob', { type: 'paid' });
    expect(await w.service.claimAd(bob, ad('hint'))).toMatchObject({ ok: false, reason: 'plan' });          // (a paid account is given them, without an ad)
    expect(await (await grown(makeWorld({}, store))).service.claimAd(ann, ad('hint'))).toEqual({ ok: false, error: 'ads-off' });
  });

  it('is what a paid, family or admin account is given for the press of a button, as often as a free account could watch', async () => {
    const w = await grown(world());
    for (const type of ['paid', 'family', 'admin'] as const) {
      await w.service.adminSetAccount('ann', { type, hints: 0, bombs: 0 });
      const record = (await w.store.getAccount('ann'))!;
      await w.store.putAccount({ ...record, helpAdAt: 0, rev: record.rev + 1 });
      expect(await w.service.rewardHelp(ann, { item: 'hint' }), type).toMatchObject({ ok: true, account: { hints: 5, helpAdReady: false } });
      expect(await w.service.rewardHelp(ann, { item: 'bomb' }), type).toMatchObject({ ok: false, error: 'ad-refused', reason: 'wait', account: { hints: 5, bombs: 0 } });
      w.clock.t += 31 * MIN;
      expect(await w.service.rewardHelp(ann, { item: 'bomb' }), type).toMatchObject({ ok: true, account: { hints: 5, bombs: 1 } });
      w.clock.t += 31 * MIN;
    }
  });

  it('is not given to a free account without the ad, nor to a guest, nor for anything but the two', async () => {
    const w = await grown(world());
    expect(await w.service.rewardHelp(ann, { item: 'hint' })).toMatchObject({ ok: false, error: 'ad-refused', reason: 'watch', account: { hints: 10 } });
    expect(await w.service.rewardHelp(guest, { item: 'hint' })).toEqual({ ok: false, error: 'account-required' });
    await w.service.adminSetAccount('ann', { type: 'paid' });
    for (const bad of [{}, { item: 'rocket' }, undefined]) expect(await w.service.rewardHelp(ann, bad as never)).toEqual({ ok: false, error: 'bad-request' });
  });

  it('has its own wait, apart from the ads for credits: neither one starts or uses the other', async () => {
    const w = await grown(world({ freePhotoCredits: 0, adsPerDay: 2 }));
    // an ad for hints first: the ads for photo credits are all still there
    await w.service.claimAd(ann, ad('hint'));
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: false, photoAdsLeft: 2, photo: 0 });
    expect(await w.service.claimAd(ann, { kind: 'photo', platform: 'android' })).toMatchObject({ ok: true, account: { photo: 5, photoAdsLeft: 1, helpAdReady: false } });
    // and the other way: the wait for hints did not move for an ad for credits, and the day's count of those does not hold it back
    w.clock.t += 31 * MIN;
    expect(await w.service.summary(ann)).toMatchObject({ helpAdReady: true, photoAdsLeft: 1 });
    expect(await w.service.claimAd(ann, ad('bomb'))).toMatchObject({ ok: true, account: { bombs: 3, photoAdsLeft: 1 } });
  });

  it('starts again the next day whatever the wait was', async () => {
    const w = await grown(world());
    await w.service.claimAd(ann, ad('hint'));
    w.clock.t += DAY;
    expect(await w.service.claimAd(ann, ad('hint'))).toMatchObject({ ok: true, account: { hints: 20 } });
  });

  it('is asked for with the routes, by an account', async () => {
    const w = await grown(world());
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
    const post = (who: string, path: string, body: unknown) => route({ method: 'POST', path, query: new URLSearchParams(), authorization: `Bearer dev:${who}:Name`, body: new TextEncoder().encode(JSON.stringify(body)) });
    expect(await post('ann', '/items/reward', { item: 'hint' })).toMatchObject({ status: 409, body: { reason: 'watch' } });
    expect(await post('ann', '/credits/ad', ad('hint'))).toMatchObject({ status: 200, body: { ok: true, account: { hints: 15 } } });
    expect(await post('ann', '/credits/ad', ad('bomb'))).toMatchObject({ status: 409, body: { reason: 'wait' } });
    await w.service.adminSetAccount('bob', { type: 'paid' });
    expect(await post('bob', '/items/reward', { item: 'bomb' })).toMatchObject({ status: 200, body: { ok: true, account: { bombs: 3 } } });
    expect(await post('bob', '/items/reward', { item: 'bomb' })).toMatchObject({ status: 409, body: { reason: 'wait' } });
  });
});
