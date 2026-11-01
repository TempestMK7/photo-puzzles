import { describe, expect, it, vi } from 'vitest';
import { GUEST_ACCOUNT, PROTOCOL_VERSION, type CreateRoomRequest } from '../src/online/protocol';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { createRouter, DevAuth } from '../server/src/router';
import type { Moderation } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, cy, DAY, jpeg, joined, open, request, world as makeWorld, type MakeStore, type World } from './helpers/world';

// The account types and their credits are rules of the service: the same on both stores.
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

const videoRequest = (extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest => request({}, { video: { type: 'video/mp4', bytes: 5000, ms: 12_000 }, ...extra });
const type = (w: World, id: string, t: 'free' | 'paid' | 'family' | 'admin', more: { photo?: number; video?: number } = {}) => w.service.adminSetAccount(id, { type: t, ...more });

describe.each(stores)('accounts and credits on %s', (_name, store) => {
  const world = (extra: Parameters<typeof makeWorld>[0] = {}, ...rest: [undefined?, undefined?, Moderation?]) => makeWorld({ freePhotoCredits: 5, ...extra }, store, rest[0], rest[1], rest[2]);

  describe('what an account is', () => {
    it('is made free, with the starting photo credits and no video credits, the first time it is asked about', async () => {
      const w = world();
      expect(await w.store.getAccount('ann')).toBeUndefined();
      expect(await w.service.summary(ann)).toEqual({ type: 'free', photo: 5, video: 0, photoInfinite: false, videoInfinite: false, canVideo: false, photoAdsLeft: 5, videoAdsLeft: 0, adPhoto: 5, adVideo: 1, hints: 10, bombs: 2, hintsInfinite: false, bombsInfinite: false });
      expect(await w.store.getAccount('ann')).toMatchObject({ type: 'free', photo: 5, video: 0 });
      expect(await w.service.profile(ann)).toMatchObject({ ok: true, id: 'ann', account: { type: 'free', photo: 5 } });
    });

    it('is nothing for a guest, who sees zeros and has no record', async () => {
      const w = world();
      const guest = { id: 'gx1', name: 'G', guest: true as const };
      expect(await w.service.summary(guest)).toEqual(GUEST_ACCOUNT);
      expect(await w.store.getAccount('gx1')).toBeUndefined();
      expect(await w.service.createRoom(guest, request())).toEqual({ ok: false, error: 'account-required' });
    });

    it('is shown as each type says: infinite photo credits for paid, family and admin, infinite video credits for family and admin, video only for those but free', async () => {
      const w = world();
      const of = async (t: 'free' | 'paid' | 'family' | 'admin') => {
        await type(w, 'ann', t, { video: 7 });
        const s = await w.service.summary(ann);
        return [s.type, s.photoInfinite, s.videoInfinite, s.canVideo, s.video];
      };
      expect(await of('free')).toEqual(['free', false, false, false, 7]);
      expect(await of('paid')).toEqual(['paid', true, false, true, 7]);
      expect(await of('family')).toEqual(['family', true, true, true, 7]);
      expect(await of('admin')).toEqual(['admin', true, true, true, 7]);
    });

    it('is an admin whatever its record says when the token is in the administrators’ group', async () => {
      const w = world();
      expect((await w.service.summary({ ...ann, admin: true })).type).toBe('admin');
      expect((await w.service.summary(ann)).type).toBe('free');
    });

    it('is forgotten when the account is deleted', async () => {
      const w = world();
      await w.service.summary(ann);
      await w.service.deleteAccount(ann);
      expect(await w.store.getAccount('ann')).toBeUndefined();
    });
  });

  describe('a free account', () => {
    it('pays one photo credit for each puzzle, and is turned away with none left (and told where it stands)', async () => {
      const w = world({ activeRoomsPerPlayer: 99 });
      for (let left = 4; left >= 0; left--) {
        const made = await w.service.createRoom(ann, request());
        if (!made.ok) throw new Error(made.error);
        expect(made.account).toMatchObject({ type: 'free', photo: left });
      }
      const none = await w.service.createRoom(ann, request());
      expect(none).toMatchObject({ ok: false, error: 'no-credits', credits: 'photo', account: { photo: 0 } });
      expect(await w.store.getAccount('ann')).toMatchObject({ photo: 0 });
      expect((await w.service.createRoom(bob, request())).ok).toBe(true);                                   // everyone has their own
    });

    it('is not charged for a puzzle that is not made (a limit, or the paused switch)', async () => {
      const w = world({ activeRoomsPerPlayer: 1 });
      expect((await w.service.createRoom(ann, request())).ok).toBe(true);
      expect(await w.service.createRoom(ann, request())).toMatchObject({ ok: false, error: 'limit' });
      expect((await w.service.summary(ann)).photo).toBe(4);
      const paused = world({ hostingPaused: 1 });
      await paused.service.createRoom(ann, request());
      expect(await paused.store.getAccount('ann')).toBeUndefined();
    });

    it('pays once when two puzzles are started at the same moment with one credit left', async () => {
      const w = world({ activeRoomsPerPlayer: 99 });
      await type(w, 'ann', 'free', { photo: 1 });
      const both = await Promise.all([w.service.createRoom(ann, request()), w.service.createRoom(ann, request())]);
      expect(both.filter((r) => r.ok)).toHaveLength(1);
      expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, error: 'no-credits' });
      expect((await w.service.summary(ann)).photo).toBe(0);
      expect((await w.store.roomsOf('ann')).length).toBe(1);
    });

    it('cannot start a video puzzle, and keeps its video credits to use if it becomes a paid account', async () => {
      const w = world();
      await type(w, 'ann', 'free', { video: 3 });
      expect(await w.service.createRoom(ann, videoRequest())).toEqual({ ok: false, error: 'plan-required' });
      expect(await w.service.summary(ann)).toMatchObject({ photo: 5, video: 3, canVideo: false });
      await type(w, 'ann', 'paid');
      expect((await w.service.createRoom(ann, videoRequest())).ok).toBe(true);
      expect((await w.service.summary(ann)).video).toBe(2);
    });
  });

  describe('a paid account', () => {
    it('starts as many picture puzzles as it likes and pays a video credit for each video', async () => {
      const w = world({ activeRoomsPerPlayer: 99 });
      await type(w, 'ann', 'paid', { photo: 0, video: 2 });
      for (let i = 0; i < 8; i++) expect((await w.service.createRoom(ann, request())).ok, `picture ${i}`).toBe(true);
      expect((await w.service.summary(ann)).photo).toBe(0);                                                 // none were taken
      expect(await w.service.createRoom(ann, videoRequest())).toMatchObject({ ok: true, account: { video: 1 } });
      expect(await w.service.createRoom(ann, videoRequest())).toMatchObject({ ok: true, account: { video: 0 } });
      expect(await w.service.createRoom(ann, videoRequest())).toMatchObject({ ok: false, error: 'no-credits', credits: 'video' });
    });

    it('is given 20 video credits for each payment period, and what is not used rolls over', async () => {
      const w = world();
      await type(w, 'ann', 'paid', { video: 3 });
      await w.service.grantPaidPeriod('ann');
      expect((await w.service.summary(ann)).video).toBe(23);
      await w.service.grantPaidPeriod('ann');
      expect((await w.service.summary(ann)).video).toBe(43);
    });

    it('keeps its video credits when it is made a free account, and cannot start a video', async () => {
      const w = world();
      await type(w, 'ann', 'paid', { video: 12 });
      await type(w, 'ann', 'free');
      expect(await w.service.summary(ann)).toMatchObject({ type: 'free', video: 12, canVideo: false, videoInfinite: false });
      expect(await w.service.createRoom(ann, videoRequest())).toEqual({ ok: false, error: 'plan-required' });
    });
  });

  describe('the family and the operator', () => {
    it('start anything without credits, and what they send is not looked at (and is marked in what is kept)', async () => {
      const looked: string[] = [];
      const moderation: Moderation = { check: vi.fn(async () => (looked.push('looked'), { ok: true as const })) };
      const w = world({ activeRoomsPerPlayer: 99 }, undefined, undefined, moderation);
      await type(w, 'ann', 'family', { photo: 0, video: 0 });
      const made = await w.service.createRoom(ann, request());
      if (!made.ok) throw new Error(made.error);
      expect(await w.service.finishUpload(made.roomId, jpeg(400, 300))).toEqual({ ok: true });
      expect(looked).toEqual([]);
      expect((await w.store.getRoom(made.roomId))?.unchecked).toBe(true);
      expect(await w.store.allFiles()).toMatchObject([{ ownerId: 'ann', type: 'image', unchecked: true }]);
      expect(await w.service.createRoom(ann, videoRequest())).toMatchObject({ ok: true, account: { photo: 0, video: 0, videoInfinite: true } });
      // an account that is not theirs is looked at as before
      const mine = await w.service.createRoom(bob, request());
      if (!mine.ok) throw new Error(mine.error);
      await w.service.finishUpload(mine.roomId, jpeg(400, 300));
      expect(looked).toEqual(['looked']);
    });

    it('may send a video of any size only as an admin', async () => {
      const w = world();
      await type(w, 'ann', 'family');
      expect(await w.service.createRoom(ann, videoRequest({ video: { type: 'video/mp4', bytes: 2_000_000, ms: 12_000 } }))).toEqual({ ok: false, error: 'too-big' });
      await type(w, 'ann', 'admin');
      expect((await w.service.createRoom(ann, videoRequest({ video: { type: 'video/mp4', bytes: 2_000_000, ms: 12_000 } }))).ok).toBe(true);
    });

    it('do not hand a file that was not looked at to an account whose own files are looked at', async () => {
      const w = world();
      await type(w, 'ann', 'family');
      const made = await open(w, ann);
      const fileId = (await w.store.getRoom(made.roomId))!.fileId!;
      await joined(w, made, bob);                                                                           // bob is in the puzzle, so the file would be his to use...
      expect(await w.service.createRoom(bob, request({}, { fileId }))).toEqual({ ok: false, error: 'unauthorized' });     // ...but it was not looked at
      await type(w, 'cy', 'family');
      await joined(w, made, cy);
      expect((await w.service.createRoom(cy, request({}, { fileId }))).ok).toBe(true);                       // another account of the family may
      expect((await w.service.createRoom(ann, request({}, { fileId }))).ok).toBe(true);
    });
  });

  describe('watching an ad for credits', () => {
    const ad = (kind: 'photo' | 'video' = 'photo', extra: { platform?: 'android' | 'ios' | 'web' } = {}) => ({ kind, platform: 'android' as const, ...extra }) as Parameters<World['service']['claimAd']>[1];
    const none = async (w: World, id = 'ann', kinds: { photo?: number; video?: number } = { photo: 0 }) => w.service.adminSetAccount(id, kinds);

    it('is refused for a guest, and (when a game asks for them itself) by a server that does not take its word', async () => {
      const w = world();
      expect(await w.service.claimAd({ id: 'gx1', name: 'G', guest: true }, ad())).toEqual({ ok: false, error: 'account-required' });
      await none(w);
      expect(await w.service.claimAd(ann, ad())).toEqual({ ok: false, error: 'ads-off' });
      expect((await w.service.summary(ann)).photo).toBe(0);
    });

    it('gives a free account photo credits, and only when it has none left', async () => {
      const w = world({ adsTrusted: 1 });
      expect(await w.service.claimAd(ann, ad())).toMatchObject({ ok: false, error: 'ad-refused', reason: 'has-credits', account: { photo: 5 } });
      await none(w);
      expect(await w.service.claimAd(ann, ad())).toMatchObject({ ok: true, account: { photo: 5, photoAdsLeft: 4 } });
      expect(await w.service.claimAd(ann, ad())).toMatchObject({ ok: false, reason: 'has-credits' });
      expect(await w.store.getAccount('ann')).toMatchObject({ photo: 5, photoAds: 1 });
    });

    it('allows five a day, and starts again the next day', async () => {
      const w = world({ adsTrusted: 1 });
      for (let i = 1; i <= 5; i++) {
        await none(w);
        expect(await w.service.claimAd(ann, ad()), `ad ${i}`).toMatchObject({ ok: true, account: { photoAdsLeft: 5 - i } });
      }
      await none(w);
      expect(await w.service.claimAd(ann, ad())).toMatchObject({ ok: false, error: 'ad-refused', reason: 'daily-limit', account: { photoAdsLeft: 0 } });
      w.clock.t += DAY;
      expect(await w.service.claimAd(ann, ad())).toMatchObject({ ok: true, account: { photo: 5, photoAdsLeft: 4 } });
    });

    it('is only for the Android and iOS apps', async () => {
      const w = world({ adsTrusted: 1 });
      await none(w);
      for (const platform of ['web', 'steam', 'itch', undefined]) expect(await w.service.claimAd(ann, ad('photo', { platform: platform as never })), String(platform)).toMatchObject({ ok: false, reason: 'platform' });
      expect((await w.service.claimAd(ann, ad('photo', { platform: 'ios' }))).ok).toBe(true);
      expect(await w.service.claimAd(ann, { kind: 'audio' as never, platform: 'ios' })).toEqual({ ok: false, error: 'bad-request' });
    });

    it('gives a paid account one video credit, when it has none, and nothing for pictures; the others nothing at all', async () => {
      const w = world({ adsTrusted: 1 });
      await type(w, 'ann', 'paid', { video: 2, photo: 0 });
      expect(await w.service.claimAd(ann, ad('video'))).toMatchObject({ ok: false, reason: 'has-credits' });
      await none(w, 'ann', { video: 0 });
      expect(await w.service.claimAd(ann, ad('video'))).toMatchObject({ ok: true, account: { video: 1, videoAdsLeft: 4 } });
      expect(await w.service.claimAd(ann, ad('photo'))).toMatchObject({ ok: false, reason: 'plan' });
      await type(w, 'bob', 'free', { video: 0 });
      expect(await w.service.claimAd(bob, ad('video'))).toMatchObject({ ok: false, reason: 'plan' });          // a free account cannot start a video: nothing to buy
      await type(w, 'cy', 'family', { photo: 0, video: 0 });
      expect(await w.service.claimAd(cy, ad('photo'))).toMatchObject({ ok: false, reason: 'plan' });
    });

    it('is told to the game as the router answers it', async () => {
      const w = world({ adsTrusted: 1 });
      const route = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
      const post = (who: string, body: unknown) => route({ method: 'POST', path: '/credits/ad', query: new URLSearchParams(), authorization: `Bearer dev:${who}:Name`, body: new TextEncoder().encode(JSON.stringify(body)) });
      expect(await post('ann', ad())).toMatchObject({ status: 409, body: { error: 'ad-refused', reason: 'has-credits' } });
      await none(w);
      expect(await post('ann', ad())).toMatchObject({ status: 200, body: { ok: true, account: { photo: 5 } } });
      expect((await route({ method: 'POST', path: '/credits/ad', query: new URLSearchParams(), body: new Uint8Array() })).status).toBe(401);
      const cold = world();
      const r2 = createRouter({ service: cold.service, auth: new DevAuth(), media: cold.media });
      await none(cold);
      expect((await r2({ method: 'POST', path: '/credits/ad', query: new URLSearchParams(), authorization: 'Bearer dev:ann:Name', body: new TextEncoder().encode(JSON.stringify(ad())) })).status).toBe(503);
      const out = await r2({ method: 'POST', path: '/rooms', query: new URLSearchParams(), authorization: 'Bearer dev:bob:Bob', body: new TextEncoder().encode(JSON.stringify(videoRequest())) });
      expect(out.status).toBe(403);
      await none(cold, 'bob');
      const broke = await r2({ method: 'POST', path: '/rooms', query: new URLSearchParams(), authorization: 'Bearer dev:bob:Bob', body: new TextEncoder().encode(JSON.stringify({ ...request(), protocol: PROTOCOL_VERSION })) });
      expect(broke.status).toBe(402);
    });
  });

  describe('the operator changes accounts', () => {
    it('sets the type and the credits, and refuses what makes no sense', async () => {
      const w = world();
      expect(await w.service.adminSetAccount('ann', { type: 'paid', photo: 9, video: 4 })).toEqual({ ok: true, account: { type: 'paid', photo: 9, video: 4, hints: 10, bombs: 2 } });
      expect(await w.service.adminSetAccount('ann', { video: 0 })).toEqual({ ok: true, account: { type: 'paid', photo: 9, video: 0, hints: 10, bombs: 2 } });
      for (const bad of [{ type: 'gold' }, { type: 5 }, { photo: -1 }, { photo: 1.5 }, { video: 1_000_001 }, { video: '3' }, { photo: Number.NaN }]) {
        expect(await w.service.adminSetAccount('ann', bad as never), JSON.stringify(bad)).toEqual({ ok: false, error: 'bad-request' });
      }
      expect(await w.service.adminAccounts(['ann', 'nobody'])).toEqual(
        new Map([
          ['ann', { type: 'paid', photo: 9, video: 0, hints: 10, bombs: 2 }],
          ['nobody', { type: 'free', photo: 5, video: 0, hints: 10, bombs: 2 }],                                                // an account nobody has asked about yet: what it will start with
        ]),
      );
      expect(await w.store.getAccount('nobody')).toBeUndefined();
    });

    it('makes an account an administrator, for the page, by its record', async () => {
      const w = world();
      expect(await w.service.isAdminAccount('ann')).toBe(false);
      await type(w, 'ann', 'admin');
      expect(await w.service.isAdminAccount('ann')).toBe(true);
      await type(w, 'ann', 'family');
      expect(await w.service.isAdminAccount('ann')).toBe(false);
    });
  });
});
