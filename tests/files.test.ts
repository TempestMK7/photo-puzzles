import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type CreateRoomRequest } from '../src/online/protocol';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, cy, DAY, jpeg, joined, open, request, world as makeWorld, type MakeStore, type World } from './helpers/world';

// A picture that has been sent and checked is kept for a week after it was last used, so that a puzzle can be made from it again without sending it: the same on both stores.
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

const START = 1_000_000;
const MP4 = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return b;
};
const again = (fileId: string, extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest => request({}, { fileId, ...extra });

/** A picture sent by `owner`: the id the server keeps it under. */
async function sent(w: World, owner = ann): Promise<{ fileId: string; roomId: string; made: Awaited<ReturnType<typeof open>> }> {
  const made = await open(w, owner);
  const room = await w.store.getRoom(made.roomId);
  if (!room?.fileId) throw new Error('the picture was not kept');
  return { fileId: room.fileId, roomId: made.roomId, made };
}

describe.each(stores)('kept files on %s', (_name, store) => {
  const world = (extra: Parameters<typeof makeWorld>[0] = {}) => makeWorld(extra, store);

  describe('keeping', () => {
    it('keeps the picture once it has passed, and tells everybody in the puzzle its id', async () => {
      const w = world();
      const { fileId, made } = await sent(w);
      expect(await w.store.getFile(fileId)).toMatchObject({ id: fileId, ownerId: 'ann', type: 'image', mime: 'image/jpeg', width: 400, height: 300, createdAt: START, usedAt: START, expiresAt: START + 7 * DAY });
      expect((await joined(w, made, bob)).media.fileId).toBe(fileId);
      expect((await w.service.getRoom(ann, made.roomId))).toMatchObject({ ok: true, room: { media: { fileId } } });
    });

    it('keeps nothing of a picture that is turned down, or that is not the size that was said', async () => {
      const w = world();
      const made = await w.service.createRoom(ann, request());
      if (!made.ok) throw new Error();
      await w.service.finishUpload(made.roomId, jpeg(401, 300));
      expect(await w.store.allFiles()).toEqual([]);
    });

    it('keeps nothing when the operator has switched keeping off, and puzzles go on as they did', async () => {
      const w = world({ fileKeepMs: 0 });
      const made = await open(w);
      expect(await w.store.allFiles()).toEqual([]);
      expect((await joined(w, made, bob)).media.fileId).toBeUndefined();
    });

    it('gives each puzzle a picture of its own: the puzzle ending takes nothing of the kept file', async () => {
      const w = world();
      const { fileId, roomId } = await sent(w);
      expect(w.media.has(roomId)).toBe(true);
      expect(w.media.has(`file~${fileId}`)).toBe(true);
      expect((await w.service.close(ann, roomId)).ok).toBe(true);
      expect(w.media.has(roomId)).toBe(false);
      expect(w.media.has(`file~${fileId}`)).toBe(true);
      expect(await w.store.getFile(fileId)).toBeDefined();
    });
  });

  describe('making a puzzle from a kept file', () => {
    it('needs no picture and no look: the puzzle can be joined at once, and has a picture of its own', async () => {
      const w = world();
      const { fileId, roomId } = await sent(w);
      await w.service.close(ann, roomId);
      w.clock.t += 1000;
      const again1 = await w.service.createRoom(ann, again(fileId));
      if (!again1.ok) throw new Error(again1.error);
      expect(again1.upload).toBeUndefined();
      expect(w.media.has(again1.roomId)).toBe(true);
      const room = await joined(w, again1, bob);
      expect(room.media).toMatchObject({ type: 'image', fileId, sourceId: 'abc123' });
      expect(room.settings).toMatchObject({ width: 400, height: 300 });
    });

    it('counts as one of the three puzzles a week, like any other', async () => {
      const w = world();
      const { fileId } = await sent(w);
      expect((await w.service.createRoom(ann, again(fileId))).ok).toBe(true);
      expect((await w.service.createRoom(ann, again(fileId))).ok).toBe(true);
      expect(await w.service.createRoom(ann, again(fileId))).toMatchObject({ ok: false, error: 'quota' });
    });

    it('keeps the file another week from the day it is used', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const { fileId } = await sent(w);
      w.clock.t = START + 6 * DAY;
      expect((await w.service.createRoom(ann, again(fileId))).ok).toBe(true);
      expect(await w.store.getFile(fileId)).toMatchObject({ usedAt: START + 6 * DAY, expiresAt: START + 13 * DAY, createdAt: START });
      w.clock.t = START + 12 * DAY;                                                          // (the first week is long over)
      expect((await w.service.createRoom(ann, again(fileId))).ok).toBe(true);
    });

    it('is gone a week after it was last used, and the picture with it', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const { fileId } = await sent(w);
      w.clock.t = START + 7 * DAY - 1;
      expect((await w.service.createRoom(ann, again(fileId))).ok).toBe(true);                // just in time
      w.clock.t = START + 14 * DAY - 1;                                                      // (a week on from the second use)
      expect(await w.service.createRoom(ann, again(fileId))).toEqual({ ok: false, error: 'file-gone' });
      expect(await w.store.getFile(fileId)).toBeUndefined();
      expect(w.media.has(`file~${fileId}`)).toBe(false);
    });

    it('is kept for as long as puzzles keep being made from it (there is no longest)', async () => {
      const w = world({ freeRoomsPerWeek: 99, activeRoomsPerPlayer: 99 });
      const { fileId } = await sent(w);
      for (let day = 5; day <= 100; day += 5) {
        w.clock.t = START + day * DAY;
        expect((await w.service.createRoom(ann, again(fileId))).ok, `day ${day}`).toBe(true);
      }
      expect((await w.store.getFile(fileId))?.expiresAt).toBe(START + 107 * DAY);
      w.clock.t = START + 107 * DAY;
      expect(await w.service.createRoom(ann, again(fileId))).toEqual({ ok: false, error: 'file-gone' });
    });

    it('stays open to a player who joined, for as long as the file is kept (their entry is put forward with it)', async () => {
      const w = world({ freeRoomsPerWeek: 99, activeRoomsPerPlayer: 99 });
      const { fileId, made } = await sent(w);
      await joined(w, made, bob);
      for (let day = 5; day <= 30; day += 5) {
        w.clock.t = START + day * DAY;
        expect((await w.service.createRoom(ann, again(fileId))).ok, `day ${day}`).toBe(true);        // the owner keeps it alive
      }
      expect((await w.service.createRoom(bob, again(fileId))).ok).toBe(true);                      // long after the entry made when he joined would have run out
    });

    it('says the file is gone for an id that was never given, and when the stored picture itself has gone', async () => {
      const w = world();
      expect(await w.service.createRoom(ann, again('nothing'))).toEqual({ ok: false, error: 'file-gone' });
      expect(await w.service.createRoom(ann, again('not an id!'))).toMatchObject({ ok: false, error: 'bad-request' });
      const { fileId } = await sent(w);
      await w.media.deleteFile(fileId);                                                      // (the storage lost it: its own lifecycle, say)
      expect(await w.service.createRoom(ann, again(fileId))).toEqual({ ok: false, error: 'file-gone' });
      expect(await w.store.getFile(fileId)).toBeUndefined();                                // and the record is not left to be found again
      expect((await w.store.roomsOf('ann')).length).toBe(1);                                // no puzzle was made
    });

    it('asks for the picture again when the puzzle is not the size of the file', async () => {
      const w = world();
      const { fileId } = await sent(w);
      const req = again(fileId);
      expect(await w.service.createRoom(ann, { ...req, settings: { ...req.settings, width: 401 } })).toEqual({ ok: false, error: 'file-gone' });
      expect((await w.store.getFile(fileId))?.usedAt).toBe(START);                           // nothing was used
    });

    it('is only for the player who sent it and the players who joined a puzzle made from it', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const { fileId, made } = await sent(w);
      expect(await w.service.createRoom(bob, again(fileId))).toEqual({ ok: false, error: 'unauthorized' });
      expect(await w.store.allRooms().then((r) => r.length)).toBe(1);
      await joined(w, made, bob);                                                            // bob joins: now it is his too
      expect((await w.service.createRoom(bob, again(fileId))).ok).toBe(true);
      expect(await w.service.createRoom(cy, again(fileId))).toEqual({ ok: false, error: 'unauthorized' });
      expect((await w.store.getFile(fileId))?.usedAt).toBe(START);                           // a refusal does not keep the file alive
    });

    it('lets someone who joined a puzzle that was itself made from the file use it too', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const { fileId } = await sent(w);
      const second = await w.service.createRoom(ann, again(fileId));
      if (!second.ok) throw new Error();
      await joined(w, second, cy);
      expect((await w.service.createRoom(cy, again(fileId))).ok).toBe(true);
    });

    it('does not give a player who knocked and was not let in, or who was sent out, a key to the file before they are in', async () => {
      const w = world();
      const { fileId, made } = await sent(w);
      expect(await w.service.join(cy, { protocol: PROTOCOL_VERSION, code: made.invite.code })).toMatchObject({ ok: false, error: 'knock-pending' });
      expect(await w.service.createRoom(cy, again(fileId))).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('does not make a guest a user of the file (a guest cannot make puzzles)', async () => {
      const w = world();
      const { fileId, made } = await sent(w);
      const guest = { id: 'gx1', name: 'Guest', guest: true };
      await w.service.join(guest, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
      expect(await w.store.hasFileUser(fileId, 'gx1')).toBe(false);
      expect(await w.store.hasFileUser(fileId, 'ann')).toBe(false);                           // (the owner needs no entry)
    });

    it('still honours the rules of making a puzzle: a paused service, the old version, too many puzzles', async () => {
      const w = world({ freeRoomsPerWeek: 99, activeRoomsPerPlayer: 1 });
      const { fileId } = await sent(w);
      expect(await w.service.createRoom(ann, again(fileId))).toMatchObject({ ok: false, error: 'limit' });
      expect(await w.service.createRoom(ann, { ...again(fileId), protocol: 0 })).toMatchObject({ ok: false, error: 'update-required' });
      expect(await w.service.createRoom(ann, { ...again(fileId), consent: false as unknown as true })).toMatchObject({ ok: false, error: 'bad-request' });
      expect(await makeWorld({ freeRoomsPerWeek: 0 }, store).service.createRoom(ann, again(fileId))).toMatchObject({ ok: false, error: 'paused' });
      expect(await w.store.getFile(fileId)).toMatchObject({ usedAt: START });
    });

    it('lets a guest not make one', async () => {
      const w = world();
      const { fileId } = await sent(w);
      expect(await w.service.createRoom({ id: 'gx1', name: 'G', guest: true }, again(fileId))).toEqual({ ok: false, error: 'account-required' });
    });
  });

  describe('a video', () => {
    const videoRequest = (extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest => request({}, { video: { type: 'video/mp4', bytes: 5000, ms: 12_000 }, ...extra });
    async function sentVideo(w: World) {
      const res = await w.service.createRoom(ann, videoRequest());
      if (!res.ok) throw new Error(res.error);
      await w.media.put(res.roomId, MP4(5000), 'video/mp4');
      expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'ready' });
      const fileId = (await w.store.getRoom(res.roomId))?.fileId;
      if (!fileId) throw new Error('the video was not kept');
      return { res, fileId };
    }

    it('is kept when it has passed, and a puzzle can be made from it again, playing from the start', async () => {
      const w = world({ freeRoomsPerWeek: 99, videoRoomsPerWeek: 99 });
      const { res, fileId } = await sentVideo(w);
      expect(await w.store.getFile(fileId)).toMatchObject({ type: 'video', mime: 'video/mp4', bytes: 5000, video: { type: 'video/mp4', bytes: 5000, ms: 12_000 } });
      await w.service.close(ann, res.roomId);
      const next = await w.service.createRoom(ann, again(fileId));
      if (!next.ok) throw new Error(next.error);
      expect(next.upload).toBeUndefined();
      const room = await joined(w, next, bob);
      expect(room.media).toMatchObject({ type: 'video', fileId, video: { type: 'video/mp4', bytes: 5000, ms: 12_000 } });
      expect(room.playback).toMatchObject({ pos: 0, paused: false });
    });

    it('is kept once, even when the check is asked about again', async () => {
      const w = world();
      const { res } = await sentVideo(w);
      expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'ready' });
      expect((await w.store.allFiles()).length).toBe(1);
    });

    it('is still a video puzzle: switched off, or over the limits, it is not made', async () => {
      const w = world({ freeRoomsPerWeek: 99, videoRoomsPerWeek: 99 });
      const { fileId } = await sentVideo(w);
      (w.service as unknown as { d: { limits: { videoRoomsPerWeek: number; videoMs: number } } }).d.limits.videoRoomsPerWeek = 0;                 // (the operator switches them off)
      expect(await w.service.createRoom(ann, again(fileId))).toEqual({ ok: false, error: 'video-off' });
      (w.service as unknown as { d: { limits: { videoRoomsPerWeek: number; videoMs: number } } }).d.limits.videoRoomsPerWeek = 99;
      (w.service as unknown as { d: { limits: { videoRoomsPerWeek: number; videoMs: number } } }).d.limits.videoMs = 10_000;                           // (or makes them shorter than this one)
      expect(await w.service.createRoom(ann, again(fileId))).toEqual({ ok: false, error: 'too-big' });
      const tight = world({ freeRoomsPerWeek: 99, videoRoomsPerWeek: 1 });
      const second = await sentVideo(tight);
      expect(await tight.service.createRoom(ann, again(second.fileId))).toMatchObject({ ok: false, error: 'quota' });             // the weekly count of videos is its own
    });

    it('is not kept when an administrator made it without the check', async () => {
      const w = world();
      const admin = { ...ann, admin: true as const };
      const res = await w.service.createRoom(admin, videoRequest());
      if (!res.ok) throw new Error();
      await w.media.put(res.roomId, MP4(5000), 'video/mp4');
      expect(await w.service.checkVideo(admin, res.roomId)).toEqual({ ok: true, state: 'ready' });
      expect(await w.store.allFiles()).toEqual([]);
    });
  });

  describe('going', () => {
    it('is cleared away by the sweep when its time is up', async () => {
      const w = world();
      const { fileId } = await sent(w);
      w.clock.t = START + 7 * DAY - 1;
      await w.service.sweep();
      expect(await w.store.getFile(fileId)).toBeDefined();
      w.clock.t = START + 7 * DAY;
      await w.service.sweep();
      expect(await w.store.getFile(fileId)).toBeUndefined();
      expect(w.media.has(`file~${fileId}`)).toBe(false);
      expect(await w.store.hasFileUser(fileId, 'bob')).toBe(false);
    });

    it('goes with the account that sent it, and with a ban (but not with the player who only joined)', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const mine = await sent(w);
      const bobs = await sent(w, bob);
      await joined(w, bobs.made, ann);
      await w.service.deleteAccount(ann);
      expect(await w.store.getFile(mine.fileId)).toBeUndefined();
      expect(w.media.has(`file~${mine.fileId}`)).toBe(false);
      expect(await w.store.getFile(bobs.fileId)).toBeDefined();                             // joining a puzzle of someone else's takes nothing of theirs away
      await w.service.adminBan('bob', 'rude');
      expect(await w.store.getFile(bobs.fileId)).toBeUndefined();
      expect(await w.store.filesOf('bob')).toEqual([]);
    });

    it('is deleted when the operator ends a puzzle for its picture, but not when the owner closes the puzzle', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const { fileId, roomId } = await sent(w);
      await w.service.close(ann, roomId);
      expect(await w.store.getFile(fileId)).toBeDefined();
      const second = await w.service.createRoom(ann, again(fileId));
      if (!second.ok) throw new Error();
      expect(await w.service.adminRemoveRoom(second.roomId)).toBe(true);
      expect(await w.store.getFile(fileId)).toBeUndefined();
      expect(w.media.has(`file~${fileId}`)).toBe(false);
      expect(await w.service.createRoom(ann, again(fileId))).toEqual({ ok: false, error: 'file-gone' });
    });

    it('is deleted by the operator, who also ends the puzzles that were made from it', async () => {
      const w = world({ freeRoomsPerWeek: 99 });
      const { fileId, roomId } = await sent(w);
      const second = await w.service.createRoom(ann, again(fileId));
      const other = await open(w, bob);
      if (!second.ok) throw new Error();
      expect(await w.service.adminRemoveFile(fileId)).toBe(true);
      expect(await w.store.getRoom(roomId)).toBeUndefined();
      expect(await w.store.getRoom(second.roomId)).toBeUndefined();
      expect(w.media.has(second.roomId)).toBe(false);
      expect(await w.store.getFile(fileId)).toBeUndefined();
      expect(await w.store.getRoom(other.roomId)).toBeDefined();                            // a puzzle of someone else's file is not touched
      expect(await w.service.adminRemoveFile(fileId)).toBe(false);
    });
  });

  describe('the operator looks through them', () => {
    it('lists them newest first with the owner, the size and an address, a page at a time', async () => {
      const w = world({ freeRoomsPerWeek: 99, activeRoomsPerPlayer: 99 });
      await w.store.setName('ann', 'Annie');
      const ids: string[] = [];
      for (let i = 0; i < 65; i++) {
        w.clock.t = START + i * 1000;
        ids.push((await sent(w, i % 2 ? bob : ann)).fileId);
      }
      const first = await w.service.adminFiles();
      expect(first.files.length).toBe(60);
      expect(first.files[0]).toMatchObject({ id: ids[64], ownerId: 'ann', ownerName: 'Annie', type: 'image', width: 400, height: 300 });
      expect(first.files[1]).toMatchObject({ id: ids[63], ownerId: 'bob', ownerName: '' });
      expect(first.files[0].url).toMatch(/^http:\/\/media\.test\/media\//);
      expect(first.next).not.toBeNull();
      const second = await w.service.adminFiles(first.next!);
      expect(second.files.map((f) => f.id)).toEqual(ids.slice(0, 5).reverse());
      expect(second.next).toBeNull();
    });

    it('leaves out a file whose time has run out even if the table still has it', async () => {
      const w = world();
      await sent(w);
      w.clock.t = START + 8 * DAY;
      expect((await w.service.adminFiles()).files).toEqual([]);
    });
  });
});
