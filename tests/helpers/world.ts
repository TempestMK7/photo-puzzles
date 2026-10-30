import { Rng } from '../../src/core/rng';
import { PROTOCOL_VERSION, topics, type CreateRoomRequest, type RoomDescriptor, type RoomMessage } from '../../src/online/protocol';
import { MemoryMedia, MemoryPubSub, MemoryStore } from '../../server/src/memory';
import { RoomService } from '../../server/src/service';
import type { Accounts, Clock, Limits, Moderation, Player, Presence, Random, Store } from '../../server/src/types';

/** A room service on memory with a clock the test moves, and the helpers to open rooms on it: shared by the tests of the server and of the game's side of a room. */
export const DAY = 24 * 3600 * 1000;
export const limits: Limits = { jigsawPieces: 1000, playersPerRoom: 8, activeRoomsPerPlayer: 5, freeRoomsPerWeek: 3, idleMs: DAY, solvedKeepMs: 3600 * 1000, maxAgeMs: 30 * DAY, pictureBytes: 5_000_000 };

export const jpeg = (w: number, h: number): Uint8Array =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
export const png = (w: number, h: number): Uint8Array => {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};

export const ann: Player = { id: 'ann', name: 'Ann' };
export const bob: Player = { id: 'bob', name: 'Bob' };
export const cy: Player = { id: 'cy', name: 'Cy' };

class SeededRandom implements Random {
  private r = new Rng(1234);
  bytes(n: number): Uint8Array {
    return new Uint8Array(n).map(() => this.r.below(256));
  }
  below(n: number): number {
    return this.r.below(n);
  }
}

/** The store a world is built on: memory unless a test says otherwise (the clock is the one the world's tests move). */
export type MakeStore = (clock: Clock) => Store;

export function world(extra: Partial<Limits> = {}, makeStore: MakeStore = () => new MemoryStore(), accounts?: Accounts, notify?: (text: string) => Promise<void>, moderation?: Moderation) {
  const clock = { t: 1_000_000, now() { return this.t; } };
  const store = makeStore(clock);
  const pubsub = new MemoryPubSub();
  const media = new MemoryMedia('http://media.test', new Uint8Array(32).fill(7), clock);
  const online = new Set<string>();
  const presence: Presence = { online: () => [...online] };
  const service = new RoomService({ store, media, pubsub, presence, clock, random: new SeededRandom(), limits: { ...limits, ...extra }, webBase: 'https://play.test', accounts, notify, moderation });
  const messages = (room: string): RoomMessage[] => pubsub.published.filter((p) => p.topic === topics.events(room)).map((p) => p.message as RoomMessage);
  return { clock, store, pubsub, media, service, messages, online };
}

export const request = (o: Partial<CreateRoomRequest['settings']['opts']> = {}, extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest => ({
  protocol: PROTOCOL_VERSION,
  consent: true,
  sourceId: 'abc123',
  settings: { kind: 'jigsaw', seed: 77, width: 400, height: 300, opts: { pieces: 100, ...o } },
  ...extra,
});

export type World = ReturnType<typeof world>;

export async function open(w: World, owner = ann, req = request()) {
  const made = await w.service.createRoom(owner, req);
  if (!made.ok) throw new Error(`create failed: ${made.error}`);
  const up = await w.service.finishUpload(made.roomId, jpeg(req.settings.width, req.settings.height));
  if (!up.ok) throw new Error(`upload failed: ${up.error}`);
  return made;
}

export async function joined(w: World, made: Awaited<ReturnType<typeof open>>, p: Player): Promise<RoomDescriptor> {
  const r = await w.service.join(p, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
  if (!r.ok) throw new Error(`join failed: ${r.error}`);
  return r.room;
}

