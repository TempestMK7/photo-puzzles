import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { boxOf, generateStrips, MARGIN, pictureSize, StripsGame } from '../src/core/strips';

const make = (seed: number, picCols = 16, picRows = 11, maxLen = 8, placed = 20, tabs = 3) => generateStrips(new Rng(seed), { picCols, picRows, maxLen, placed, tabs });

/** Which strips cover each picture cell. */
function owners(s: ReturnType<typeof make>): number[][] {
  const out: number[][] = Array.from({ length: s.picCols * s.picRows }, () => []);
  for (const d of s.defs) {
    const b = boxOf(d, 0);
    for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) out[(d.hy - MARGIN + dy) * s.picCols + d.hx - MARGIN + dx].push(d.id);
  }
  return out;
}

describe('pictureSize', () => {
  it('gives the cells across and as many rows as the photo needs', () => {
    expect(pictureSize(1200, 800, 16)).toEqual({ picCols: 16, picRows: 11 });
    expect(pictureSize(800, 1200, 12)).toEqual({ picCols: 12, picRows: 18 });
    expect(pictureSize(1000, 1000, 20)).toEqual({ picCols: 20, picRows: 20 });
    expect(pictureSize(4000, 100, 10).picRows).toBeGreaterThanOrEqual(4);
  });
});

describe('generateStrips', () => {
  it('covers every cell of the picture, and every strip covers a cell that no other strip covers', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const picCols = 6 + (seed % 20);
      const picRows = 5 + ((seed * 7) % 14);
      const maxLen = 3 + (seed % 10);
      const s = make(seed, picCols, picRows, maxLen);
      const o = owners(s);
      expect(o.every((ids) => ids.length >= 1)).toBe(true);
      for (const d of s.defs) expect(o.some((ids) => ids.length === 1 && ids[0] === d.id)).toBe(true);
    }
  });

  it('keeps strips inside the picture and between 3 cells and the longest allowed, and is reproducible', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const maxLen = 3 + (seed % 9);
      const s = make(seed, 16, 12, maxLen);
      for (const d of s.defs) {
        expect(d.len >= 3 && d.len <= maxLen).toBe(true);
        const b = boxOf(d, 0);
        expect(d.hx >= MARGIN && d.hy >= MARGIN && d.hx + b.w <= MARGIN + s.picCols && d.hy + b.h <= MARGIN + s.picRows).toBe(true);
      }
      expect(make(seed, 16, 12, maxLen)).toEqual(s);
    }
  });

  it('works out how many strips it takes: more cells, more strips; longer strips, fewer', () => {
    const count = (cols: number, rows: number, maxLen: number) => {
      let total = 0;
      for (let seed = 1; seed <= 8; seed++) total += make(seed, cols, rows, maxLen, 0).defs.length;
      return total / 8;
    };
    expect(count(24, 16, 8)).toBeGreaterThan(count(12, 8, 8));
    expect(count(20, 14, 12)).toBeLessThan(count(20, 14, 4));
    expect(count(40, 27, 8)).toBeGreaterThan(60);
  });

  it('mostly keeps strips from lying along each other', () => {
    let parallel = 0;
    let pairs = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = make(seed, 20, 14, 8);
      for (const ids of owners(s)) {
        if (ids.length < 2) continue;
        pairs++;
        if (new Set(ids.map((i) => s.defs[i].horizontal)).size < ids.length) parallel++;
      }
    }
    expect(pairs).toBeGreaterThan(0);
    expect(parallel / pairs).toBeLessThan(0.25);
  });

  it('puts loose strips inside the field and never already home; some start placed', () => {
    const s = make(7);
    let placed = 0;
    s.defs.forEach((d, i) => {
      const st = s.state[i];
      const b = boxOf(d, st.angle);
      expect(st.x >= 0 && st.y >= 0 && st.x + b.w <= s.cols && st.y + b.h <= s.rows).toBe(true);
      if (st.locked) placed++;
      else expect(st.angle === 0 && st.x === d.hx && st.y === d.hy).toBe(false);
    });
    expect(placed).toBeGreaterThan(0);
    expect(new StripsGame(s).solved).toBe(false);
  });
});

describe('tabs', () => {
  it('spreads the loose strips over the tabs at random, none outside them', () => {
    for (const tabs of [1, 3, 10]) {
      const s = make(11, 22, 16, 8, 20, tabs);
      expect(s.tabs).toBe(tabs);
      const used = new Set(s.state.filter((st) => !st.locked).map((st) => st.tab));
      for (const t of used) expect(t >= 0 && t < tabs).toBe(true);
      if (tabs > 1) expect(used.size).toBeGreaterThan(1);
      else expect(used.size).toBe(1);
    }
    expect(make(12, 22, 16, 8, 20, 5)).toEqual(make(12, 22, 16, 8, 20, 5));
  });

  it('only the strips of the tab being shown can be picked, and they can be moved to another tab', () => {
    const g = new StripsGame(make(13, 16, 12, 8, 0, 3));
    const id = g.defs.findIndex((_, i) => g.state[i].tab === 0);
    const s = g.state[id];
    expect(g.stripAt(s.x, s.y, 0)).not.toBe(-1);
    expect(g.stripAt(s.x, s.y, 1)).not.toBe(id);
    g.moveToTab(id, 2);
    expect(g.state[id].tab).toBe(2);
    expect(g.stripAt(s.x, s.y, 2)).not.toBe(-1);
    expect(g.looseCounts().reduce((a, b) => a + b, 0)).toBe(g.total);
  });
});

describe('StripsGame', () => {
  it('can be solved: turn each strip to its home angle, put it on its home', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = new StripsGame(make(seed, 10 + (seed % 10), 8 + (seed % 5)));
      for (const d of g.defs) {
        if (g.state[d.id].locked) continue;
        while (g.state[d.id].angle !== 0) g.rotate(d.id);
        g.moveTo(d.id, d.hx, d.hy);
        expect(g.lockIfHome(d.id) || g.state[d.id].locked).toBe(true);
      }
      expect(g.solved).toBe(true);
    }
  });

  it('a strip stays inside the field and four quarter turns bring it back', () => {
    const g = new StripsGame(make(8));
    const id = g.defs.findIndex((d, i) => !g.state[i].locked && d.len >= 5);
    g.moveTo(id, g.cols + 10, g.rows + 10);
    for (let i = 0; i < 4; i++) {
      g.rotate(id);
      const s = g.state[id];
      const b = boxOf(g.defs[id], s.angle);
      expect(s.x >= 0 && s.y >= 0 && s.x + b.w <= g.cols && s.y + b.h <= g.rows).toBe(true);
    }
    g.moveTo(id, 8, 6);
    const start = { ...g.state[id] };
    for (let i = 0; i < 4; i++) g.rotate(id);
    expect(g.state[id]).toEqual(start);
  });

  it('locks only at home with the right turn; a locked strip cannot be picked up or moved', () => {
    const g = new StripsGame(make(9));
    const id = g.defs.findIndex((_, i) => !g.state[i].locked);
    const d = g.defs[id];
    g.state[id].angle = 2;
    g.moveTo(id, d.hx, d.hy);
    expect(g.lockIfHome(id)).toBe(false); // right place, upside down
    g.state[id].angle = 0;
    g.moveTo(id, d.hx, d.hy);
    expect(g.lockIfHome(id)).toBe(true);
    expect(g.stripAt(d.hx, d.hy, g.state[id].tab)).not.toBe(id);
    g.moveTo(id, 0, 0);
    expect(g.state[id].x).toBe(d.hx);
  });

  it('picks the front-most strip', () => {
    const g = new StripsGame(make(10, 16, 12, 8, 0, 1));
    g.state[1].angle = g.state[0].angle;
    g.state[1].x = g.state[0].x;
    g.state[1].y = g.state[0].y;
    g.bringToFront(0);
    expect(g.stripAt(g.state[0].x, g.state[0].y, 0)).toBe(0);
    g.bringToFront(1);
    expect(g.stripAt(g.state[0].x, g.state[0].y, 0)).toBe(1);
  });
});
