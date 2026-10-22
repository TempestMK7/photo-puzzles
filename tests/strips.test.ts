import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { boxOf, generateStrips, MARGIN, StripsGame } from '../src/core/strips';

const make = (seed: number, strips = 14, maxLen = 8, placed = 20, picCols = 16, picRows = 12) =>
  generateStrips(new Rng(seed), { picCols, picRows, strips, maxLen, placed });

describe('generateStrips', () => {
  it('cuts strips of the allowed lengths inside the picture, none along another, and is reproducible', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const maxLen = 3 + (seed % 9);
      const s = make(seed, 6 + (seed % 20), maxLen);
      expect(s.defs.length).toBeGreaterThan(3);
      const owner = new Map<string, number[]>();
      for (const d of s.defs) {
        expect(d.len >= 3 && d.len <= maxLen).toBe(true);
        const b = boxOf(d, 0);
        expect(d.hx >= MARGIN && d.hy >= MARGIN && d.hx + b.w <= MARGIN + s.picCols && d.hy + b.h <= MARGIN + s.picRows).toBe(true);
        for (let dy = 0; dy < b.h; dy++) {
          for (let dx = 0; dx < b.w; dx++) {
            const k = `${d.hx + dx},${d.hy + dy}`;
            owner.set(k, [...(owner.get(k) ?? []), d.id]);
          }
        }
      }
      for (const ids of owner.values()) if (ids.length > 1) expect(new Set(ids.map((i) => s.defs[i].horizontal)).size).toBe(ids.length);
      expect(make(seed, 6 + (seed % 20), maxLen)).toEqual(s);
    }
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

describe('StripsGame', () => {
  it('can be solved: turn each strip to its home angle, put it on its home', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = new StripsGame(make(seed, 10 + (seed % 10)));
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
    expect(g.stripAt(d.hx, d.hy)).not.toBe(id);
    g.moveTo(id, 0, 0);
    expect(g.state[id].x).toBe(d.hx);
  });

  it('picks the front-most strip', () => {
    const g = new StripsGame(make(10, 20, 8, 0));
    g.moveTo(1, g.state[0].x, g.state[0].y);
    g.state[1].angle = g.state[0].angle;
    g.state[1].x = g.state[0].x;
    g.state[1].y = g.state[0].y;
    g.bringToFront(0);
    expect(g.stripAt(g.state[0].x, g.state[0].y)).toBe(0);
    g.bringToFront(1);
    expect(g.stripAt(g.state[0].x, g.state[0].y)).toBe(1);
  });
});
