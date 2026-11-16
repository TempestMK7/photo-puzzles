import { describe, expect, it } from 'vitest';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { createRouter, DevAuth } from '../server/src/router';
import type { Player } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, DAY, world as makeWorld, type MakeStore } from './helpers/world';

// The daily gift of hints, and the count of hints and bombs used (for the admin page): rules of the service, the same on both stores.
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

const guest: Player = { id: 'gAAAAAAAAAAAAAAAAAAAAAA', name: 'Guest', guest: true };

describe.each(stores)('the daily gift on %s', (_name, store) => {
  const world = () => makeWorld({}, store);

  it('is ready for an account that has not taken it today, and not for a guest', async () => {
    const w = world();
    expect(await w.service.summary(ann)).toMatchObject({ giftReady: true, giftHints: 2, hints: 10 });
    expect(await w.service.summary(guest)).toMatchObject({ type: 'guest', giftReady: false, giftHints: 0 });
  });

  it('gives its hints once a day (a day of UTC), and is ready again the next', async () => {
    const w = world();
    expect(await w.service.claimGift(ann)).toMatchObject({ ok: true, account: { hints: 12, giftReady: false } });
    expect(await w.service.claimGift(ann)).toMatchObject({ error: 'gift-taken', account: { hints: 12, giftReady: false } });
    expect(await w.store.getAccount('ann')).toMatchObject({ hints: 12 });
    w.clock.t += DAY;
    expect(await w.service.summary(ann)).toMatchObject({ giftReady: true });
    expect(await w.service.claimGift(ann)).toMatchObject({ ok: true, account: { hints: 14 } });
  });

  it('is taken by one account at a time, and does not touch the bombs or the daily count of hints earned', async () => {
    const w = world();
    await w.service.claimGift(ann);
    expect(await w.service.summary(ann)).toMatchObject({ bombs: 2, earnLeft: 10 });
    expect(await w.service.summary({ id: 'bob', name: 'Bob' })).toMatchObject({ giftReady: true, hints: 10 });
  });

  it('is refused to a guest', async () => {
    const w = world();
    expect(await w.service.claimGift(guest)).toEqual({ ok: false, error: 'account-required' });
  });

  it('is asked for with the route: 200 and then 409', async () => {
    const w = world();
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
    const post = (who: string, path: string) => route({ method: 'POST', path, query: new URLSearchParams(), authorization: `Bearer dev:${who}:Name`, body: new TextEncoder().encode('{}') });
    expect(await post('ann', '/items/gift')).toMatchObject({ status: 200, body: { ok: true, account: { hints: 12 } } });
    expect(await post('ann', '/items/gift')).toMatchObject({ status: 409, body: { error: 'gift-taken' } });
  });
});

describe.each(stores)('the count of hints and bombs used on %s', (_name, store) => {
  it('goes up with each one taken for a puzzle (one sent twice with the same id counts once), and is on the admin page', async () => {
    const w = makeWorld({}, store);
    await w.service.useItem(ann, { item: 'hint', id: 'aaaaaaaa1' });
    await w.service.useItem(ann, { item: 'hint', id: 'aaaaaaaa1' });
    await w.service.useItem(ann, { item: 'hint' });
    await w.service.useItem(ann, { item: 'bomb' });
    expect((await w.service.adminAccounts(['ann'])).get('ann')).toMatchObject({ hints: 8, bombs: 1, hintsUsed: 2, bombsUsed: 1 });
  });
});
