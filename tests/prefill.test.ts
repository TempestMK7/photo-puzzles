import { describe, expect, it } from 'vitest';
import { generateOverlap, OverlapGame } from '../src/core/overlap';
import { prefillPatches } from '../src/core/prefill';
import { Rng } from '../src/core/rng';
import { FILLED_AT_START, generateStrips, StripsGame } from '../src/core/strips';
import { KINDS, optionsOf } from '../src/core/kinds';

describe('prefillPatches, the cells that start filled in', () => {
  const all = () => true;

  it('gives as many cells as asked for (fewer when there are not so many to choose from), each once', () => {
    for (const count of [0, 1, 5, 20, 33]) {
      const cells = prefillPatches(new Rng(count + 1), 12, 10, all, count);
      expect(cells).toHaveLength(count);
      expect(new Set(cells).size).toBe(count);
    }
    expect(prefillPatches(new Rng(1), 4, 4, (x) => x === 0, 99)).toHaveLength(4);
    expect(prefillPatches(new Rng(1), 4, 4, () => false, 5)).toEqual([]);
  });

  it('uses only the cells that are allowed', () => {
    const even = (x: number, y: number) => (x + y) % 2 === 0;
    for (const c of prefillPatches(new Rng(3), 14, 10, even, 30)) expect(even(c % 14, Math.floor(c / 14))).toBe(true);
  });

  it('puts them in four patches, one round the centre of each quarter of the board, with a share each', () => {
    const cols = 40;
    const rows = 30;
    const cells = prefillPatches(new Rng(7), cols, rows, all, 80);
    const quarter = (c: number): number => (c % cols < cols / 2 ? 0 : 1) + (Math.floor(c / cols) < rows / 2 ? 0 : 2);
    const counts = [0, 0, 0, 0];
    for (const c of cells) counts[quarter(c)]++;
    expect(counts).toEqual([20, 20, 20, 20]);
    // every cell of a patch is near its quarter's centre: close compared with the size of the quarter
    const centres = [[10, 7.5], [30, 7.5], [10, 22.5], [30, 22.5]];
    for (const c of cells) {
      const [cx, cy] = centres[quarter(c)];
      expect(Math.hypot((c % cols) + 0.5 - cx, Math.floor(c / cols) + 0.5 - cy)).toBeLessThan(6);
    }
  });

  it('draws nothing from the random numbers when there is nothing to fill in, and is the same for the same seed', () => {
    const rng = new Rng(5);
    expect(prefillPatches(rng, 10, 10, all, 0)).toEqual([]);
    expect(rng.below(1000)).toBe(new Rng(5).below(1000));
    expect(prefillPatches(new Rng(8), 10, 10, all, 15)).toEqual(prefillPatches(new Rng(8), 10, 10, all, 15));
  });
});

describe('Overlap with cells filled in at the start', () => {
  const make = (seed: number, placed: number, cols = 20, rows = 14) => generateOverlap(new Rng(seed), { cols, rows, turned: true, placed, windows: true });

  it('fills in the share of all the cells that was asked for, and only overlap cells, never a piece\'s own', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const placed of [0, 10, 25, 50]) {
        const s = make(seed, placed);
        const centre = new Set(s.pieces.map((p) => p.cy * s.cols + p.cx));
        expect(s.prefilled).toHaveLength(Math.round((s.cols * s.rows * placed) / 100));
        for (const cell of s.prefilled) expect(centre.has(cell)).toBe(false);
      }
    }
  });

  it('shows those cells from the start with no piece placed, and does not change the pieces: the same seed gives the same pieces whatever the share', () => {
    const none = make(4, 0);
    const some = make(4, 40);
    expect(none.prefilled).toEqual([]);
    expect(some.pieces).toEqual(none.pieces);
    expect(some.stacks).toEqual(none.stacks);
    expect(some.rot).toEqual(none.rot);
    const game = new OverlapGame(some);
    expect(game.revealed.filter(Boolean)).toHaveLength(some.prefilled.length);
    for (const cell of some.prefilled) expect(game.revealed[cell]).toBe(true);
    expect(game.done.some(Boolean)).toBe(false);
    expect(game.solved).toBe(false);
  });

  it('is a slider from 0 to 50 percent that starts at 0', () => {
    const option = KINDS.find((k) => k.id === 'overlap')!.options.find((o) => o.key === 'placed')!;
    expect([option.min, option.max, option.def]).toEqual([0, 50, 0]);
    expect(optionsOf({}, KINDS.find((k) => k.id === 'overlap')!).placed).toBe(0);
  });
});

describe('Strips with a fifth of the cells filled in at the start', () => {
  const make = (seed: number, picCols = 20, picRows = 14) => generateStrips(new Rng(seed), { picCols, picRows, maxLen: 8, tabs: 3 });

  it('has no slider for it, and fills in 20 percent of the picture\'s cells, no strip being in place', () => {
    expect(KINDS.find((k) => k.id === 'strips')!.options.some((o) => o.key === 'placed')).toBe(false);
    expect(FILLED_AT_START).toBe(20);
    for (let seed = 1; seed <= 10; seed++) {
      const s = make(seed);
      expect(s.filled).toHaveLength(Math.round((s.picCols * s.picRows * 20) / 100));
      expect(s.state.some((t) => t.locked)).toBe(false);
      const g = new StripsGame(s);
      expect(g.filled.filter(Boolean)).toHaveLength(s.filled.length);
      expect(g.solved).toBe(false);
    }
  });

  it('puts them in patches round the centre of each quarter of the picture', () => {
    const s = make(6, 40, 30);
    const quarter = (c: number): number => (c % 40 < 20 ? 0 : 1) + (Math.floor(c / 40) < 15 ? 0 : 2);
    const counts = [0, 0, 0, 0];
    for (const c of s.filled) counts[quarter(c)]++;
    expect(counts).toEqual([60, 60, 60, 60]);
  });
});
