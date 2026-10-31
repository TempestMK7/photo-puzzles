import { afterEach, describe, expect, it, vi } from 'vitest';
import { JigsawRoom, RESERVE_MS } from '../src/core/jigsawRoom';
import type { RoomApi } from '../src/online/api';
import { PROTOCOL_VERSION, type RoomDescriptor } from '../src/online/protocol';
import type { Connection, Realtime, RealtimeHandlers } from '../src/online/realtime';
import { OnlineRoom, type RoomView } from '../src/online/room';
import type { Player } from '../server/src/types';
import { ann, bob, joined, open, world, type World } from './helpers/world';

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
});

class View implements RoomView {
  redraws = 0;
  applyEvent(): void {}
  resync(): void {}
  hand(): void {}
  groupCount(): number {
    return 0;
  }
  reservations(): void {
    this.redraws++;
  }
}

const loosePiece = (room: RoomDescriptor): number => {
  const g = new JigsawRoom(room.settings, room.state).board.game;
  return [...g.groups.values()].find((x) => !x.anchored)!.members[0];
};

describe('the piece a player has chosen, in the service', () => {
  it('is told to the others in the event, refused to anyone else, and let go when the player leaves', async () => {
    const w = world();
    const made = await open(w);
    const room = await joined(w, made, bob);
    const piece = loosePiece(room);
    const cmd = (p: Player, command: object) => w.service.command(p, made.roomId, { protocol: PROTOCOL_VERSION, command: command as never });
    const sel = await cmd(ann, { t: 'select', piece });
    expect(sel.ok && sel.event.reserved).toEqual([{ holder: 'ann', piece, until: w.clock.t + RESERVE_MS }]);
    expect(w.messages(made.roomId).at(-1)).toMatchObject({ t: 'event', reserved: [{ holder: 'ann', piece }] });
    expect(await cmd(bob, { t: 'grab', piece })).toMatchObject({ ok: false, error: 'busy', holder: 'ann' });
    const got = await w.service.getRoom(bob, made.roomId);
    expect(got.ok && got.room.state.reserved).toHaveLength(1);                                    // and a player who comes in later is told
    await w.service.leave(ann, made.roomId);
    const after = await cmd(bob, { t: 'grab', piece });
    expect(after.ok).toBe(true);
  });

  it('runs out by itself, and every command of the player is as before', async () => {
    const w = world();
    const made = await open(w);
    const room = await joined(w, made, bob);
    const piece = loosePiece(room);
    await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'select', piece } as never });
    w.clock.t += RESERVE_MS + 1;
    const taken = await w.service.command(bob, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'grab', piece } });
    expect(taken.ok && taken.event.reserved.map((r) => r.holder)).toEqual(['bob']);
  });
});

/** Long enough for the look at the room that a game makes as soon as it connects (it signs the picture's address) to be answered. */
const connected = () => new Promise((r) => setTimeout(r, 60));

describe('the piece another player has chosen, on a player\'s screen', () => {
  afterEach(() => vi.useRealTimers());

  it('is known from the events, drawn again when it changes, and no longer when it runs out', async () => {
    const w = world();
    const made = await open(w);
    const room = await joined(w, made, bob);
    const piece = loosePiece(room);
    const net = realtimeOf(w);
    const bobsRoom = new OnlineRoom(apiFor(w, bob), net, room, bob.id);
    const view = new View();
    bobsRoom.attach(view);
    await connected();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });                         // from here on, the time is the test's
    expect(bobsRoom.othersReserved()).toEqual([]);
    const before = view.redraws;
    await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'select', piece } as never });
    await vi.advanceTimersByTimeAsync(5);
    expect(bobsRoom.othersReserved()).toEqual([{ by: 'ann', piece }]);
    expect(view.redraws).toBeGreaterThan(before);
    // not this player's own, and gone once it has run out (the screen is told, with no message from the server)
    const mine = new OnlineRoom(apiFor(w, ann), net, ((await w.service.getRoom(ann, made.roomId)) as { room: RoomDescriptor }).room, ann.id);
    expect(mine.othersReserved()).toEqual([]);
    const redraws = view.redraws;
    await vi.advanceTimersByTimeAsync(RESERVE_MS + 500);
    expect(bobsRoom.othersReserved()).toEqual([]);
    expect(view.redraws).toBeGreaterThan(redraws);
    bobsRoom.detach();
  });

  it('is there from the first look at the room, for a player who comes in after it was chosen', async () => {
    const w = world();
    const made = await open(w);
    const first = await joined(w, made, bob);
    const piece = loosePiece(first);
    await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'select', piece } as never });
    const cy = { id: 'cy', name: 'Cy' };
    const late = await joined(w, made, cy);
    const theirs = new OnlineRoom(apiFor(w, cy), realtimeOf(w), late, cy.id);
    expect(theirs.othersReserved()).toEqual([{ by: 'ann', piece }]);
  });
});
