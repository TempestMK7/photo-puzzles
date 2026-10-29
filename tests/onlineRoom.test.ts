import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JigsawGame } from '../src/core/jigsaw';
import { JigsawRoom, LOCK_MS, type Command, type RoomEvent, type RoomState } from '../src/core/jigsawRoom';
import { applyOp, type JigsawOp } from '../src/core/jigsawSetup';
import type { RoomApi } from '../src/online/api';
import { PROTOCOL_VERSION, topics, type HandMessage, type RoomDescriptor } from '../src/online/protocol';
import type { Connection, Realtime, RealtimeHandlers } from '../src/online/realtime';
import { OnlineRoom, type RoomView } from '../src/online/room';
import type { Player } from '../server/src/types';
import { ann, bob, joined, open, world, type World } from './helpers/world';

/** The live side with no network: what the service publishes goes straight to whoever is connected, and a hand goes to the others. */
class Net {
  private conns = new Set<{ room: string; player: string; handlers: RealtimeHandlers; up: boolean }>();
  /** Messages for which this returns true are lost on the way to the player. */
  lose: (player: string, topic: string, message: unknown) => boolean = () => false;

  constructor(w: World) {
    w.pubsub.listen((topic, message) => {
      const room = topic.split('/')[1];
      for (const c of this.conns) if (c.room === room && c.up && !this.lose(c.player, topic, message)) c.handlers.onMessage(topic, message);
    });
  }

  realtime(player: string): Realtime {
    return {
      connect: (room, handlers): Connection => {
        const c = { room, player, handlers, up: true };
        this.conns.add(c);
        queueMicrotask(() => handlers.onOpen());
        return {
          publishHand: (m) => {
            for (const o of this.conns) if (o !== c && o.room === room && o.up) o.handlers.onMessage(topics.hand(room, player), m);
          },
          close: () => this.conns.delete(c),
        };
      },
    };
  }

  cut(player: string): void {
    for (const c of this.conns) if (c.player === player && c.up) (c.up = false), c.handlers.onClose();
  }

  heal(player: string): void {
    for (const c of this.conns) if (c.player === player && !c.up) (c.up = true), c.handlers.onOpen();
  }
}

function apiFor(w: World, p: Player): RoomApi {
  return {
    getRoom: (id) => w.service.getRoom(p, id),
    command: (id, command) => w.service.command(p, id, { protocol: PROTOCOL_VERSION, command }),
    renew: (id) => w.service.renew(p, id),
  };
}

/** The puzzle on one player's screen, reduced to its board. */
class View implements RoomView {
  game: JigsawGame;
  hands: ({ by: string; piece: number } | { by: string; piece: null })[] = [];
  resyncs = 0;
  constructor(d: RoomDescriptor) {
    this.game = new JigsawRoom(d.settings, d.state).board.game;
  }
  applyEvent(e: RoomEvent): void {
    if (e.op) applyOp(this.game, e.op);
  }
  resync(state: RoomState): void {
    this.resyncs++;
    this.game.restore(state.game);
  }
  hand(by: string, pose: HandMessage | null): void {
    this.hands.push({ by, piece: pose ? pose.piece : null });
  }
  groupCount(): number {
    return this.game.groups.size;
  }
  snap(): string {
    return JSON.stringify(this.game.snapshot());
  }
}

interface Side {
  room: OnlineRoom;
  view: View;
  /** What this player does on their own screen: applied here at once, and sent. */
  do(op: JigsawOp): void;
}

async function sides(w: World, net: Net) {
  const made = await open(w, ann);
  const dBob = await joined(w, made, bob);
  const dAnn = (await w.service.getRoom(ann, made.roomId)) as { ok: true; room: RoomDescriptor };
  const make = (p: Player, d: RoomDescriptor): Side => {
    const view = new View(d);
    const room = new OnlineRoom(apiFor(w, p), net.realtime(p.id), d, p.id);
    room.attach(view);
    return { room, view, do: (op) => (applyOp(view.game, op), room.send(op as Command)) };
  };
  const a = make(ann, dAnn.room);
  const b = make(bob, dBob);
  // the connections open and each screen takes the room's board once (the service signs with the real crypto, so this takes as long as it takes)
  await vi.waitFor(() => expect([a.view.resyncs, b.view.resyncs]).toEqual([1, 1]));
  return { a, b, made, loose: [...a.view.game.groups.values()].filter((g) => !g.anchored) };
}

/** A pose that puts group `a` right against a neighbour that is not in the group. */
function against(game: JigsawGame, gid: number): { dx: number; dy: number; rot: number } {
  const a = game.groups.get(gid)!;
  for (const m of a.members) {
    const c = m % game.cols;
    const r = Math.floor(m / game.cols);
    for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]]) {
      if (nc < 0 || nr < 0 || nc >= game.cols || nr >= game.rows) continue;
      const o = game.groups.get(game.groupOf[nr * game.cols + nc])!;
      if (o.id !== a.id) return { dx: o.dx, dy: o.dy, rot: o.rot };
    }
  }
  throw new Error('no neighbour');
}

describe('OnlineRoom', () => {
  let w: World;
  let net: Net;
  beforeEach(() => {
    vi.useFakeTimers();
    w = world();
    net = new Net(w);
  });
  afterEach(() => vi.useRealTimers());

  it('lets two players move pieces and keeps both boards the same as the server\'s', async () => {
    const { a, b, made, loose } = await sides(w, net);
    expect(a.room.status).toBe('online');
    const p = loose[0].members[0];
    const groups = a.view.groupCount();
    a.do({ t: 'grab', piece: p });
    await a.room.whenSent();
    expect(b.room.holderOther()?.name).toBe('Ann');
    a.room.hand({ piece: p, dx: 40, dy: 50, rot: 0 });
    expect(b.view.hands).toEqual([{ by: 'ann', piece: p }]);
    const pose = against(a.view.game, a.view.game.groupOf[p]);
    a.do({ t: 'drop', piece: p, ...pose, tol: 12 });
    await a.room.whenSent();
    expect(b.view.hands.at(-1)).toEqual({ by: 'ann', piece: null });        // the hand is let go
    expect(b.view.snap()).toBe(a.view.snap());
    const server = (await w.service.getRoom(bob, made.roomId)) as { ok: true; room: RoomDescriptor };
    expect(JSON.stringify(server.room.state.game)).toBe(a.view.snap());
    expect(a.view.groupCount()).toBeLessThan(groups);                        // it joined something, on both screens
    expect(b.room.holderOther()).toBeNull();
    expect(a.view.resyncs + b.view.resyncs).toBe(2);                         // the first one each, when they connected: nothing was missed since
  });

  it('keeps others from picking up while one holds a piece, and puts the board right for the one who tried', async () => {
    const { a, b, loose } = await sides(w, net);
    a.do({ t: 'grab', piece: loose[0].members[0] });
    await a.room.whenSent();
    const refused: unknown[] = [];
    b.room.onRefused = (error, holder) => refused.push([error, holder]);
    b.do({ t: 'grab', piece: loose[1].members[0] });                        // (the screen would not let them, but the server is the one who decides)
    await b.room.whenSent();
    expect(refused).toEqual([['busy', 'ann']]);
    await vi.waitFor(() => expect(b.view.resyncs).toBe(2));
    expect(b.view.snap()).toBe(a.view.snap());
  });

  it('lets a hold run out: the piece goes back where the board has it, and the next player may take it', async () => {
    const { a, b, loose } = await sides(w, net);
    const p = loose[0].members[0];
    a.do({ t: 'grab', piece: p });
    await a.room.whenSent();
    a.room.hand({ piece: p, dx: 1, dy: 2, rot: 0 });
    expect(b.room.holderOther()).not.toBeNull();
    vi.setSystemTime(Date.now() + LOCK_MS + 1);
    await vi.advanceTimersByTimeAsync(LOCK_MS + 100);
    expect(b.room.holderOther()).toBeNull();
    expect(b.view.hands.at(-1)).toEqual({ by: 'ann', piece: null });
  });

  it('asks for the whole board when it missed an event', async () => {
    const { a, b, loose } = await sides(w, net);
    net.lose = (player, _t, m) => player === 'bob' && (m as { t: string; v?: number }).t === 'event' && (m as { v: number }).v === 1;      // bob does not hear the first
    a.do({ t: 'grab', piece: loose[0].members[0] });
    await a.room.whenSent();
    a.do({ t: 'drop', piece: loose[0].members[0], dx: 10, dy: 20, rot: 0, tol: null });
    await a.room.whenSent();
    await vi.waitFor(() => expect(b.view.resyncs).toBe(2));
    expect(b.view.snap()).toBe(a.view.snap());
  });

  it('carries on after the connection was lost: it comes back, and catches up on what it missed', async () => {
    const { a, b, loose } = await sides(w, net);
    net.cut('bob');
    expect(b.room.status).toBe('reconnecting');
    for (const [i, l] of loose.slice(0, 3).entries()) {
      a.do({ t: 'grab', piece: l.members[0] });
      a.do({ t: 'drop', piece: l.members[0], dx: 5 * i, dy: 7 * i, rot: 0, tol: null });
    }
    await a.room.whenSent();
    expect(b.view.snap()).not.toBe(a.view.snap());
    net.heal('bob');
    await vi.waitFor(() => expect(b.view.snap()).toBe(a.view.snap()));
    expect(b.room.status).toBe('online');
  });

  it('reads the players coming and going, and a knock, as they are told', async () => {
    const { a } = await sides(w, net);
    expect([...a.room.online].sort()).toEqual([]);
    const cyJoin = { id: 'cy', name: 'Cy' };
    await w.service.join(cyJoin, { protocol: PROTOCOL_VERSION, code: (await w.store.getRoom(a.room.id))!.code });
    expect(a.room.knocks).toEqual([{ id: 'cy', name: 'Cy' }]);
    await w.pubsub.publish(topics.events(a.room.id), { t: 'presence', id: 'bob', online: true });
    expect([...a.room.online]).toEqual(['bob']);
    await w.service.answerKnock(ann, a.room.id, 'cy', true);
    await w.service.join(cyJoin, { protocol: PROTOCOL_VERSION, code: (await w.store.getRoom(a.room.id))!.code });
    expect(a.room.members.map((m) => m.id)).toEqual(['ann', 'bob', 'cy']);
    expect(a.room.knocks).toEqual([]);
    await w.service.leave(bob, a.room.id);
    expect(a.room.members.map((m) => m.id)).toEqual(['ann', 'cy']);
  });

  it('knows when the room has ended, and when the puzzle is solved', async () => {
    const { a, b } = await sides(w, net);
    expect(a.room.solved).toBe(false);
    await w.pubsub.publish(topics.events(a.room.id), { t: 'solved', at: 1 });
    expect(a.room.solved).toBe(true);
    await w.service.close(ann, a.room.id);
    expect([a.room.status, b.room.status, b.room.closedReason]).toEqual(['closed', 'closed', 'owner']);
  });

  it('drops a player who was sent out from the others, and takes the one who was sent out back to the main screen', async () => {
    const { a, b } = await sides(w, net);
    await w.service.removeMember(ann, a.room.id, 'bob');
    expect(a.room.members.map((m) => m.id)).toEqual(['ann']);
    expect([a.room.status, a.room.closedReason]).not.toEqual(['closed', 'removed']);        // the owner's game goes on
    expect([b.room.status, b.room.closedReason]).toEqual(['closed', 'removed']);
  });

  it('says how long it has had to wait, with its own clock, for a lock that the server stamped', async () => {
    const { a, b, loose } = await sides(w, net);
    a.do({ t: 'grab', piece: loose[0].members[0] });
    await a.room.whenSent();
    expect(b.room.holderOther()?.id).toBe('ann');
    expect(a.room.holderOther()).toBeNull();                              // a player's own hold is not "another's"
    expect(b.room.serverNow).toBeGreaterThan(0);
  });
});
