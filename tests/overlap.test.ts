import { describe, expect, it } from 'vitest';
import { generateOverlap, OverlapGame, shapeCells, STACKS } from '../src/core/overlap';
import { Rng } from '../src/core/rng';

const make = (seed: number, cols = 7, rows = 5, turned = true, placed = 20, windows = true) => generateOverlap(new Rng(seed), { cols, rows, turned, placed, windows });

describe('overlap shapes', () => {
  it('every orientation is an L in a 2 x 2 box, with the same three cells in the same order', () => {
    for (let o = 0; o < 4; o++) {
      const cells = shapeCells(o);
      expect(cells).toHaveLength(3);
      expect(Math.min(...cells.map((c) => c.x))).toBe(0);
      expect(Math.min(...cells.map((c) => c.y))).toBe(0);
      expect(Math.max(...cells.map((c) => c.x))).toBe(1);
      expect(Math.max(...cells.map((c) => c.y))).toBe(1);
      expect(new Set(cells.map((c) => `${c.x},${c.y}`)).size).toBe(3);
    }
    expect(shapeCells(5)).toEqual(shapeCells(1));
  });
});

describe('generateOverlap', () => {
  it('covers every cell, keeps pieces inside the grid and is reproducible', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = make(seed, 5 + (seed % 6), 3 + (seed % 5));
      const cover = new Array(s.cols * s.rows).fill(0);
      for (const p of s.pieces) {
        expect(p.bx >= 0 && p.by >= 0 && p.bx + 2 <= s.cols && p.by + 2 <= s.rows).toBe(true);
        for (const c of shapeCells(p.orient)) cover[(p.by + c.y) * s.cols + p.bx + c.x]++;
      }
      expect(cover.every((n) => n >= 1)).toBe(true);
      expect(make(seed, 5 + (seed % 6), 3 + (seed % 5))).toEqual(s);
    }
  });

  it('deals every piece that is not placed to a stack, and never starts solved', () => {
    const s = make(3);
    const inStacks = s.stacks.flat().sort((a, b) => a - b);
    expect(s.stacks).toHaveLength(STACKS);
    expect([...inStacks, ...s.placedAtStart].sort((a, b) => a - b)).toEqual(s.pieces.map((p) => p.id));
    expect(new OverlapGame(s).solved).toBe(false);
  });

  it('some pieces have a window, only on a cell another piece also reveals, never when windows are off', () => {
    let windows = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = make(seed, 8, 6);
      const solid = new Array(s.cols * s.rows).fill(0);
      for (const p of s.pieces) shapeCells(p.orient).forEach((c, k) => {
        if (k !== p.marker) solid[(p.by + c.y) * s.cols + p.bx + c.x]++;
      });
      for (const p of s.pieces) {
        if (p.marker < 0) continue;
        windows++;
        const c = shapeCells(p.orient)[p.marker];
        expect(solid[(p.by + c.y) * s.cols + p.bx + c.x]).toBeGreaterThanOrEqual(1);
        expect(s.placedAtStart.includes(p.id)).toBe(false);
      }
      expect(make(seed, 8, 6, true, 20, false).pieces.every((p) => p.marker < 0)).toBe(true);
    }
    expect(windows).toBeGreaterThan(20);
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
      expect(g.drop(id, p.bx, p.by)).toBe('placed');
    }
  }

  it('can be solved by putting every top piece in place', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const g = new OverlapGame(make(seed, 5 + (seed % 6), 3 + (seed % 5)));
      solve(g);
      expect(g.solved).toBe(true);
      expect(g.revealed.every(Boolean)).toBe(true);
      expect(g.stacks.every((s) => s.length === 0)).toBe(true);
    }
  });

  it('a wrong place or a wrong turn sends the piece back and counts a miss', () => {
    const g = new OverlapGame(make(5, 7, 5, true, 0));
    const st = g.stacks.findIndex((s) => s.length);
    const id = g.top(st);
    const p = g.pieces[id];
    expect(g.drop(id, (p.bx + 1) % 5, p.by)).toBe('wrong');
    if (g.rot[id] === 0) g.rotate(id);
    expect(g.drop(id, p.bx, p.by)).toBe('wrong'); // right place, wrong turn
    expect(g.misses).toBe(2);
    expect(g.top(st)).toBe(id);
    expect(g.revealed.some(Boolean)).toBe(false);
  });

  it('a piece whose cells all show already is taken off its stack', () => {
    let seen = false;
    for (let seed = 1; seed <= 40 && !seen; seed++) {
      const g = new OverlapGame(make(seed, 8, 6, false, 0));
      const total = g.total;
      let placed = 0;
      for (let guard = 0; guard < 200 && !g.solved; guard++) {
        const st = g.stacks.findIndex((s) => s.length);
        const id = g.top(st);
        const p = g.pieces[id];
        g.drop(id, p.bx, p.by);
        placed++;
      }
      if (placed < total) seen = true;
    }
    expect(seen).toBe(true);
  });

  it('a window does not reveal its cell, and clears when something else reveals that cell', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = new OverlapGame(make(seed, 8, 6, false, 0));
      const win = g.pieces.find((p) => p.marker >= 0);
      if (!win) continue;
      expect(g.windowOf(win.id)).toBe(win.marker);
      const cell = g.homeCells(win.id)[win.marker];
      // the piece itself goes first: bring it to the top of its stack and place it
      const st = g.stacks.findIndex((s) => s.includes(win.id));
      while (g.top(st) !== win.id) g.cycle(st, 1);
      g.drop(win.id, win.bx, win.by);
      expect(g.revealed[cell.y * g.cols + cell.x]).toBe(false);
      expect(g.windowOf(win.id)).toBe(win.marker);          // still looking at an empty cell
      const other = g.pieces.find((q) => q.id !== win.id && !g.done[q.id] && g.homeCells(q.id).some((c, k) => c.x === cell.x && c.y === cell.y && k !== q.marker));
      expect(other).toBeDefined();
      const so = g.stacks.findIndex((s2) => s2.includes(other!.id));
      for (let n = 0; n < 50 && g.top(so) !== other!.id; n++) g.cycle(so, 1);
      while (g.rot[other!.id] !== 0) g.rotate(other!.id);
      g.drop(other!.id, other!.bx, other!.by);
      expect(g.revealed[cell.y * g.cols + cell.x]).toBe(true);
      expect(g.windowOf(win.id)).toBe(-1);                 // another piece revealed it: the window has nothing left to hint
      return;
    }
    throw new Error('no window piece found');
  });

  it('cycling a stack moves the top piece to the bottom and back', () => {
    const g = new OverlapGame(make(6, 8, 6, false, 0));
    const before = [...g.stacks[0]];
    g.cycle(0, 1);
    expect(g.stacks[0][0]).toBe(before[before.length - 1]);
    g.cycle(0, -1);
    expect(g.stacks[0]).toEqual(before);
  });
});
