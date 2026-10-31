import { describe, expect, it } from 'vitest';
import { TRAY_MAX, type JigsawGame } from '../src/core/jigsaw';
import { JigsawRoom } from '../src/core/jigsawRoom';
import { applyOp, buildJigsaw, type JigsawSetup } from '../src/core/jigsawSetup';
import { centreAt, clampInTray, insideBox, TRAY_ASPECT, trayCells, traySize, trayView } from '../src/core/trays';

const setup = (opts: Record<string, number> = {}): JigsawSetup => ({ seed: 99, width: 400, height: 300, opts: { pieces: 12, ...opts } });
const looseOf = (game: JigsawGame) => [...game.groups.values()].filter((g) => !g.anchored);

describe('sorting trays: what a puzzle keeps', () => {
  it('starts with one tray, and a snapshot of a puzzle that has only that looks as it always did', () => {
    const { game } = buildJigsaw(setup());
    expect(game.trays).toEqual([0]);
    const snap = game.snapshot();
    expect(snap.trays).toBeUndefined();
    expect(snap.nextTray).toBeUndefined();
    expect(snap.groups.every((g) => g.tray === undefined)).toBe(true);
  });

  it('adds trays up to a limit, with the ids going on counting, and takes away only an empty one', () => {
    const { game } = buildJigsaw(setup());
    const ids = [];
    for (let i = 1; i < TRAY_MAX; i++) ids.push(game.addTray());
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(game.trays).toHaveLength(TRAY_MAX);
    expect(game.addTray()).toBe(-1);
    const g = looseOf(game)[0];
    game.place(g.id, 3, 10, 10, 0);
    expect(game.removeTray(3)).toBe(false);                          // something lies in it
    expect(game.removeTray(99)).toBe(false);
    expect(game.removeTray(4)).toBe(true);
    expect(game.addTray()).toBe(10);                                 // (ids are not used again)
    expect(game.trays).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9, 10]);
    expect(game.piecesIn(3)).toBe(g.members.length);
    expect(game.piecesIn(0)).toBe(0);
  });

  it('keeps a group where it was put in a tray, away from the table, and brings it back', () => {
    const { game } = buildJigsaw(setup());
    const [a, b] = looseOf(game);
    const start = { dx: a.dx, dy: a.dy };
    game.place(a.id, 0, 30, 40, 2);
    expect([a.tray, a.dx, a.dy, a.rot]).toEqual([0, 30, 40, 2]);
    expect(game.z[game.z.length - 1]).toBe(a.id);                    // in front
    // what lies in a tray is not on the table, and the other way round
    const cell = game.size;
    const [sx, sy] = [a.dx + 0, a.dy + 0];
    expect(game.groupAt(-sx, -sy)).not.toBe(a.id);
    const m = a.members[0];
    const [rx, ry] = [((m % game.cols) + 0.5) * game.size, (Math.floor(m / game.cols) + 0.5) * game.size];
    const [tx, ty] = [-ry, -rx];                                      // (a turn of two: the point is at the negative)
    void tx; void ty; void cell; void start;
    expect(game.groupAtTray(0, 30 - rx, 40 - ry)).toBe(a.id);
    expect(game.groupAtTray(1, 30 - rx, 40 - ry)).toBe(-1);
    expect(game.groupAtTray(-1, 30 - rx, 40 - ry)).toBe(-1);
    game.place(b.id, -1, 5, 6, 0);                                   // a group put back on the table
    expect(b.tray).toBe(-1);
    game.place(a.id, 7, 1, 1, 0);                                    // no such tray: nothing happens
    expect(a.tray).toBe(0);
  });

  it('joins what lies in the same tray, and nothing in another tray or on the table', () => {
    const { game } = buildJigsaw(setup());
    const loose = looseOf(game);
    const a = loose[0];
    const neighbour = loose.find((g) => g.id !== a.id && [...g.members].some((m) => Math.abs((m % game.cols) - (a.members[0] % game.cols)) + Math.abs(Math.floor(m / game.cols) - Math.floor(a.members[0] / game.cols)) === 1))!;
    expect(neighbour).toBeDefined();
    // two neighbours lying exactly where they fit: they join on the table, and in a tray, but not when they lie in different places
    game.addTray();
    game.place(neighbour.id, -1, 100, 100, 0);
    game.place(a.id, 0, 100, 100, 0);
    expect(game.canJoin(a.id, 0.5)).toBe(false);                       // one in the tray, one on the table
    game.place(neighbour.id, 1, 100, 100, 0);
    expect(game.canJoin(a.id, 0.5)).toBe(false);                       // in two trays
    game.place(neighbour.id, 0, 100, 100, 0);
    expect(game.canJoin(a.id, 0.5)).toBe(true);
    const joined = game.connect(a.id, 0.5);
    expect(joined.joins).toBe(1);
    expect(game.groups.get(joined.id)!.tray).toBe(0);                  // and the joined group stays in the tray
    expect(game.piecesIn(0)).toBe(game.groups.get(joined.id)!.members.length);
  });

  it('carries trays and what lies in them through a snapshot, and refuses one that does not make sense', () => {
    const { game } = buildJigsaw(setup());
    const [a, b] = looseOf(game);
    game.addTray();
    game.addTray();
    game.removeTray(1);
    game.place(a.id, 2, 12, 13, 1);
    const snap = JSON.parse(JSON.stringify(game.snapshot()));
    expect(snap.trays).toEqual([0, 2]);
    expect(snap.nextTray).toBe(3);
    const again = buildJigsaw(setup()).game;
    again.restore(snap);
    expect(again.snapshot()).toEqual(game.snapshot());
    expect(again.groups.get(again.groupOf[a.members[0]])!.tray).toBe(2);
    expect(again.groups.get(again.groupOf[b.members[0]])!.tray).toBe(-1);
    expect(again.addTray()).toBe(3);
    const bad = (edit: (s: ReturnType<JigsawGame['snapshot']>) => void) => {
      const s = JSON.parse(JSON.stringify(snap));
      edit(s);
      expect(() => buildJigsaw(setup()).game.restore(s)).toThrow('not this puzzle');
    };
    bad((s) => { s.groups.find((g: { tray?: number }) => g.tray === 2)!.tray = 7; });          // in a tray that is not there
    bad((s) => { s.trays = [0, 0]; });
    bad((s) => { s.trays = [0, -1]; });
    bad((s) => { s.nextTray = 1; });                                                            // an id that would be used twice
    bad((s) => { s.trays = Array.from({ length: TRAY_MAX + 1 }, (_, i) => i); s.nextTray = 99; });
    bad((s) => { s.groups.find((g: { anchored: boolean }) => g.anchored)!.tray = 0; });         // part of the picture, in a tray
  });

  it('restores a snapshot from before there were trays: one tray, nothing in it', () => {
    const { game } = buildJigsaw(setup());
    const old = JSON.parse(JSON.stringify(game.snapshot()));
    delete old.trays;
    delete old.nextTray;
    const again = buildJigsaw(setup()).game;
    again.restore(old);
    expect(again.trays).toEqual([0]);
    expect(again.addTray()).toBe(1);
  });
});

describe('sorting trays: the operations', () => {
  it('put a group in a tray and back on the table, and turn it in the tray', () => {
    const { game, layout } = buildJigsaw(setup({ turning: 1 }));
    const a = looseOf(game)[0];
    const piece = a.members[0];
    expect(applyOp(game, { t: 'drop', piece, dx: 20, dy: 30, rot: 1, tol: layout.size, tray: 0 })).toEqual({ id: a.id, joins: 0 });
    expect([a.tray, a.dx, a.dy, a.rot]).toEqual([0, 20, 30, 1]);
    applyOp(game, { t: 'rotate', piece, tol: layout.size });
    expect(a.rot).toBe(2);
    expect(a.tray).toBe(0);
    applyOp(game, { t: 'drop', piece, dx: 500, dy: 600, rot: 0, tol: null });
    expect([a.tray, a.dx, a.dy]).toEqual([-1, 500, 600]);
    applyOp(game, { t: 'drop', piece, dx: 1, dy: 1, rot: 0, tol: null, tray: 9 });                // there is no tray 9: it goes on the table
    expect(a.tray).toBe(-1);
  });

  it('join two neighbours that are put down against each other in a tray, and turn a group in a tray against another', () => {
    const { game, layout } = buildJigsaw(setup({ turning: 1 }));
    const loose = looseOf(game);
    const a = loose[0];
    const b = loose.find((g) => g.id !== a.id && [...g.members].some((m) => Math.abs((m % game.cols) - (a.members[0] % game.cols)) + Math.abs(Math.floor(m / game.cols) - Math.floor(a.members[0] / game.cols)) === 1))!;
    const pa = a.members[0];
    const pb = b.members[0];
    applyOp(game, { t: 'drop', piece: pb, dx: 150, dy: 90, rot: 0, tol: null, tray: 0 });
    expect(applyOp(game, { t: 'drop', piece: pa, dx: 150, dy: 90, rot: 0, tol: null, tray: 0 }).joins).toBe(0);      // (no joining asked for)
    expect(game.groupOf[pa]).not.toBe(game.groupOf[pb]);
    const res = applyOp(game, { t: 'drop', piece: pa, dx: 150, dy: 90, rot: 0, tol: layout.size, tray: 0 });
    expect(res.joins).toBe(1);
    expect(game.groupOf[pa]).toBe(game.groupOf[pb]);
    expect(game.groups.get(game.groupOf[pa])!.tray).toBe(0);
    // turned about its middle, a group that lies against another one does not fit it any more: only a turn that makes them fit joins
    const c = looseOf(game).find((g) => g.tray < 0)!;
    applyOp(game, { t: 'drop', piece: c.members[0], dx: 10, dy: 10, rot: 0, tol: null, tray: 0 });
    expect(applyOp(game, { t: 'rotate', piece: c.members[0], tol: layout.size }).joins).toBe(0);
  });

  it('add and take away trays', () => {
    const { game } = buildJigsaw(setup());
    applyOp(game, { t: 'trayAdd' });
    expect(game.trays).toEqual([0, 1]);
    applyOp(game, { t: 'trayRemove', tray: 0 });
    expect(game.trays).toEqual([1]);
    applyOp(game, { t: 'trayRemove', tray: 5 });
    expect(game.trays).toEqual([1]);
  });
});

describe('sorting trays: the room', () => {
  const grabbedIn = (room: JigsawRoom, who: string, piece: number, now: number) => room.submit(who, { t: 'grab', piece }, now);

  it('lets any player add a tray (the next id, told to everyone) and take away an empty one, and no more than the limit', () => {
    const room = new JigsawRoom(setup());
    const added = room.submit('ann', { t: 'trayAdd' }, 0);
    expect(added.ok && added.event.op).toEqual({ t: 'trayAdd' });
    expect(room.board.game.trays).toEqual([0, 1]);
    const gone = room.submit('bob', { t: 'trayRemove', tray: 0 }, 1);
    expect(gone.ok && gone.event.v).toBe(2);
    expect(room.board.game.trays).toEqual([1]);
    for (let i = 0; i < TRAY_MAX - 1; i++) room.submit('ann', { t: 'trayAdd' }, 5);
    expect(room.board.game.trays).toHaveLength(TRAY_MAX);
    expect(room.submit('ann', { t: 'trayAdd' }, 6)).toEqual({ ok: false, reason: 'bad' });
    expect(room.submit('ann', { t: 'trayRemove', tray: 77 }, 6)).toEqual({ ok: false, reason: 'bad' });
    expect(room.submit('ann', { t: 'trayRemove', tray: 1.5 }, 6)).toEqual({ ok: false, reason: 'bad' });
  });

  it('puts a held group in a tray (the pose is in the tray), and refuses a tray that is not there, a middle outside the tray, or a tray that is not empty to be taken away', () => {
    const room = new JigsawRoom(setup());
    const game = room.board.game;
    const a = looseOf(game)[0];
    const ts = traySize(game.cols, game.size);
    grabbedIn(room, 'ann', a.members[0], 0);
    const drop = (o: object) => room.submit('ann', { t: 'drop', piece: a.members[0], dx: 10, dy: 10, rot: 0, tol: null, tray: 0, ...o }, 5);
    expect(drop({ tray: 3 })).toEqual({ ok: false, reason: 'bad' });
    expect(drop({ dx: ts.w * 2 })).toEqual({ ok: false, reason: 'bad' });
    expect(drop({ dy: -ts.h })).toEqual({ ok: false, reason: 'bad' });
    expect(a.tray).toBe(-1);                                                          // none of that did anything
    const ok = drop({ dx: ts.w / 2, dy: ts.h / 2 });
    expect(ok.ok && ok.event.op).toMatchObject({ t: 'drop', tray: 0, tol: null });
    expect(a.tray).toBe(0);
    expect(room.submit('bob', { t: 'trayRemove', tray: 0 }, 6)).toEqual({ ok: false, reason: 'bad' });
    // taken out again, it is on the table and joins as ever
    grabbedIn(room, 'ann', a.members[0], 7);
    const back = room.submit('ann', { t: 'drop', piece: a.members[0], dx: 700, dy: 800, rot: 0, tol: null }, 8);
    expect(back.ok && back.event.op).toMatchObject({ t: 'drop' });
    expect(a.tray).toBe(-1);
    expect(room.submit('bob', { t: 'trayRemove', tray: 0 }, 9).ok).toBe(true);
  });

  it('joins two groups that are put down against each other in a tray, and keeps the joined group in the tray', () => {
    const room = new JigsawRoom(setup());
    const game = room.board.game;
    const loose = looseOf(game);
    const a = loose[0];
    const b = loose.find((g) => g.id !== a.id && [...g.members].some((m) => Math.abs((m % game.cols) - (a.members[0] % game.cols)) + Math.abs(Math.floor(m / game.cols) - Math.floor(a.members[0] / game.cols)) === 1))!;
    const put = (piece: number, now: number) => {
      room.submit('ann', { t: 'grab', piece }, now);
      return room.submit('ann', { t: 'drop', piece, dx: 150, dy: 90, rot: 0, tol: game.size * 0.3, tray: 0 }, now + 1);
    };
    const first = put(b.members[0], 0);
    expect(first.ok && first.event.joins).toBe(0);
    const second = put(a.members[0], 20);
    expect(second.ok && second.event.joins).toBe(1);
    const joined = game.groups.get(game.groupOf[a.members[0]])!;
    expect(joined.members).toEqual(expect.arrayContaining([a.members[0], b.members[0]]));
    expect(joined.tray).toBe(0);
  });

  it('carries the trays, and what lies in them, in the state that a room goes on from', () => {
    const room = new JigsawRoom(setup());
    const a = looseOf(room.board.game)[0];
    const ts = traySize(room.board.game.cols, room.board.game.size);
    room.submit('ann', { t: 'trayAdd' }, 0);
    room.submit('ann', { t: 'grab', piece: a.members[0] }, 1);
    room.submit('ann', { t: 'drop', piece: a.members[0], dx: ts.w / 3, dy: ts.h / 3, rot: 0, tol: null, tray: 1 }, 2);
    const again = new JigsawRoom(setup(), JSON.parse(JSON.stringify(room.state())));
    expect(again.board.game.trays).toEqual([0, 1]);
    expect(again.board.game.groups.get(again.board.game.groupOf[a.members[0]])!.tray).toBe(1);
    expect(again.state()).toEqual(room.state());
  });
});

describe('sorting trays: where they lie on a screen', () => {
  const ts = traySize(10, 40);

  it('has a size of its own for each puzzle, in the same units as the pieces, and the same shape always', () => {
    expect(trayCells(4)).toBe(10);
    expect(trayCells(32)).toBe(23);
    expect(ts.w / ts.h).toBeCloseTo(TRAY_ASPECT);
    expect(ts.w).toBe(10 * 40);
  });

  it('takes up to half the width and half the height of a screen that is wider than tall, beside the bar, and no more than the tray needs', () => {
    const v = trayView(1200, 800, ts.w, ts.h, 50, 30, 6);
    expect(v.panel.x).toBe(50);
    expect(v.panel.w).toBeCloseTo(575);                                  // the width is what limits it
    expect(v.panel.h).toBeCloseTo(30 + 563 / 2 + 12);
    expect(v.panel.y + v.panel.h).toBeCloseTo(800);                      // on the floor of the screen
    expect(insideBox(v.panel, 60, 700)).toBe(true);
    expect(insideBox(v.panel, 40, 700)).toBe(false);
    expect(insideBox(v.panel, 700, 700)).toBe(false);
    expect(insideBox(v.panel, 60, v.panel.y - 1)).toBe(false);
    // a wide, flat screen: the height is what limits it, and the panel is narrower than half the width
    const wide = trayView(3000, 700, ts.w, ts.h, 50, 30, 6);
    expect(wide.panel.h).toBeCloseTo(350);
    expect(wide.panel.w).toBeLessThan(1475);
    expect(wide.panel.w).toBeCloseTo((350 - 30 - 12) * 2 + 12);
  });

  it('takes up to the whole width and half the height of a screen that is taller than wide', () => {
    const v = trayView(600, 1000, ts.w, ts.h, 50, 30, 6);
    expect(v.panel.x).toBe(50);
    expect(v.panel.w).toBeCloseTo(550);
    expect(v.panel.h).toBeCloseTo(30 + 538 / 2 + 12);
    expect(v.panel.h).toBeLessThan(500);
  });

  it('fits the same space into any panel exactly, as large as it goes, and puts a point of it at the same share of the tray on every screen', () => {
    for (const [w, h] of [[1200, 800], [1920, 1080], [600, 1000], [390, 760], [2560, 1440]]) {
      const v = trayView(w, h, ts.w, ts.h, 44, 30, 6);
      expect(v.area.w / v.area.h).toBeCloseTo(TRAY_ASPECT);
      expect(v.area.x).toBeGreaterThanOrEqual(v.panel.x);
      expect(v.area.y).toBeGreaterThanOrEqual(v.panel.y + v.header.h);
      expect(v.area.x + v.area.w).toBeLessThanOrEqual(v.panel.x + v.panel.w + 1e-9);
      expect(v.area.y + v.area.h).toBeLessThanOrEqual(v.panel.y + v.panel.h + 1e-9);
      // the panel is the tray with its margin and header (nothing is left over), and never more than half the screen's height, nor more than the width there is
      expect(v.panel.w).toBeCloseTo(v.area.w + 12);
      expect(v.panel.h).toBeCloseTo(v.header.h + v.area.h + 12);
      expect(v.panel.h).toBeLessThanOrEqual(h / 2 + 1e-9);
      expect(v.panel.w).toBeLessThanOrEqual((w >= h ? (w - 44) / 2 : w - 44) + 1e-9);
      // the middle of the tray's space, and a quarter along, are at the same shares of the area
      const at = (fx: number, fy: number) => [v.ox + fx * ts.w * v.scale, v.oy + fy * ts.h * v.scale];
      const [mx, my] = at(0.5, 0.5);
      expect(mx).toBeCloseTo(v.area.x + v.area.w / 2);
      expect(my).toBeCloseTo(v.area.y + v.area.h / 2);
      const [qx, qy] = at(0.25, 0.75);
      expect((qx - v.area.x) / v.area.w).toBeCloseTo(0.25);
      expect((qy - v.area.y) / v.area.h).toBeCloseTo(0.75);
    }
  });

  it('keeps the middle of a group inside the tray, whatever its turn', () => {
    const g = { members: [0, 1, 4, 5] };
    for (const rot of [0, 1, 2, 3]) {
      for (const [dx, dy] of [[-1000, -1000], [5000, 5000], [50, 60], [0, 9000]]) {
        const c = clampInTray(g, 4, 40, dx, dy, rot, ts.w, ts.h);
        const [cx, cy] = centreAt(g, 4, 40, c.dx, c.dy, rot);
        expect(cx).toBeGreaterThanOrEqual(-1e-9);
        expect(cx).toBeLessThanOrEqual(ts.w + 1e-9);
        expect(cy).toBeGreaterThanOrEqual(-1e-9);
        expect(cy).toBeLessThanOrEqual(ts.h + 1e-9);
      }
    }
    expect(clampInTray(g, 4, 40, 50, 60, 0, ts.w, ts.h)).toEqual({ dx: 50, dy: 60 });          // already inside: left alone
  });
});
