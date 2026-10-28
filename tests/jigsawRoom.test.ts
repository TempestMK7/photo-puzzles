import { describe, expect, it } from 'vitest';
import { JigsawGame } from '../src/core/jigsaw';
import { JigsawRoom, LOCK_MS, type RoomEvent } from '../src/core/jigsawRoom';
import { applyOp, buildJigsaw, TOL_MAX_K, TOL_MIN_K, type JigsawSetup } from '../src/core/jigsawSetup';
import { Rng } from '../src/core/rng';

// the hash of a start state, taken from the game as it was before the setup moved out of the session: it must not change, or old saved puzzles and shared seeds break
const fnv = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(16)}:${s.length}`;
};

describe('buildJigsaw', () => {
  const cases: [JigsawSetup, string, number, number][] = [
    [{ seed: 12345, width: 800, height: 600, opts: { pieces: 100 } }, '72d0496a:8710', 3200, 2133.3333333333335],
    [{ seed: 987654321, width: 1600, height: 900, opts: { pieces: 300, turning: 1 } }, '1dde857:27898', 6369.230769230769, 3600],
    [{ seed: 42, width: 1000, height: 1000, opts: { pieces: 60, placed: 25, edges: 0 } }, 'a087e319:4811', 4000, 4000],
    [{ seed: 4242, width: 1200, height: 800, opts: { pieces: 150, placed: 30, edges: 1, turning: 1 } }, 'cf8d1fe:10363', 4800, 3200],
    [{ seed: 7, width: 640, height: 960, opts: { pieces: 1000, edges: 1 } }, '923c5f83:93048', 2560, 3741.538461538462],
  ];

  it('starts every puzzle the way the game always has', () => {
    for (const [setup, hash, w, h] of cases) {
      const b = buildJigsaw(setup);
      expect(fnv(JSON.stringify(b.game.snapshot()))).toBe(hash);
      expect([b.worldW, b.worldH]).toEqual([w, h]);
    }
  });

  it('makes the same puzzle every time, whatever else has been made in between', () => {
    const a = buildJigsaw(cases[1][0]);
    buildJigsaw(cases[0][0]);
    const b = buildJigsaw(cases[1][0]);
    expect(b.game.snapshot()).toEqual(a.game.snapshot());
    expect(b.layout).toEqual(a.layout);
  });
});

describe('applyOp', () => {
  it('puts a group down, turns it, joins it to what it lies against, and leaves the picture alone', () => {
    const { game, layout } = buildJigsaw({ seed: 5, width: 400, height: 300, opts: { pieces: 12, turning: 1 } });
    const loose = [...game.groups.values()].filter((g) => !g.anchored);
    const g = loose[0];
    applyOp(game, { t: 'grab', piece: g.members[0] });
    expect(game.z[game.z.length - 1]).toBe(g.id);
    applyOp(game, { t: 'drop', piece: g.members[0], dx: 11, dy: 22, rot: 3, tol: null });
    expect([g.dx, g.dy, g.rot]).toEqual([11, 22, 3]);
    const before = g.rot;
    applyOp(game, { t: 'rotate', piece: g.members[0], tol: null });
    expect(g.rot).toBe((before + 1) % 4);
    const snap = JSON.stringify(game.snapshot());
    applyOp(game, { t: 'drop', piece: 0, dx: 5, dy: 5, rot: 1, tol: 1 });
    applyOp(game, { t: 'grab', piece: 9999 });
    expect(JSON.stringify(game.snapshot())).toBe(snap);
    expect(layout.cols * layout.rows).toBeGreaterThan(8);
  });
});

// -------------------------------------------------------------------------------------------------------------------------------- the room

const setup = (opts: Record<string, number> = {}): JigsawSetup => ({ seed: 99, width: 400, height: 300, opts: { pieces: 12, ...opts } });
const loose = (room: JigsawRoom) => [...room.board.game.groups.values()].filter((g) => !g.anchored);

describe('JigsawRoom: one hand', () => {
  it('lets one player hold a piece at a time and tells the others who', () => {
    const room = new JigsawRoom(setup());
    const [a, b] = loose(room);
    const got = room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
    expect(got.ok && got.event.lock).toEqual({ holder: 'ann', piece: a.members[0], until: LOCK_MS });
    expect(room.submit('bob', { t: 'grab', piece: b.members[0] }, 1000)).toEqual({ ok: false, reason: 'busy', holder: 'ann' });
    expect(room.submit('bob', { t: 'drop', piece: a.members[0], dx: 0, dy: 0, rot: 0, tol: null }, 1000)).toEqual({ ok: false, reason: 'not-holder' });
    expect(room.submit('bob', { t: 'release' }, 1000)).toEqual({ ok: false, reason: 'not-holder' });
    expect(room.submit('bob', { t: 'rotate', piece: b.members[0], tol: null }, 1000)).toEqual({ ok: false, reason: 'busy', holder: 'ann' });
  });

  it('gives the piece to the next player once the hold has run out, with no one noticing that the first has gone', () => {
    const room = new JigsawRoom(setup());
    const [a, b] = loose(room);
    room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
    expect(room.holder(LOCK_MS - 1)?.holder).toBe('ann');
    expect(room.holder(LOCK_MS)).toBeNull();
    expect(room.submit('bob', { t: 'grab', piece: b.members[0] }, LOCK_MS).ok).toBe(true);
    // ann comes back too late: it is bob's now
    expect(room.submit('ann', { t: 'drop', piece: a.members[0], dx: 1, dy: 1, rot: 0, tol: null }, LOCK_MS + 5)).toEqual({ ok: false, reason: 'not-holder' });
    expect(room.renew('ann', LOCK_MS + 5)).toEqual({ ok: false, reason: 'not-holder' });
  });

  it('keeps the hold while it is renewed, and lets a player whose hold ran out but who was not replaced put the piece down', () => {
    const room = new JigsawRoom(setup());
    const [a] = loose(room);
    room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
    expect(room.renew('ann', 8000)).toEqual({ ok: true, until: 8000 + LOCK_MS });
    expect(room.holder(15_000)?.holder).toBe('ann');
    const late = room.submit('ann', { t: 'drop', piece: a.members[0], dx: 7, dy: 8, rot: 0, tol: null }, 60_000);
    expect(late.ok && late.event.lock).toBeNull();
    expect([a.dx, a.dy]).toEqual([7, 8]);
  });

  it('lets go on release, and counts every accepted command', () => {
    const room = new JigsawRoom(setup());
    const [a, b] = loose(room);
    const g = room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
    const r = room.submit('ann', { t: 'release' }, 10);
    expect(g.ok && g.event.v).toBe(1);
    expect(r.ok && r.event).toMatchObject({ v: 2, lock: null, op: undefined });
    expect(room.submit('bob', { t: 'grab', piece: b.members[0] }, 20).ok).toBe(true);
    expect(room.version).toBe(3);
  });

  it('does not let a player grab a second piece for another to turn, but lets a free one be turned', () => {
    const room = new JigsawRoom(setup({ turning: 1 }));
    const [a, b] = loose(room);
    const before = b.rot;
    expect(room.submit('bob', { t: 'rotate', piece: b.members[0], tol: null }, 0).ok).toBe(true);
    expect(b.rot).toBe((before + 1) % 4);
    room.submit('ann', { t: 'grab', piece: a.members[0] }, 10);
    expect(room.submit('ann', { t: 'rotate', piece: b.members[0], tol: null }, 20)).toEqual({ ok: false, reason: 'busy', holder: 'ann' });
    expect(room.submit('ann', { t: 'rotate', piece: a.members[0], tol: null }, 20).ok).toBe(true);
  });
});

describe('JigsawRoom: what it checks', () => {
  it('refuses groups that are not there, and numbers that make no sense', () => {
    const room = new JigsawRoom(setup());
    const [a] = loose(room);
    expect(room.submit('ann', { t: 'grab', piece: 9999 }, 0)).toEqual({ ok: false, reason: 'bad' });
    expect(room.submit('ann', { t: 'grab', piece: 0 }, 0)).toEqual({ ok: false, reason: 'no-group' });
    expect(room.submit('ann', { t: 'grab', piece: 1.5 }, 0)).toEqual({ ok: false, reason: 'bad' });
    room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
    const drop = (o: object) => room.submit('ann', { t: 'drop', piece: a.members[0], dx: 0, dy: 0, rot: 0, tol: null, ...o }, 5);
    for (const bad of [{ dx: NaN }, { dy: Infinity }, { dx: 1e12 }, { rot: 4 }, { rot: 0.5 }, { rot: -1 }, { tol: NaN }, { dx: '3' as unknown as number }]) expect(drop(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: 'bad' });
    expect(room.version).toBe(1);                                  // none of that counted
    expect(room.holder(5)?.holder).toBe('ann');
  });

  it('keeps how close a group has to lie to join within what a screen can ask for', () => {
    const size = buildJigsaw(setup()).layout.size;
    for (const [asked, allowed] of [[0.0001, TOL_MIN_K * size], [1e9, TOL_MAX_K * size], [size * 0.3, size * 0.3]]) {
      const room = new JigsawRoom(setup());
      const [a] = loose(room);
      room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
      const r = room.submit('ann', { t: 'drop', piece: a.members[0], dx: a.dx, dy: a.dy, rot: a.rot, tol: asked }, 1);
      expect(r.ok && r.event.op).toMatchObject({ tol: allowed });
    }
  });
});

// A scripted game: three players, pieces held and let go in the right places and wrong ones, holds that run out. A copy of the board that only applies what the room published
// has to end up exactly where the room's board is, and the puzzle has to get solved.
function play(opts: Record<string, number>, seed: number): { room: JigsawRoom; copy: JigsawGame; events: RoomEvent[]; steals: number } {
  const s: JigsawSetup = { seed, width: 480, height: 320, opts: { pieces: 24, ...opts } };
  const room = new JigsawRoom(s);
  const copy = buildJigsaw(s).game;
  const rng = new Rng(seed * 7 + 1);
  const players = ['ann', 'bob', 'cy'];
  const events: RoomEvent[] = [];
  const size = room.board.layout.size;
  let now = 0;
  let steals = 0;                                                  // holds that ran out and were taken over
  const publish = (e: RoomEvent): void => {
    events.push(e);
    if (e.op) applyOp(copy, e.op);
    expect(JSON.stringify(copy.snapshot())).toBe(JSON.stringify(room.board.game.snapshot()));
  };
  for (let step = 0; step < 4000 && !room.solved; step++) {
    const g = room.board.game;
    const who = players[rng.below(3)];
    const other = players[(players.indexOf(who) + 1 + rng.below(2)) % 3];
    const mine = loose(room);
    const a = mine[rng.below(mine.length)];
    now += 50;
    const got = room.submit(who, { t: 'grab', piece: a.members[0] }, now);
    if (!got.ok) continue;
    publish(got.event);
    const b = loose(room).find((x) => x.id !== a.id);
    if (b) expect(room.submit(other, { t: 'grab', piece: b.members[0] }, now + 1)).toMatchObject({ ok: false, reason: 'busy', holder: who });
    if (rng.below(8) === 0) {                                      // the holder disappears; much later someone else just takes over
      now += LOCK_MS + 1;
      steals++;
      continue;
    }
    // the group lies right against one it belongs next to, or somewhere else on the table
    let pose = { dx: rng.unit() * room.board.worldW, dy: rng.unit() * room.board.worldH, rot: g.groups.get(a.id)!.rot };
    if (rng.below(10) < 7) {
      const pairs: { dx: number; dy: number; rot: number }[] = [];
      for (const m of g.groups.get(a.id)!.members) {
        const c = m % g.cols;
        const r = Math.floor(m / g.cols);
        for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]]) {
          if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
          const o = g.groups.get(g.groupOf[nr * g.cols + nc])!;
          if (o.id !== a.id) pairs.push({ dx: o.dx, dy: o.dy, rot: o.rot });
        }
      }
      const p = pairs[rng.below(pairs.length)];
      pose = { dx: p.dx + (rng.unit() - 0.5) * size * 0.1, dy: p.dy + (rng.unit() - 0.5) * size * 0.1, rot: p.rot };
    }
    now += 300;
    const done = room.submit(who, { t: 'drop', piece: a.members[0], ...pose, tol: size * 0.3 }, now);
    expect(done.ok).toBe(true);
    if (done.ok) publish(done.event);
    if (opts.turning === 1 && rng.below(6) === 0 && !room.solved) {
      const t = loose(room)[0];
      const r = room.submit(other, { t: 'rotate', piece: t.members[0], tol: size * 0.3 }, now + 1);
      if (r.ok) publish(r.event);
    }
  }
  return { room, copy, events, steals };
}

describe('JigsawRoom: a whole game', () => {
  it.each([
    ['upright pieces', {}, 3],
    ['turned pieces', { turning: 1 }, 4],
    ['pieces placed at the start, the edges apart', { placed: 30, edges: 1 }, 5],
  ])('%s: every screen ends up with the room\'s board, and the puzzle gets solved', (_name, opts, seed) => {
    const { room, copy, events, steals } = play(opts, seed);
    expect(room.solved).toBe(true);
    expect(copy.solved).toBe(true);
    expect(events.at(-1)?.solved).toBe(true);
    expect(events.map((e) => e.v)).toEqual(events.map((_, i) => i + 1));         // the numbers go up by one, never skip
    expect(events.some((e) => e.joins > 0)).toBe(true);
    expect(steals).toBeGreaterThan(0);
  });

  it('refuses everything once the puzzle is solved', () => {
    const { room } = play({}, 3);
    expect(room.submit('ann', { t: 'grab', piece: 0 }, 1e9)).toEqual({ ok: false, reason: 'ended' });
    expect(room.submit('ann', { t: 'release' }, 1e9)).toEqual({ ok: false, reason: 'ended' });
    expect(room.renew('ann', 1e9)).toEqual({ ok: false, reason: 'ended' });
    expect(room.holder(0)).toBeNull();
  });

  it('carries on from its saved state, a hold included, on another instance', () => {
    const s = setup({ turning: 1 });
    const room = new JigsawRoom(s);
    const [a, b] = loose(room);
    room.submit('ann', { t: 'grab', piece: a.members[0] }, 0);
    room.submit('ann', { t: 'drop', piece: a.members[0], dx: 3, dy: 4, rot: 2, tol: null }, 10);
    room.submit('bob', { t: 'grab', piece: b.members[0] }, 20);
    const saved = JSON.parse(JSON.stringify(room.state()));
    const again = new JigsawRoom(s, saved);
    expect(again.state()).toEqual(room.state());
    expect(again.version).toBe(3);
    expect(again.submit('cy', { t: 'grab', piece: a.members[0] }, 30)).toEqual({ ok: false, reason: 'busy', holder: 'bob' });
    expect(again.submit('bob', { t: 'release' }, 30).ok).toBe(true);
  });

  it('refuses a saved state that is not this puzzle', () => {
    const room = new JigsawRoom(setup());
    const other = new JigsawRoom({ ...setup(), opts: { pieces: 40 } }).state();
    expect(() => new JigsawRoom(setup(), other)).toThrow();
    expect(room.version).toBe(0);
  });
});
