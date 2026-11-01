import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type CreateRoomRequest } from '../src/online/protocol';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { createRouter, DevAuth } from '../server/src/router';
import type { Player } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, joined, open, request, world as makeWorld, type MakeStore, type World } from './helpers/world';

// Hints and bombs are kept on the account and given out by rules of the service: the same on both stores.
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

const guest: Player = { id: 'gAAAAAAAAAAAAAAAAAAAAAA', name: 'Guest', guest: true };
const cmd = (w: World, p: Player, id: string, command: unknown) => w.service.command(p, id, { protocol: PROTOCOL_VERSION, command: command as never });

/** A small Tile Swap room: solved by hints in at most a few dozen of them. */
const swapRequest = (extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest => ({
  protocol: PROTOCOL_VERSION,
  consent: true,
  sourceId: 'abc123',
  settings: { kind: 'focus', seed: 5, width: 400, height: 300, opts: { pieces: 20, irregular: 1 } },
  ...extra,
});

describe.each(stores)('hints and bombs on %s', (_name, store) => {
  const world = () => makeWorld({}, store);

  describe('the account holds them', () => {
    it('starts with 10 hints and 2 bombs, whatever the type, and the operator with as many as it likes', async () => {
      const w = world();
      for (const type of ['free', 'paid', 'family', 'admin'] as const) {
        await w.service.adminSetAccount('ann', { type });
        expect(await w.service.summary(ann)).toMatchObject({ hints: 10, bombs: 2, hintsInfinite: type === 'admin', bombsInfinite: type === 'admin' });
      }
      expect(await w.service.summary(guest)).toMatchObject({ hints: 0, bombs: 0, hintsInfinite: false });
    });

    it('is given the starting number by an account that was made before they existed', async () => {
      const w = world();
      await w.store.putAccount({ id: 'ann', type: 'free', photo: 3, video: 0, adDay: '1970-01-01', photoAds: 0, videoAds: 0, createdAt: 0, rev: 0 });
      expect(await w.service.summary(ann)).toMatchObject({ photo: 3, hints: 10, bombs: 2 });
      expect(await w.service.useItem(ann, { item: 'bomb' })).toMatchObject({ ok: true, account: { bombs: 1, hints: 10 } });
      expect(await w.store.getAccount('ann')).toMatchObject({ hints: 10, bombs: 1 });
    });

    it('is changed by the operator, as the credits are', async () => {
      const w = world();
      expect(await w.service.adminSetAccount('ann', { hints: 50, bombs: 7 })).toMatchObject({ ok: true, account: { hints: 50, bombs: 7 } });
      expect(await w.service.adminSetAccount('ann', { bombs: 1 })).toMatchObject({ ok: true, account: { hints: 50, bombs: 1 } });
      for (const bad of [{ hints: -1 }, { bombs: 1.5 }, { hints: '3' }, { bombs: 2_000_000 }]) expect(await w.service.adminSetAccount('ann', bad as never)).toEqual({ ok: false, error: 'bad-request' });
      expect((await w.service.adminAccounts(['ann', 'nobody'])).get('nobody')).toMatchObject({ hints: 10, bombs: 2 });
    });
  });

  describe('using one in a puzzle played alone', () => {
    it('takes one, and says no when there are none left, without going below zero', async () => {
      const w = world();
      await w.service.adminSetAccount('ann', { hints: 2, bombs: 1 });
      expect(await w.service.useItem(ann, { item: 'hint' })).toMatchObject({ ok: true, account: { hints: 1, bombs: 1 } });
      expect(await w.service.useItem(ann, { item: 'hint' })).toMatchObject({ ok: true, account: { hints: 0 } });
      expect(await w.service.useItem(ann, { item: 'hint' })).toMatchObject({ ok: false, error: 'no-credits', item: 'hint', account: { hints: 0, bombs: 1 } });
      expect(await w.service.useItem(ann, { item: 'bomb' })).toMatchObject({ ok: true, account: { bombs: 0 } });
      expect(await w.service.useItem(ann, { item: 'bomb' })).toMatchObject({ ok: false, error: 'no-credits', item: 'bomb' });
      expect(await w.store.getAccount('ann')).toMatchObject({ hints: 0, bombs: 0 });
    });

    it('takes nothing from the operator', async () => {
      const w = world();
      await w.service.adminSetAccount('ann', { type: 'admin', hints: 0, bombs: 0 });
      for (let i = 0; i < 3; i++) expect(await w.service.useItem(ann, { item: 'hint' })).toMatchObject({ ok: true, account: { hintsInfinite: true } });
      expect(await w.service.useItem(ann, { item: 'bomb' })).toMatchObject({ ok: true });
      expect(await w.store.getAccount('ann')).toMatchObject({ hints: 0, bombs: 0 });
      expect(await w.service.useItem({ ...ann, admin: true }, { item: 'bomb' })).toMatchObject({ ok: true });         // (the administrators' group counts too)
    });

    it('is for accounts, and for the two things only', async () => {
      const w = world();
      expect(await w.service.useItem(guest, { item: 'hint' })).toEqual({ ok: false, error: 'account-required' });
      for (const bad of [{}, { item: 'rocket' }, { item: 7 }, undefined]) expect(await w.service.useItem(ann, bad as never)).toEqual({ ok: false, error: 'bad-request' });
    });

    it('gives a hint for a solved puzzle: one for S and M, two for the bigger sizes', async () => {
      const w = world();
      await w.service.adminSetAccount('ann', { hints: 0 });
      expect(await w.service.awardSolved(ann, { size: 0 })).toMatchObject({ ok: true, account: { hints: 1 } });
      expect(await w.service.awardSolved(ann, { size: 1 })).toMatchObject({ ok: true, account: { hints: 2 } });
      expect(await w.service.awardSolved(ann, { size: 2 })).toMatchObject({ ok: true, account: { hints: 4 } });
      expect(await w.service.awardSolved(ann, { size: 5 })).toMatchObject({ ok: true, account: { hints: 6 } });
      expect(await w.service.awardSolved(guest, { size: 0 })).toEqual({ ok: false, error: 'account-required' });
      for (const bad of [{ size: -1 }, { size: 1.5 }, { size: 10 }, { size: '2' }, {}]) expect(await w.service.awardSolved(ann, bad as never)).toEqual({ ok: false, error: 'bad-request' });
    });

    it('is asked for with the routes, by an account', async () => {
      const w = world();
      const router = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
      const post = (who: string, path: string, body: unknown) =>
        router({ method: 'POST', path, query: new URLSearchParams(), authorization: `Bearer dev:${who}:${who}`, body: new TextEncoder().encode(JSON.stringify(body)) });
      expect(await post('ann', '/items/use', { item: 'hint' })).toMatchObject({ status: 200, body: { ok: true, account: { hints: 9 } } });
      expect(await post('ann', '/items/award', { size: 3 })).toMatchObject({ status: 200, body: { ok: true, account: { hints: 11 } } });
      await w.service.adminSetAccount('ann', { bombs: 0 });
      expect(await post('ann', '/items/use', { item: 'bomb' })).toMatchObject({ status: 402, body: { ok: false, error: 'no-credits', item: 'bomb' } });
    });
  });

  describe('the most that can be earned in a day', () => {
    const award = (w: World, p: Player, size = 2) => w.service.awardSolved(p, { size }) as Promise<{ ok: true; given: number; account: { hints: number; earnLeft: number; earnInfinite: boolean } }>;

    it('is 10 hints for a free account, and what a puzzle is worth beyond it is not given', async () => {
      const w = world();
      await w.service.adminSetAccount('ann', { hints: 0 });
      expect(await w.service.summary(ann)).toMatchObject({ earnPerDay: 10, earnLeft: 10, earnInfinite: false });
      for (let i = 0; i < 4; i++) expect(await award(w, ann)).toMatchObject({ given: 2, account: { hints: 2 * (i + 1), earnLeft: 10 - 2 * (i + 1) } });
      expect(await award(w, ann, 0)).toMatchObject({ given: 1, account: { hints: 9, earnLeft: 1 } });
      expect(await award(w, ann, 2)).toMatchObject({ given: 1, account: { hints: 10, earnLeft: 0 } });             // (worth 2, one left)
      expect(await award(w, ann, 2)).toMatchObject({ ok: true, given: 0, account: { hints: 10, earnLeft: 0 } });
      expect(await award(w, ann, 0)).toMatchObject({ given: 0, account: { hints: 10 } });
    });

    it('counts what was earned, not what is held: spending hints does not make room', async () => {
      const w = world();
      await w.service.adminSetAccount('ann', { hints: 0 });
      await award(w, ann, 2);
      await w.service.useItem(ann, { item: 'hint' });
      expect(await w.service.summary(ann)).toMatchObject({ hints: 1, earnLeft: 8 });
    });

    it('starts again at midnight UTC', async () => {
      const w = world();
      await w.service.adminSetAccount('ann', { hints: 0 });
      for (let i = 0; i < 10; i++) await award(w, ann, 0);
      expect(await award(w, ann, 0)).toMatchObject({ given: 0 });
      w.clock.t += DAY;
      expect(await w.service.summary(ann)).toMatchObject({ earnLeft: 10 });
      expect(await award(w, ann, 2)).toMatchObject({ given: 2, account: { hints: 12, earnLeft: 8 } });
    });

    it('is no limit for paid, family and admin accounts', async () => {
      const w = world();
      for (const type of ['paid', 'family', 'admin'] as const) {
        await w.service.adminSetAccount('ann', { type, hints: 0 });
        let total = 0;
        for (let i = 0; i < 8; i++) total += (await award(w, ann, 2)).given;
        expect(total, type).toBe(16);
        expect(await w.service.summary(ann)).toMatchObject({ hints: 16, earnInfinite: true });
      }
    });

    it('is nothing for a guest, who earns none', async () => {
      const w = world();
      expect(await w.service.summary(guest)).toMatchObject({ earnPerDay: 0, earnLeft: 0, earnInfinite: false });
      expect(await award(w, guest)).toEqual({ ok: false, error: 'account-required' });
    });

    it('holds for the members of a puzzle played with friends too, each by their own count', async () => {
      const w = world();
      const made = await open(w, ann, swapRequest({ helpers: true }));
      await joined(w, made, bob);
      await w.service.adminSetAccount('ann', { hints: 1000 });
      await w.service.adminSetAccount('bob', { hints: 0 });
      for (let i = 0; i < 5; i++) await award(w, bob, 2);                                    // (bob has earned all of today's already)
      await w.service.adminSetAccount('bob', { hints: 3 });
      let solved = false;
      while (!solved) {
        const room = (await w.service.getRoom(ann, made.roomId)) as { room: { state: { game: { slotOf: number[] } } } };
        const res = await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'hint', piece: room.room.state.game.slotOf.findIndex((s, i) => s !== i) } });
        solved = res.ok && res.event.solved;
      }
      expect((await w.service.summary(bob)).hints).toBe(3);                                   // nothing more for bob today
      expect((await w.service.summary(ann)).earnLeft).toBe(9);                                // ann had earned none, and a small puzzle gave her one
    });
  });

  describe('in a puzzle played with friends', () => {
    const swapHint = async (w: World, p: Player, id: string, piece?: number) => {
      const room = (await w.service.getRoom(p, id)) as { ok: true; room: { state: { game: { slotOf: number[] } } } };
      const slotOf = room.room.state.game.slotOf;
      return cmd(w, p, id, { t: 'hint', piece: piece ?? slotOf.findIndex((s, i) => s !== i) });
    };

    it('is allowed only when the host chose it, and says so to everyone who joins', async () => {
      const w = world();
      const on = await open(w, ann, swapRequest({ helpers: true }));
      const off = await open(w, ann, swapRequest());
      expect((await joined(w, on, bob)).helpers).toBe(true);
      expect((await joined(w, off, bob)).helpers).toBe(false);
      expect(await swapHint(w, bob, off.roomId)).toEqual({ ok: false, error: 'helpers-off' });
      expect(await cmd(w, bob, off.roomId, { t: 'bomb', x: 100, y: 100 })).toEqual({ ok: false, error: 'helpers-off' });
      expect((await w.service.summary(bob)).hints).toBe(10);                                // (nothing was taken)
      expect((await swapHint(w, bob, on.roomId)).ok).toBe(true);
    });

    it('keeps the choice for a Jigsaw as well, and for a puzzle that has none it is left out', async () => {
      const w = world();
      const jig = await open(w, ann, request({}, { helpers: true }));
      expect((await joined(w, jig, bob)).helpers).toBe(true);
      const live = await w.service.getRoom(ann, jig.roomId);
      expect(live).toMatchObject({ ok: true, room: { helpers: true } });
    });

    it('takes the item from the player who uses it, and gives it back when the room does not take the operation', async () => {
      const w = world();
      const made = await open(w, ann, swapRequest({ helpers: true }));
      await joined(w, made, bob);
      const taken = await swapHint(w, bob, made.roomId);
      expect(taken.ok).toBe(true);
      expect((await w.service.summary(bob)).hints).toBe(9);
      expect((await w.service.summary(ann)).hints).toBe(10);
      // the same piece again is a refusal (it is in place now): the hint that was taken for it comes back
      const piece = ((await w.service.getRoom(bob, made.roomId)) as { room: { state: { game: { slotOf: number[] } } } }).room.state.game.slotOf.findIndex((s, i) => s !== i);
      expect((await swapHint(w, bob, made.roomId, piece)).ok).toBe(true);
      expect((await w.service.summary(bob)).hints).toBe(8);
      expect(await swapHint(w, bob, made.roomId, piece)).toMatchObject({ ok: false, error: 'no-group' });
      expect((await w.service.summary(bob)).hints).toBe(8);
      expect(await cmd(w, bob, made.roomId, { t: 'hint', piece: 9999 })).toMatchObject({ ok: false, error: 'bad-request' });
      expect((await w.service.summary(bob)).hints).toBe(8);
      expect(await cmd(w, bob, made.roomId, { t: 'bomb', x: -1, y: 0 })).toMatchObject({ ok: false });
      expect((await w.service.summary(bob)).bombs).toBe(2);
    });

    it('refuses when the player has none, and takes nothing from the operator', async () => {
      const w = world();
      const made = await open(w, ann, swapRequest({ helpers: true }));
      await joined(w, made, bob);
      await w.service.adminSetAccount('bob', { hints: 0 });
      expect(await swapHint(w, bob, made.roomId)).toMatchObject({ ok: false, error: 'no-credits', item: 'hint' });
      await w.service.adminSetAccount('ann', { type: 'admin', hints: 0 });
      expect((await swapHint(w, ann, made.roomId)).ok).toBe(true);
      expect(await w.store.getAccount('ann')).toMatchObject({ hints: 0 });
    });

    it('is not for a guest, who has nothing to use', async () => {
      const w = world();
      const made = await open(w, ann, swapRequest({ helpers: true }));
      await joined(w, made, guest);
      expect(await swapHint(w, guest, made.roomId)).toEqual({ ok: false, error: 'account-required' });
    });

    it('gives every member with an account the hints of the puzzle when it is solved, and nobody else', async () => {
      const w = world();
      const made = await open(w, ann, swapRequest({ helpers: true }));
      await joined(w, made, bob);
      await joined(w, made, guest);
      await w.service.adminSetAccount('ann', { hints: 1000 });
      let solved = false;
      let used = 0;
      for (let i = 0; i < 40 && !solved; i++) {
        const res = await swapHint(w, ann, made.roomId);
        expect(res.ok).toBe(true);
        used++;
        solved = res.ok && res.event.solved;
      }
      expect(solved).toBe(true);
      expect((await w.service.summary(ann)).hints).toBe(1000 - used + 1);                  // 20 pieces is a small puzzle: one hint back
      expect((await w.service.summary(bob)).hints).toBe(11);
      expect(await w.store.getAccount(guest.id)).toBeUndefined();
      // and a puzzle that is solved is over: a hint is refused (and costs nothing)
      expect(await cmd(w, ann, made.roomId, { t: 'hint', piece: 0 })).toMatchObject({ ok: false, error: 'ended' });
    });

    it('gives two for a bigger puzzle', async () => {
      const w = world();
      const made = await open(w, ann, { ...swapRequest({ helpers: true }), settings: { kind: 'focus', seed: 5, width: 400, height: 300, opts: { pieces: 200, irregular: 1 } } });
      await w.service.adminSetAccount('ann', { hints: 5000 });
      let solved = false;
      let used = 0;
      for (let i = 0; i < 400 && !solved; i++) {
        const res = await swapHint(w, ann, made.roomId);
        used++;
        solved = res.ok && res.event.solved;
      }
      expect(solved).toBe(true);
      expect((await w.service.summary(ann)).hints).toBe(5000 - used + 2);
    });
  });
});
