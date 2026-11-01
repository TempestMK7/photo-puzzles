import { describe, expect, it } from 'vitest';
import { DIRS, generateOverlap, OverlapGame, overlapGrid, STACKS, type OverlapSetup } from '../src/core/overlap';
import { Rng } from '../src/core/rng';

const make = (seed: number, cols = 7, rows = 5, turned = true, placed = 20, windows = true) => generateOverlap(new Rng(seed), { cols, rows, turned, placed, windows });

/** The cells (as indexes) a piece covers at home: its centre, then its arms. */
const cellsOf = (s: OverlapSetup, id: number): number[] => {
  const p = s.pieces[id];
  return [p.cy * s.cols + p.cx, ...p.arms.map((d) => (p.cy + DIRS[d].y) * s.cols + p.cx + DIRS[d].x)];
};

/** Sizes that show every kind of edge: odd and even widths and heights, the smallest board and a big one. */
const SIZES: [number, number][] = [[5, 3], [5, 4], [6, 5], [7, 5], [8, 6], [9, 9], [12, 8], [16, 12]];

describe('the four directions', () => {
  it('go clockwise from the top, so that a quarter turn clockwise moves each to the next', () => {
    expect(DIRS).toEqual([{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]);
  });
});

describe('generateOverlap', () => {
  it('lays pieces on a checkerboard: each has its own centre cell, and a centre cell belongs to no other piece', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const [cols, rows] of SIZES) {
        const s = make(seed, cols, rows);
        const centres = s.pieces.map((p) => p.cy * cols + p.cx);
        expect(new Set(centres).size).toBe(centres.length);
        const parity = (s.pieces[0].cx + s.pieces[0].cy) % 2;
        expect(s.pieces.every((p) => (p.cx + p.cy) % 2 === parity)).toBe(true);
        expect(s.pieces).toHaveLength(Array.from({ length: cols * rows }, (_, i) => ((i % cols) + Math.floor(i / cols)) % 2).filter((v) => v === parity).length);
        const covered = new Set<number>();
        for (const id of s.pieces.map((p) => p.id)) cellsOf(s, id).slice(1).forEach((c) => covered.add(c));
        for (const c of centres) expect(covered.has(c)).toBe(false);          // a centre is never another piece's arm
      }
    }
  });

  it('gives each piece its centre and two to four neighbouring overlap cells (three to five cells), inside the grid', () => {
    const sizes = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      for (const [cols, rows] of SIZES) {
        const s = make(seed, cols, rows);
        for (const p of s.pieces) {
          expect(p.arms.length).toBeGreaterThanOrEqual(2);
          expect(p.arms.length).toBeLessThanOrEqual(4);
          expect(new Set(p.arms).size).toBe(p.arms.length);
          expect([...p.arms].sort((a, b) => a - b)).toEqual(p.arms);
          for (const d of p.arms) {
            const x = p.cx + DIRS[d].x;
            const y = p.cy + DIRS[d].y;
            expect(x >= 0 && y >= 0 && x < cols && y < rows).toBe(true);
            expect((x + y) % 2).not.toBe((p.cx + p.cy) % 2);                  // an overlap cell
          }
          sizes.add(1 + p.arms.length);
        }
      }
    }
    expect([...sizes].sort()).toEqual([3, 4, 5]);
  });

  it('covers every cell, and every overlap cell by at least two pieces', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const [cols, rows] of SIZES) {
        const s = make(seed, cols, rows);
        const cover = new Array<number>(cols * rows).fill(0);
        for (const p of s.pieces) cellsOf(s, p.id).forEach((c) => cover[c]++);
        const centre = new Set(s.pieces.map((p) => p.cy * cols + p.cx));
        cover.forEach((n, c) => {
          if (centre.has(c)) expect(n).toBe(1);
          else expect(n).toBeGreaterThanOrEqual(2);
        });
      }
    }
  });

  it('is reproducible from the seed, and differs between seeds', () => {
    expect(make(9, 8, 6)).toEqual(make(9, 8, 6));
    expect(make(9, 8, 6)).not.toEqual(make(10, 8, 6));
  });

  it('deals every piece that is not placed to a stack, and never starts solved', () => {
    const s = make(3);
    const inStacks = s.stacks.flat().sort((a, b) => a - b);
    expect(s.stacks).toHaveLength(STACKS);
    expect([...inStacks, ...s.placedAtStart].sort((a, b) => a - b)).toEqual(s.pieces.map((p) => p.id));
    expect(new OverlapGame(s).solved).toBe(false);
  });

  it('deals the pieces to as many stacks as it is asked for (three when not asked)', () => {
    const s = generateOverlap(new Rng(5), { cols: 20, rows: 15, turned: true, placed: 20, windows: true, stacks: 6 });
    expect(s.stacks).toHaveLength(6);
    expect([...s.stacks.flat(), ...s.placedAtStart].sort((a, b) => a - b)).toEqual(s.pieces.map((p) => p.id));
    expect(Math.max(...s.stacks.map((st) => st.length)) - Math.min(...s.stacks.map((st) => st.length))).toBeLessThanOrEqual(1);          // dealt evenly
  });

  it('puts windows only on overlap cells that another piece also reveals, never on a centre, never on a placed piece, and never when windows are off', () => {
    let windows = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = make(seed, 8, 6);
      const solid = new Array<number>(s.cols * s.rows).fill(0);
      for (const p of s.pieces) cellsOf(s, p.id).forEach((c, k) => {
        if (k !== p.marker) solid[c]++;
      });
      for (const p of s.pieces) {
        if (p.marker < 0) continue;
        windows++;
        expect(p.marker).toBeGreaterThanOrEqual(1);                            // not the centre
        expect(p.marker).toBeLessThanOrEqual(p.arms.length);
        expect(solid[cellsOf(s, p.id)[p.marker]]).toBeGreaterThanOrEqual(1);
        expect(s.placedAtStart.includes(p.id)).toBe(false);
      }
      expect(make(seed, 8, 6, true, 20, false).pieces.every((p) => p.marker < 0)).toBe(true);
    }
    expect(windows).toBeGreaterThan(30);
  });

  it('turned pieces start turned, and none do when turned is off', () => {
    expect(make(4, 8, 6, true).rot.some((r) => r !== 0)).toBe(true);
    expect(make(4, 8, 6, false).rot.every((r) => r === 0)).toBe(true);
  });
});

describe('OverlapGame', () => {
  /** Solves it: turn the top piece home, drop it in place; repeat. */
  function solve(g: OverlapGame): void {
    for (let guard = 0; guard < 1000 && !g.solved; guard++) {
      const st = g.stacks.findIndex((s) => s.length);
      if (st < 0) break;
      const id = g.top(st);
      while (g.rot[id] !== 0) g.rotate(id);
      const p = g.pieces[id];
      expect(g.drop(id, p.cx, p.cy)).toBe('placed');
    }
  }

  it('can be solved by putting every top piece in place', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const [cols, rows] = SIZES[seed % SIZES.length];
      const g = new OverlapGame(make(seed, cols, rows));
      solve(g);
      expect(g.solved).toBe(true);
      expect(g.revealed.every(Boolean)).toBe(true);
      expect(g.stacks.every((s) => s.length === 0)).toBe(true);
    }
  });

  it('turns a piece about its centre: the centre stays, each arm moves to the next direction', () => {
    const g = new OverlapGame(make(5, 7, 5, false, 0));
    const id = g.top(g.stacks.findIndex((s) => s.length));
    const arms = g.pieces[id].arms;
    expect(g.cellsNow(id)).toEqual([{ x: 0, y: 0 }, ...arms.map((d) => DIRS[d])]);
    g.rotate(id);
    expect(g.cellsNow(id)[0]).toEqual({ x: 0, y: 0 });
    expect(g.cellsNow(id).slice(1)).toEqual(arms.map((d) => DIRS[(d + 1) % 4]));
    g.rotate(id, -1);
    expect(g.cellsNow(id).slice(1)).toEqual(arms.map((d) => DIRS[d]));
    for (let i = 0; i < 4; i++) g.rotate(id);
    expect(g.rot[id]).toBe(0);
  });

  it('a wrong place or a wrong turn sends the piece back and counts a miss', () => {
    const g = new OverlapGame(make(5, 7, 5, true, 0));
    const st = g.stacks.findIndex((s) => s.length);
    const id = g.top(st);
    const p = g.pieces[id];
    expect(g.drop(id, (p.cx + 1) % 7, p.cy)).toBe('wrong');
    if (g.rot[id] === 0) g.rotate(id);
    expect(g.drop(id, p.cx, p.cy)).toBe('wrong'); // right place, wrong turn
    expect(g.misses).toBe(2);
    expect(g.top(st)).toBe(id);
    expect(g.revealed.some(Boolean)).toBe(false);
  });

  it('a piece placed reveals its centre and its arms, and nothing else', () => {
    const g = new OverlapGame(make(8, 8, 6, false, 0, false));
    const st = g.stacks.findIndex((s) => s.length);
    const id = g.top(st);
    const p = g.pieces[id];
    g.drop(id, p.cx, p.cy);
    const shown = g.revealed.map((r, i) => (r ? i : -1)).filter((i) => i >= 0).sort((a, b) => a - b);
    expect(shown).toEqual(g.homeCells(id).map((c) => c.y * g.cols + c.x).sort((a, b) => a - b));
  });

  it('needs every piece: the centre cell of a piece shows nowhere else, so no piece is ever left over', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = new OverlapGame(make(seed, 8, 6, false, 0));
      const total = g.total;
      let placed = 0;
      for (let guard = 0; guard < 200 && !g.solved; guard++) {
        const st = g.stacks.findIndex((s) => s.length);
        const id = g.top(st);
        const p = g.pieces[id];
        expect(g.revealed[p.cy * g.cols + p.cx]).toBe(false);
        g.drop(id, p.cx, p.cy);
        placed++;
      }
      expect(placed).toBe(total);
    }
  });

  it('a window does not reveal its cell, and for every unplaced piece that looks at that cell it turns into the picture when any piece is placed over it', () => {
    let checked = 0;
    for (let seed = 1; seed <= 60 && checked < 5; seed++) {
      const g = new OverlapGame(make(seed, 9, 7, false, 0));
      // all the window pieces that look at the same cell
      const byCell = new Map<number, number[]>();
      for (const p of g.pieces) if (p.marker >= 0) {
        const c = g.homeCells(p.id)[p.marker];
        const key = c.y * g.cols + c.x;
        byCell.set(key, [...(byCell.get(key) ?? []), p.id]);
      }
      const shared = [...byCell.entries()].find(([, ids]) => ids.length >= 2);
      if (!shared) continue;
      const [key, ids] = shared;
      for (const id of ids) expect(g.windowOf(id)).toBe(g.pieces[id].marker);
      // a window piece placed does not reveal the cell it looks at
      const bring = (id: number): void => {
        const st = g.stacks.findIndex((s2) => s2.includes(id));
        for (let n = 0; n < 200 && g.top(st) !== id; n++) g.cycle(st, 1);
        while (g.rot[id] !== 0) g.rotate(id);
      };
      bring(ids[0]);
      g.drop(ids[0], g.pieces[ids[0]].cx, g.pieces[ids[0]].cy);
      expect(g.revealed[key]).toBe(false);
      expect(g.windowOf(ids[1])).toBe(g.pieces[ids[1]].marker);                // still a window
      // a piece that shows that cell for real is placed: every unplaced window on it clears
      const other = g.pieces.find((q) => q.id !== ids[0] && !g.done[q.id] && g.homeCells(q.id).some((c, k) => c.y * g.cols + c.x === key && k !== q.marker));
      expect(other).toBeDefined();
      bring(other!.id);
      g.drop(other!.id, other!.cx, other!.cy);
      expect(g.revealed[key]).toBe(true);
      for (const id of ids) if (!g.done[id]) expect(g.windowOf(id)).toBe(-1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('a piece dragged to another drawer goes on top of it', () => {
    const g = new OverlapGame(make(7, 8, 6, false, 0));
    const from = 0;
    const to = 1;
    const id = g.top(from);
    const n = g.stacks[to].length;
    g.moveToStack(id, to);
    expect(g.top(to)).toBe(id);
    expect(g.stacks[to]).toHaveLength(n + 1);
    expect(g.stacks[from]).not.toContain(id);
    g.moveToStack(id, to);                                  // onto its own drawer: still once, still on top
    expect(g.stacks[to].filter((x) => x === id)).toHaveLength(1);
    expect(g.top(to)).toBe(id);
    expect(g.stacks.flat()).toHaveLength(g.stacks.flat().length);
  });

  it('cycling a stack moves the top piece to the bottom and back', () => {
    const g = new OverlapGame(make(6, 8, 6, false, 0));
    const before = [...g.stacks[0]];
    g.cycle(0, 1);
    expect(g.stacks[0][0]).toBe(before[before.length - 1]);
    g.cycle(0, -1);
    expect(g.stacks[0]).toEqual(before);
  });

  it('saves and restores what was played', () => {
    const g = new OverlapGame(make(11, 7, 5, true, 0));
    const id = g.top(g.stacks.findIndex((s) => s.length));
    while (g.rot[id] !== 0) g.rotate(id);
    g.drop(id, g.pieces[id].cx, g.pieces[id].cy);
    const h = new OverlapGame(make(11, 7, 5, true, 0));
    h.restore(g.snapshot());
    expect(h.snapshot()).toEqual(g.snapshot());
    expect(() => new OverlapGame(make(11, 9, 7, true, 0)).restore(g.snapshot())).toThrow();
  });
});

describe('overlapGrid', () => {
  it('gives about the asked number of cells in the proportions of the picture', () => {
    for (const total of [50, 100, 250, 500]) {
      for (const [w, h] of [[800, 600], [1600, 900], [600, 800], [1000, 1000]]) {
        const { cols, rows } = overlapGrid(total, w, h);
        expect(cols * rows, `${total} ${w}x${h}`).toBeGreaterThan(total * 0.8);
        expect(cols * rows, `${total} ${w}x${h}`).toBeLessThan(total * 1.2);
        expect(Math.abs(cols / rows - w / h) / (w / h)).toBeLessThan(0.35);
      }
    }
  });
  it('keeps the grid at least four by three, and makes more cells for a bigger ask', () => {
    expect(overlapGrid(50, 4000, 100).rows).toBe(3);
    expect(overlapGrid(50, 100, 4000).cols).toBe(4);
    expect(overlapGrid(500, 800, 600).cols).toBeGreaterThan(overlapGrid(50, 800, 600).cols);
  });
});
