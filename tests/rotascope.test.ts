import { describe, expect, it } from 'vitest';
import { RotascopeGame } from '../src/core/rotascope';

const make = (rings = 3, wedges = 5, seed = 1) => new RotascopeGame(rings, wedges, seed);

describe('RotascopeGame geometry', () => {
  it('has rings x wedges pieces round an empty middle, each ring a fixed number of times wider than the one inside it', () => {
    const g = make(3, 5);
    expect(g.cells).toBe(16);
    expect(g.centre).toBe(15);
    expect(g.boundary(3)).toBeCloseTo(1);
    expect(g.boundary(0)).toBeCloseTo(0.14);
    for (let k = 0; k < 3; k++) expect(g.boundary(k + 1) / g.boundary(k)).toBeCloseTo(g.ratio);
    expect(g.ratio).toBeGreaterThan(1);
  });

  it('knows which cells touch: along a ring (all the way round), between rings, and the middle with every wedge of ring 0 only', () => {
    for (const [rings, wedges] of [[2, 3], [3, 5], [4, 6], [6, 12]]) {
      const g = make(rings, wedges);
      let edges = 0;
      for (let a = 0; a < g.cells; a++) for (let b = a + 1; b < g.cells; b++) if (g.adjacent(a, b)) edges++;
      expect(edges).toBe(rings * wedges + (rings - 1) * wedges + wedges);        // round the rings, between them, middle to ring 0
      for (let a = 0; a < g.cells; a++) for (const b of g.neighbours(a)) expect(g.adjacent(b, a)).toBe(true);
      expect(g.neighbours(g.centre).sort((x, y) => x - y)).toEqual(Array.from({ length: wedges }, (_, c) => c));
      expect(g.adjacent(g.cellId(0, 0), g.cellId(0, wedges - 1))).toBe(true);        // the ring closes
      if (rings > 2) expect(g.adjacent(g.cellId(0, 0), g.cellId(2, 0))).toBe(false);
    }
  });

  it('finds the cell under a point: every wedge\'s middle maps back to it', () => {
    const g = make(4, 7);
    for (let cell = 0; cell < g.centre; cell++) {
      const ring = g.ringOf(cell);
      const rho = Math.sqrt(g.boundary(ring) * g.boundary(ring + 1));
      const angle = g.startAngle(g.colOf(cell)) + g.step / 2;
      expect(g.cellAt(rho, angle)).toBe(cell);
      expect(g.cellAt(rho, angle + 360)).toBe(cell);
      expect(g.cellAt(rho, angle - 720)).toBe(cell);
    }
    expect(g.cellAt(0.01, 123)).toBe(g.centre);
    expect(g.cellAt(1.01, 0)).toBe(-1);
  });
});

describe('RotascopeGame play', () => {
  it('starts shuffled with every piece present and one empty cell, reproducibly, and never solved', () => {
    const g = make(3, 5, 4);
    expect(g.solved).toBe(false);
    expect([...g.content].sort((a, b) => a - b)).toEqual([-1, ...Array.from({ length: 15 }, (_, i) => i)]);
    expect(make(3, 5, 4).content).toEqual(g.content);
    expect(make(3, 5, 5).content).not.toEqual(g.content);
    for (let seed = 1; seed < 40; seed++) expect(make(2, 3, seed).solved).toBe(false);
  });

  it('slides a piece next to the empty cell into it, and ignores any other click', () => {
    const g = make(3, 5, 8);
    const blank = g.blank;
    const far = [...Array(g.cells).keys()].find((i) => i !== blank && !g.adjacent(i, blank))!;
    const before = [...g.content];
    expect(g.click(far)).toBeNull();
    expect(g.click(blank)).toBeNull();
    expect(g.content).toEqual(before);
    const near = g.neighbours(blank)[0];
    const piece = g.content[near];
    expect(g.click(near)).toEqual({ piece, from: near, to: blank });
    expect(g.content[blank]).toBe(piece);
    expect(g.blank).toBe(near);
    expect(g.moves).toBe(1);
  });

  it('can be solved: a breadth-first search finds the way back and real clicks follow it', () => {
    const g = make(2, 3, 11);                                    // 7 cells, 6 pieces: small enough to search everything
    const key = (c: number[]) => c.join(',');
    const goal = key(Array.from({ length: 7 }, (_, i) => (i === 6 ? -1 : i)));
    const seen = new Map<string, string | null>([[key(g.content), null]]);
    let frontier = [[...g.content]];
    while (!seen.has(goal) && frontier.length) {
      const next: number[][] = [];
      for (const cur of frontier) {
        const blank = cur.indexOf(-1);
        for (const n of g.neighbours(blank)) {
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
    const path: string[] = [];
    for (let k: string | null = goal; k; k = seen.get(k) ?? null) path.push(k);
    path.reverse();
    for (const step of path.slice(1)) {
      const to = step.split(',').map(Number).indexOf(-1);       // the empty cell moves to where the piece came from
      expect(g.click(to)).not.toBeNull();
    }
    expect(g.solved).toBe(true);
    expect(g.click(0)).toBeNull();
  });

  it('comes back as it was left, and refuses a state that does not fit', () => {
    const a = make(3, 5, 7);
    a.click(a.neighbours(a.blank)[0]);
    const b = make(3, 5, 7);
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    expect(b.content).toEqual(a.content);
    expect(b.moves).toBe(1);
    const s = a.snapshot();
    expect(() => make(3, 5, 7).restore({ ...s, content: s.content.slice(1) })).toThrow();
    expect(() => make(3, 5, 7).restore({ ...s, content: s.content.map(() => 0) })).toThrow();
    expect(() => make(2, 5, 7).restore(s)).toThrow();
  });
});
