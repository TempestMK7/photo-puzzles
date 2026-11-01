import { describe, expect, it } from 'vitest';
import { applyBoardOp, boardCheck, BoardRoom, buildBoard, openRoom, type BoardKind, type BoardOp, type RoomSetup } from '../src/core/boardRoom';
import { JigsawRoom, type Command } from '../src/core/jigsawRoom';
import { PROTOCOL_VERSION, type CreateRoomRequest } from '../src/online/protocol';
import { checkSettings } from '../server/src/service';
import { ann, bob, jpeg, joined, limits, open, request, world } from './helpers/world';

/** A small puzzle of each kind, with the options a room carries (what a size sets, as plain numbers). */
const SETUPS: Record<BoardKind, RoomSetup> = {
  focus: { kind: 'focus', seed: 11, width: 400, height: 300, opts: { pieces: 20, irregular: 1 } },
  overlap: { kind: 'overlap', seed: 12, width: 400, height: 300, opts: { total: 50, stacks: 3, turned: 1, windows: 1, placed: 20 } },
  strips: { kind: 'strips', seed: 13, width: 400, height: 300, opts: { cells: 50, length: 4, tabs: 4, placed: 20 } },
};

/** Every operation that puts the puzzle one step nearer to the end, computed from the board as it is now. */
function nextOps(room: BoardRoom): BoardOp[] {
  const b = room.board;
  const ops: BoardOp[] = [];
  if (b.kind === 'focus') {
    const g = b.game;
    for (let i = 0; i < g.count; i++) {
      if (g.placed(i)) continue;
      ops.push({ t: 'swap', a: i, b: g.slotOf.findIndex((s) => s === i) });             // the piece that sits where i belongs trades with i
      break;
    }
  } else if (b.kind === 'overlap') {
    const g = b.game;
    const id = g.done.findIndex((d) => !d);
    if (id >= 0) {
      if (g.rot[id] !== 0) ops.push({ t: 'turn', piece: id });
      else ops.push({ t: 'put', piece: id, x: g.pieces[id].cx, y: g.pieces[id].cy });
    }
  } else {
    const g = b.game;
    const id = g.state.findIndex((s) => !s.locked);
    if (id >= 0) ops.push({ t: 'place', strip: id, x: g.defs[id].hx, y: g.defs[id].hy, angle: 0, tab: 0 });
  }
  return ops;
}

describe.each(Object.keys(SETUPS) as BoardKind[])('a %s room', (kind) => {
  const setup = SETUPS[kind];

  it('is played to the end by three players, and a board that only applies the events is the room\'s board at every step', () => {
    const room = new BoardRoom(setup as RoomSetup & { kind: BoardKind });
    const copy = buildBoard(setup as RoomSetup & { kind: BoardKind });
    const players = ['ann', 'bob', 'cy'];
    let steps = 0;
    while (!room.solved) {
      const ops = nextOps(room);
      expect(ops.length).toBeGreaterThan(0);
      const res = room.submit(players[steps++ % 3], ops[0], steps);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.event.v).toBe(steps);
      expect(applyBoardOp(copy, res.event.op as BoardOp).ok).toBe(true);
      expect(res.event.groups).toBe(boardCheck(copy));
      expect(JSON.stringify(copy.game.snapshot())).toBe(JSON.stringify(room.state().game));
      expect(res.event.solved).toBe(room.solved);
      expect(res.event.lock).toBeNull();
      expect(steps).toBeLessThan(5000);
    }
    expect(room.submit('ann', nextOps(room)[0] ?? { t: 'turn', piece: 0 }, 9999)).toEqual({ ok: false, reason: 'ended' });
  });

  it('carries on from its saved state', () => {
    const a = new BoardRoom(setup as RoomSetup & { kind: BoardKind });
    for (let i = 0; i < 3; i++) a.submit('ann', nextOps(a)[0], i);
    const b = new BoardRoom(setup as RoomSetup & { kind: BoardKind }, JSON.parse(JSON.stringify(a.state())));
    expect(b.state()).toEqual(a.state());
    expect(b.version).toBe(3);
    const op = nextOps(b)[0];
    expect(JSON.stringify(a.submit('bob', op, 10))).toBe(JSON.stringify(b.submit('bob', op, 10)));
  });

  it('turns away a state that is not this puzzle\'s', () => {
    const other = new BoardRoom({ ...setup, seed: setup.seed + 1, opts: { ...setup.opts, pieces: 30, total: 100, cells: 100 } } as RoomSetup & { kind: BoardKind });
    expect(() => new BoardRoom(setup as RoomSetup & { kind: BoardKind }, other.state())).toThrow();
  });

  it('has no hand to hold: nobody holds a piece, the hold cannot be renewed, and a command of a Jigsaw is not one of its own', () => {
    const room = new BoardRoom(setup as RoomSetup & { kind: BoardKind });
    expect(room.holder()).toBeNull();
    expect(room.renew()).toEqual({ ok: false, reason: 'not-holder' });
    for (const cmd of [{ t: 'grab', piece: 0 }, { t: 'release' }, { t: 'select', piece: 0 }, { t: 'nonsense' }, null, 5, {}]) {
      expect(room.submit('ann', cmd, 1)).toEqual({ ok: false, reason: 'bad' });
    }
    expect(room.version).toBe(0);
  });
});

describe('what an operation may be', () => {
  const room = (kind: BoardKind) => new BoardRoom(SETUPS[kind] as RoomSetup & { kind: BoardKind });

  it('is refused as `bad` when it is not one of the puzzle\'s, or its numbers make no sense', () => {
    const focus = room('focus');
    for (const op of [{ t: 'swap', a: -1, b: 1 }, { t: 'swap', a: 0, b: 999 }, { t: 'swap', a: 1.5, b: 2 }, { t: 'swap', a: 3, b: 3 }, { t: 'swap', a: '1', b: 2 }, { t: 'turn', piece: 0 }, { t: 'place', strip: 0, x: 0, y: 0, angle: 0, tab: 0 }]) {
      expect(focus.submit('ann', op, 1)).toEqual({ ok: false, reason: 'bad' });
    }
    const overlap = room('overlap');
    for (const op of [{ t: 'put', piece: 0, x: -1, y: 0 }, { t: 'put', piece: 0, x: 1000, y: 0 }, { t: 'toStack', piece: 0, stack: 9 }, { t: 'cycle', stack: 0, dir: 2 }, { t: 'cycle', stack: -1, dir: 1 }, { t: 'turn', piece: 9999 }, { t: 'swap', a: 1, b: 2 }]) {
      expect(overlap.submit('ann', op, 1)).toEqual({ ok: false, reason: 'bad' });
    }
    const strips = room('strips');
    for (const op of [{ t: 'place', strip: 0, x: 0, y: 0, angle: 4, tab: 0 }, { t: 'place', strip: 0, x: 0, y: 0, angle: 0, tab: 99 }, { t: 'place', strip: 0, x: 0.5, y: 0, angle: 0, tab: 0 }, { t: 'place', strip: 9999, x: 0, y: 0, angle: 0, tab: 0 }, { t: 'swap', a: 1, b: 2 }]) {
      expect(strips.submit('ann', op, 1)).toEqual({ ok: false, reason: 'bad' });
    }
  });

  it('is refused as `no-group` when it was fine but somebody else got there first, and changes nothing', () => {
    const focus = room('focus');
    const g = (focus.board as { game: { placed(i: number): boolean; slotOf: number[]; count: number } }).game;
    const i = g.slotOf.findIndex((s, k) => s !== k);
    const j = g.slotOf.findIndex((s) => s === i);
    expect(focus.submit('ann', { t: 'swap', a: i, b: j }, 1).ok).toBe(true);
    expect(focus.submit('bob', { t: 'swap', a: i, b: (i + 1) % g.count }, 2)).toEqual({ ok: false, reason: 'no-group' });          // i is in its place now
    expect(focus.version).toBe(1);
    const overlap = room('overlap');
    const [first] = nextOps(overlap);
    expect(overlap.submit('ann', first, 1).ok).toBe(true);
    const strips = room('strips');
    const [lock] = nextOps(strips);
    expect(strips.submit('ann', lock, 1).ok).toBe(true);
    expect(strips.submit('bob', lock, 2)).toEqual({ ok: false, reason: 'no-group' });
  });

  it('lets a piece that does not fit go back to its stack (Overlap) and counts nothing else', () => {
    const r = room('overlap');
    const g = (r.board as { game: { stacks: number[][]; pieces: { cx: number; cy: number }[]; misses: number; done: boolean[] } }).game;
    const id = g.stacks[0][g.stacks[0].length - 1];
    const wrong = { t: 'put', piece: id, x: (g.pieces[id].cx + 1) % 5, y: g.pieces[id].cy } as const;
    const res = r.submit('ann', wrong, 1);
    expect(res.ok).toBe(true);
    expect(g.done[id]).toBe(false);
    expect(g.stacks[0].includes(id)).toBe(true);
  });

  it('lets a strip be put down anywhere on any tab, kept inside the field, and locks it where it belongs', () => {
    const r = room('strips');
    const g = (r.board as { game: { state: { x: number; y: number; angle: number; tab: number; locked: boolean }[]; defs: { hx: number; hy: number }[]; cols: number; tabs: number; z: number[] } }).game;
    const id = g.state.findIndex((s) => !s.locked);
    expect(r.submit('ann', { t: 'place', strip: id, x: 500, y: -50, angle: 1, tab: 2 }, 1).ok).toBe(true);
    expect(g.state[id]).toMatchObject({ angle: 1, tab: 2, locked: false });
    expect(g.state[id].x).toBeLessThan(g.cols);
    expect(g.state[id].y).toBe(0);
    expect(g.z[g.z.length - 1]).toBe(id);
    const home = { t: 'place', strip: id, x: g.defs[id].hx, y: g.defs[id].hy, angle: 0, tab: 0 } as const;
    const done = r.submit('bob', home, 2);
    expect(done.ok && g.state[id].locked).toBe(true);
  });
});

describe('the two kinds of room', () => {
  it('opens a Jigsaw\'s or one of the others by the setup, and a Jigsaw\'s room does not take the other puzzles\' operations', () => {
    const jig: RoomSetup = { kind: 'jigsaw', seed: 5, width: 400, height: 300, opts: { pieces: 20 } };
    expect(openRoom(jig)).toBeInstanceOf(JigsawRoom);
    expect(openRoom(SETUPS.focus)).toBeInstanceOf(BoardRoom);
    expect(() => openRoom({ ...jig, kind: 'sliding' as 'jigsaw' })).toThrow();
    const room = openRoom(jig);
    for (const op of [{ t: 'swap', a: 0, b: 1 }, { t: 'put', piece: 0, x: 0, y: 0 }, { t: 'place', strip: 0, x: 0, y: 0, angle: 0, tab: 0 }]) {
      expect(room.submit('ann', op as unknown as Command, 1)).toEqual({ ok: false, reason: 'bad' });
    }
  });
});

describe('the service with the other puzzles', () => {
  const made = (kind: BoardKind, over: Partial<CreateRoomRequest['settings']> = {}): CreateRoomRequest => ({ ...request(), settings: { ...SETUPS[kind], ...over } });

  it.each(Object.keys(SETUPS) as BoardKind[])('makes a %s room, lets a friend in, and plays it to the end with commands from both', async (kind) => {
    const w = world();
    const room = await open(w, ann, made(kind));
    const d = await joined(w, room, bob);
    expect(d.settings.kind).toBe(kind);
    expect(d.state.lock).toBeNull();
    const mirror = new BoardRoom(d.settings as RoomSetup & { kind: BoardKind }, d.state);
    const players = [ann, bob];
    let n = 0;
    while (!mirror.solved) {
      const op = nextOps(mirror)[0];
      const p = players[n++ % 2];
      const res = await w.service.command(p, room.roomId, { protocol: PROTOCOL_VERSION, command: op });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(mirror.submit(p.id, op, 0).ok).toBe(true);
      expect(res.event.groups).toBe(boardCheck(mirror.board));
      expect(n).toBeLessThan(5000);
    }
    const after = await w.service.getRoom(ann, room.roomId);
    expect(after.ok && after.room.status).toBe('solved');
    expect(w.messages(room.roomId).some((m) => m.t === 'solved')).toBe(true);
    const done = await w.service.command(bob, room.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'turn', piece: 0 } });
    expect(done.ok).toBe(false);
  });

  it('refuses a command that is not the puzzle\'s, and says no-group to one that came second', async () => {
    const w = world();
    const room = await open(w, ann, made('focus'));
    await joined(w, room, bob);
    const bad = await w.service.command(ann, room.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'turn', piece: 0 } });
    expect(!bad.ok && bad.error).toBe('bad-request');
    const got = await w.service.getRoom(ann, room.roomId);
    if (!got.ok) throw new Error('no room');
    const mirror = new BoardRoom(got.room.settings as RoomSetup & { kind: BoardKind }, got.room.state);
    const [op] = nextOps(mirror);
    expect((await w.service.command(ann, room.roomId, { protocol: PROTOCOL_VERSION, command: op })).ok).toBe(true);
    const second = await w.service.command(bob, room.roomId, { protocol: PROTOCOL_VERSION, command: op });
    expect(!second.ok && second.error).toBe('no-group');
  });

  it('lists a room with its kind', async () => {
    const w = world();
    await open(w, ann, made('overlap'));
    const list = await w.service.listRooms(ann);
    expect(list.rooms.map((r) => r.settings.kind)).toEqual(['overlap']);
  });

  it('makes a puzzle only of a size the server will keep, with options it knows', () => {
    const ok = (kind: BoardKind, opts: Record<string, number>, w = 400, h = 300) => checkSettings({ kind, seed: 1, width: w, height: h, opts }, limits);
    expect(ok('focus', { pieces: 100, irregular: 0 })).toMatchObject({ kind: 'focus', opts: { pieces: 100, irregular: 0 } });
    expect(ok('overlap', { total: 200, stacks: 5, turned: 0 })).toMatchObject({ kind: 'overlap', opts: { total: 200, stacks: 5, turned: 0, windows: 1, placed: 20 } });
    expect(ok('strips', { cells: 100, length: 6, tabs: 6 })).toMatchObject({ kind: 'strips', opts: { cells: 100, length: 6, tabs: 6, placed: 20 } });
    for (const bad of [{}, { pieces: 3 }, { pieces: 1.5 }, { pieces: '100' as unknown as number }, { pieces: 100000 }] as Record<string, number>[]) expect(ok('focus', bad)).toMatchObject({ ok: false });
    expect(ok('focus', { pieces: 100000 })).toMatchObject({ error: 'bad-request' });
    expect(ok('focus', { pieces: 2000 })).toMatchObject({ error: 'limit' });
    expect(ok('overlap', { total: 2000, stacks: 7 })).toMatchObject({ error: 'limit' });
    expect(ok('overlap', { total: 100, stacks: 50 })).toMatchObject({ error: 'bad-request' });
    expect(ok('strips', { cells: 100, length: 6, tabs: 99 })).toMatchObject({ error: 'bad-request' });
    expect(checkSettings({ kind: 'sliding' as 'jigsaw', seed: 1, width: 400, height: 300, opts: { pieces: 50 } }, limits)).toMatchObject({ error: 'bad-request' });
  });

  it('keeps the picture the size it was made for, for any kind', async () => {
    const w = world();
    const room = await w.service.createRoom(ann, made('strips'));
    if (!room.ok) throw new Error('no room');
    expect((await w.service.finishUpload(room.roomId, jpeg(300, 300))).ok).toBe(false);
  });
});
