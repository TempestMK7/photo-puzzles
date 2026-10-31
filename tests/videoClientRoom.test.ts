import { describe, expect, it } from 'vitest';
import type { RoomApi } from '../src/online/api';
import { PlaybackSync, type SyncVideo } from '../src/online/playbackSync';
import { PROTOCOL_VERSION, type RoomDescriptor } from '../src/online/protocol';
import type { Connection, Realtime, RealtimeHandlers } from '../src/online/realtime';
import { OnlineRoom, type RoomView } from '../src/online/room';
import type { Player } from '../server/src/types';
import { ann, bob, joined, paidWorld as world, request, type World } from './helpers/world';

const mp4 = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return b;
};

/** The live side with no network: what the service publishes goes straight to whoever is connected. */
function realtimeOf(w: World): Realtime {
  const conns = new Set<{ room: string; handlers: RealtimeHandlers }>();
  w.pubsub.listen((topic, message) => {
    const room = topic.split('/')[1];
    for (const c of conns) if (c.room === room) c.handlers.onMessage(topic, message);
  });
  return {
    connect: (room, handlers): Connection => {
      const c = { room, handlers };
      conns.add(c);
      queueMicrotask(() => handlers.onOpen());
      return { publishHand: () => undefined, close: () => conns.delete(c) };
    },
  };
}

const apiFor = (w: World, p: Player): RoomApi => ({
  getRoom: (id) => w.service.getRoom(p, id),
  command: (id, command) => w.service.command(p, id, { protocol: PROTOCOL_VERSION, command }),
  renew: (id) => w.service.renew(p, id),
  setPlayback: (id, req) => w.service.setPlayback(p, id, req),
});

const view: RoomView = { applyEvent: () => undefined, resync: () => undefined, hand: () => undefined, groupCount: () => 0 };

async function videoRoom(w: World) {
  const made = await w.service.createRoom(ann, request({}, { video: { type: 'video/mp4', bytes: 5000, ms: 20_000 } }));
  if (!made.ok) throw new Error(made.error);
  await w.media.put(made.roomId, mp4(5000), 'video/mp4');
  const done = await w.service.checkVideo(ann, made.roomId);
  if (!done.ok) throw new Error(done.error);
  return made;
}

class FakeVideo implements SyncVideo {
  currentTime = 0;
  paused = true;
  duration = 20;
  seek(t: number): void {
    this.currentTime = t;
  }
  play(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));
/** Long enough for the look at the room that a game makes as soon as it connects (it signs the picture's address) to be answered. */
const connected = () => new Promise((r) => setTimeout(r, 40));

describe('the room of a video puzzle, on a player\'s side', () => {
  it('knows who the host is, and the host\'s last word from the room it was given', async () => {
    const w = world();
    const made = await videoRoom(w);
    const first = (await w.service.getRoom(ann, made.roomId)) as { ok: true; room: RoomDescriptor };
    const host = new OnlineRoom(apiFor(w, ann), realtimeOf(w), first.room, 'ann');
    expect(host.host).toBe(true);
    const guest = await joined(w, made, bob);
    const other = new OnlineRoom(apiFor(w, bob), realtimeOf(w), guest, 'bob');
    expect(other.host).toBe(false);
    expect(other.playback).toMatchObject({ pos: 0, paused: false });
  });

  it('hears the host and passes it on; the host does not hear their own words back', async () => {
    const w = world();
    const made = await videoRoom(w);
    const net = realtimeOf(w);
    const hostRoom = new OnlineRoom(apiFor(w, ann), net, ((await w.service.getRoom(ann, made.roomId)) as { room: RoomDescriptor }).room, 'ann');
    const guestRoom = new OnlineRoom(apiFor(w, bob), net, await joined(w, made, bob), 'bob');
    hostRoom.attach(view);
    guestRoom.attach(view);
    await settle();
    let heard = 0;
    guestRoom.onPlayback = () => heard++;
    let hostHeard = 0;
    hostRoom.onPlayback = () => hostHeard++;
    w.clock.t += 3000;
    hostRoom.sendPlayback(7.5, true);
    await settle();
    await settle();
    expect(heard).toBeGreaterThanOrEqual(1);        // (and once more if the first look at the room, made when it connected, comes in late)
    expect(hostHeard).toBe(0);
    expect(guestRoom.playback).toEqual({ pos: 7.5, paused: true, at: w.clock.t });
    expect(hostRoom.playback).toMatchObject({ pos: 7.5, paused: true });      // (its own copy: on this game's idea of the server's clock)
  });

  it('is taken to the host\'s place by the sync: a player who paused and went elsewhere gets back with the button', async () => {
    const w = world();
    const made = await videoRoom(w);
    const net = realtimeOf(w);
    const hostRoom = new OnlineRoom(apiFor(w, ann), net, ((await w.service.getRoom(ann, made.roomId)) as { room: RoomDescriptor }).room, 'ann');
    const guestRoom = new OnlineRoom(apiFor(w, bob), net, await joined(w, made, bob), 'bob');
    hostRoom.attach(view);
    guestRoom.attach(view);
    await settle();
    const hostVideo = new FakeVideo();
    const guestVideo = new FakeVideo();
    const hostSync = new PlaybackSync(hostVideo, hostRoom);
    const guestSync = new PlaybackSync(guestVideo, guestRoom);
    guestRoom.onPlayback = () => guestSync.heard();
    hostSync.start();
    guestSync.start();
    await settle();
    expect(guestVideo.paused).toBe(false);
    // the host pauses at 9 s: the guest, who follows, pauses there too
    w.clock.t += 2000;
    hostVideo.currentTime = 9;
    hostVideo.pause();
    hostSync.byPlayer();
    await settle();
    await settle();
    expect(guestVideo.paused).toBe(true);
    expect(guestVideo.currentTime).toBe(9);
    // the guest plays on by themselves, and the host moves: the guest does not follow
    guestVideo.currentTime = 15;
    guestVideo.play();
    guestSync.byPlayer();
    expect(guestSync.apart).toBe(true);
    hostVideo.currentTime = 2;
    hostSync.byPlayer();
    await settle();
    await settle();
    expect(guestVideo.currentTime).toBe(15);
    // and the button takes them there
    await guestSync.resync();
    expect(guestSync.apart).toBe(false);
    expect(guestVideo.currentTime).toBe(2);
    expect(guestVideo.paused).toBe(true);
  });

  it('has a new host when the host leaves', async () => {
    const w = world();
    const made = await videoRoom(w);
    const net = realtimeOf(w);
    const guestRoom = new OnlineRoom(apiFor(w, bob), net, await joined(w, made, bob), 'bob');
    guestRoom.attach(view);
    await connected();
    expect(guestRoom.host).toBe(false);
    await w.service.leave(ann, made.roomId);
    await settle();
    expect(guestRoom.host).toBe(true);
    const sent: unknown[] = [];
    const room2 = new OnlineRoom({ ...apiFor(w, bob), setPlayback: async (_id, req) => (sent.push(req), { ok: true as const }) }, net, await joined(w, made, { id: 'cy', name: 'Cy' }), 'cy');
    expect(room2.host).toBe(false);
    guestRoom.sendPlayback(1, false);
    await settle();
    expect((await w.store.getRoom(made.roomId))!.playback).toMatchObject({ pos: 1, paused: false });
  });

  it('asks the server where the video is, for the button, and keeps what it had when it cannot be reached', async () => {
    const w = world();
    const made = await videoRoom(w);
    const net = realtimeOf(w);
    const guestRoom = new OnlineRoom(apiFor(w, bob), net, await joined(w, made, bob), 'bob');
    w.clock.t += 4000;
    await w.service.setPlayback(ann, made.roomId, { pos: 11, paused: true });
    expect(await guestRoom.refreshPlayback()).toMatchObject({ pos: 11, paused: true });
    const offline = new OnlineRoom({ ...apiFor(w, bob), getRoom: async () => ({ ok: false as const, error: 'offline' as const }) }, net, await joined(w, made, bob), 'bob');
    expect(await offline.refreshPlayback()).toMatchObject({ pos: 11, paused: true });
  });
});
