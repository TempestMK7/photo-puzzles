import { describe, expect, it } from 'vitest';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import type { Player } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, world as makeWorld, type MakeStore } from './helpers/world';

// What a guest has left of hints and bombs goes to the account they make: the same on both stores.
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

const guest: Player = { id: 'gAAAAAAAAAAAAAAAAAAAAAA', name: 'Guest', guest: true };
const other: Player = { id: 'gBBBBBBBBBBBBBBBBBBBBBB', name: 'Guest', guest: true };
const MIN = 60_000;

describe.each(stores)('carrying a guest\'s hints and bombs to an account on %s', (_name, store) => {
  const world = () => makeWorld({}, store);

  it('adds what the guest has left to the 10 hints and 2 bombs of the new account, once, and leaves the guest with none', async () => {
    const w = world();
    await w.service.summary(guest);
    await w.service.useItem(guest, { item: 'hint' });
    await w.service.summary(ann);
    expect(await w.service.carryGuest(ann, guest.id)).toMatchObject({ ok: true, account: { type: 'free', hints: 14, bombs: 3 } });
    expect(await w.service.summary(guest)).toMatchObject({ hints: 0, bombs: 0 });
    expect(await w.service.carryGuest(ann, guest.id)).toMatchObject({ ok: true, account: { hints: 14, bombs: 3 } });         // (again: nothing)
    expect(await w.service.carryGuest(ann, other.id)).toMatchObject({ ok: true, account: { hints: 14, bombs: 3 } });          // (the account has taken one guest's)
  });

  it('is done by the first look at the account too, with no earlier one: the account is made then', async () => {
    const w = world();
    await w.service.summary(guest);
    expect(await w.service.carryGuest(ann, guest.id)).toMatchObject({ ok: true, account: { hints: 15, bombs: 3 } });
  });

  it('is not done for a guest that has been taken before, by another account', async () => {
    const w = world();
    await w.service.summary(guest);
    await w.service.carryGuest(ann, guest.id);
    expect(await w.service.carryGuest(bob, guest.id)).toMatchObject({ ok: true, account: { hints: 10, bombs: 2 } });
  });

  it('is only for an account that is new: after an hour what the guest has stays with the guest', async () => {
    const w = world();
    await w.service.summary(ann);
    await w.service.summary(guest);
    w.clock.t += 61 * MIN;
    expect(await w.service.carryGuest(ann, guest.id)).toMatchObject({ ok: true, account: { hints: 10, bombs: 2 } });
    expect(await w.service.summary(guest)).toMatchObject({ hints: 5, bombs: 1 });
  });

  it('is not for a guest to ask, and nothing happens for a guest that was never seen', async () => {
    const w = world();
    expect(await w.service.carryGuest(guest, other.id)).toEqual({ ok: false, error: 'account-required' });
    expect(await w.service.carryGuest(ann, other.id)).toMatchObject({ ok: true, account: { hints: 10, bombs: 2 } });
  });

  it('keeps the guest\'s wait for the next ad, so that making an account does not shorten it', async () => {
    const w = world();
    await w.service.summary(ann);                                    // (made at 0: its first ad is ready at 15 minutes)
    w.clock.t += 10 * MIN;
    await w.service.summary(guest);                                  // (first seen at 10: ready at 25)
    expect(await w.service.carryGuest(ann, guest.id)).toMatchObject({ ok: true, account: { helpAdReady: false, helpAdIn: 15 * MIN } });
  });

  it('is only the guest\'s own record: the stock a guest starts with is not given again to the account, and the account keeps its credits', async () => {
    const w = world();
    await w.service.summary(guest);
    const done = await w.service.carryGuest(ann, guest.id);
    expect(done).toMatchObject({ ok: true, account: { type: 'free', photo: 1000 } });
  });
});

describe('a guest\'s record', () => {
  it('runs out 100 days after it was last written, in the cloud (and a guest who comes back then starts again)', async () => {
    const w = makeWorld({}, (clock) => new DynamoStore(new FakeDynamo(), 'table', clock));
    await w.service.summary(guest);
    await w.service.useItem(guest, { item: 'bomb' });
    expect(await w.store.getAccount(guest.id)).toMatchObject({ bombs: 0 });
    w.clock.t += 101 * DAY;
    expect(await w.store.getAccount(guest.id)).toBeUndefined();
    expect(await w.service.summary(guest)).toMatchObject({ hints: 5, bombs: 1 });
  });

  it('is kept as long as the guest comes back, and an account\'s never runs out', async () => {
    const w = makeWorld({}, (clock) => new DynamoStore(new FakeDynamo(), 'table', clock));
    await w.service.summary(guest);
    await w.service.summary(ann);
    for (let i = 0; i < 4; i++) {
      w.clock.t += 60 * DAY;
      await w.service.useItem(guest, { item: 'hint' });                       // (a write: put forward)
    }
    expect(await w.store.getAccount(guest.id)).toMatchObject({ hints: 1 });
    expect(await w.store.getAccount(ann.id)).toBeDefined();
  });
});
