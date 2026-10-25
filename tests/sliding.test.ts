import { describe, expect, it } from 'vitest';
import { SlidingGame, slidingGrid } from '../src/core/sliding';

describe('slidingGrid', () => {
  it('uses the grid whose tile count is nearest what was asked for', () => {
    expect(slidingGrid(1000, 1000, 8)).toEqual({ cols: 3, rows: 3 });
    expect(slidingGrid(1000, 1000, 15)).toEqual({ cols: 4, rows: 4 });
    expect(slidingGrid(1000, 1000, 24)).toEqual({ cols: 5, rows: 5 });
    for (const tiles of [8, 15, 30, 60, 99]) {
      const g = slidingGrid(1600, 1066, tiles);
      expect(Math.abs(g.cols * g.rows - 1 - tiles) / tiles).toBeLessThan(0.2);
    }
  });

  it('gives a wide picture more columns than rows, and a tall one the other way round, so the tiles stay near square', () => {
    const wide = slidingGrid(1600, 800, 24);
    const tall = slidingGrid(800, 1600, 24);
    expect(wide.cols).toBeGreaterThan(wide.rows);
    expect(tall.rows).toBeGreaterThan(tall.cols);
    for (const g of [wide, tall]) expect(g.cols * g.rows - 1).toBeGreaterThanOrEqual(20);
  });
});

describe('SlidingGame', () => {
  const make = (seed = 1, cols = 4, rows = 3) => new SlidingGame({ cols, rows }, seed);

  it('starts shuffled, with the hole somewhere, and is reproducible from the seed', () => {
    const g = make(5);
    expect(g.solved).toBe(false);
    expect([...g.cells].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(make(5).cells).toEqual(g.cells);
    expect(make(6).cells).not.toEqual(g.cells);
    for (let seed = 1; seed < 60; seed++) expect(make(seed, 2, 2).solved).toBe(false);          // even the smallest grid is never handed over solved
  });

  it('slides a tile into the hole, and the tiles between it and the hole go along', () => {
    const g = make(3);
    const blank = g.blank;
    const row = Math.floor(blank / g.cols);
    const far = row * g.cols + (blank % g.cols < g.cols / 2 ? g.cols - 1 : 0);
    const chain = g.chain(far);
    expect(chain.length).toBe(Math.abs(far - blank));
    expect(chain[chain.length - 1]).toBe(far);
    const pieces = chain.map((c) => g.cells[c]);
    const moved = g.click(far);
    expect(moved.map((m) => m.piece)).toEqual(pieces);
    expect(g.blank).toBe(far);
    expect(g.moves).toBe(1);
    chain.forEach((_c, i) => expect(g.cells[i === 0 ? blank : chain[i - 1]]).toBe(pieces[i]));
  });

  it('ignores a click on a tile that is not in the hole\'s row or column, and on the hole', () => {
    const g = make(4);
    const blank = g.blank;
    const off = g.cells.findIndex((_, i) => Math.floor(i / g.cols) !== Math.floor(blank / g.cols) && i % g.cols !== blank % g.cols);
    const before = [...g.cells];
    expect(g.click(off)).toEqual([]);
    expect(g.click(blank)).toEqual([]);
    expect(g.cells).toEqual(before);
    expect(g.moves).toBe(0);
  });

  it('can be solved: undoing the shuffle by sliding always works, and then the puzzle is solved', () => {
    const g = make(9, 3, 3);
    // solve greedily with a breadth-first search over the arrangements (3 x 3 has 181440 reachable ones)
    const key = (c: number[]) => c.join(',');
    const start = [...g.cells];
    const goal = key(Array.from({ length: 9 }, (_, i) => i));
    const seen = new Map<string, string | null>([[key(start), null]]);
    let frontier = [start];
    while (!seen.has(goal) && frontier.length) {
      const next: number[][] = [];
      for (const cur of frontier) {
        const blank = cur.indexOf(8);
        for (const n of [blank - 3, blank + 3, blank - 1, blank + 1]) {
          if (n < 0 || n > 8 || (Math.abs(n - blank) === 1 && Math.floor(n / 3) !== Math.floor(blank / 3))) continue;
          const copy = [...cur];
          [copy[blank], copy[n]] = [copy[n], copy[blank]];
          if (!seen.has(key(copy))) {
            seen.set(key(copy), key(cur));
            next.push(copy);
          }
        }
      }
      frontier = next;
    }
    expect(seen.has(goal)).toBe(true);
    // replay the path with real clicks
    const path: string[] = [];
    for (let k: string | null = goal; k; k = seen.get(k) ?? null) path.push(k);
    path.reverse();
    for (const step of path.slice(1)) {
      const target = step.split(',').map(Number);
      const from = g.blank;
      const to = target.indexOf(8);
      expect(g.click(to).length).toBeGreaterThan(0);
      expect(g.blank).toBe(to);
      expect(from).not.toBe(to);
    }
    expect(g.solved).toBe(true);
    expect(g.click(0)).toEqual([]);                      // a solved puzzle stays solved
  });

  it('comes back as it was left, and refuses a state that is not a shuffle of this grid', () => {
    const a = make(7);
    a.click(a.cells.findIndex((_, i) => a.chain(i).length > 0));
    const b = make(7);
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.cells).toEqual(a.cells);
    expect(b.moves).toBe(a.moves);
    const s = a.snapshot();
    expect(() => make(7).restore({ ...s, cells: s.cells.slice(1) })).toThrow();
    expect(() => make(7).restore({ ...s, cells: s.cells.map(() => 0) })).toThrow();
  });
});
