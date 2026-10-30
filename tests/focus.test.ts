import { describe, expect, it } from 'vitest';
import { FocusGame, scramble } from '../src/core/focus';
import { focusLayout } from '../src/core/layout';
import { Rng, seedFromText } from '../src/core/rng';

/** Every pixel of the picture is covered by exactly one rectangle. */
function tilesExactly(rects: { x: number; y: number; w: number; h: number }[], w: number, h: number): boolean {
  const cover = new Uint8Array(w * h);
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) return false;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cover[y * w + x]++;
  }
  return cover.every((c) => c === 1);
}

describe('layout', () => {
  for (const [w, h] of [
    [600, 400],
    [300, 500],
    [1200, 200],
    [97, 61],
  ]) {
    for (const irregular of [false, true]) {
      for (const pieces of [6, 16, 33, 60, 200]) {
        it(`${w}x${h} ${pieces} pieces irregular=${irregular} tiles exactly`, () => {
          const rects = focusLayout(new Rng(7), w, h, pieces, irregular);
          expect(tilesExactly(rects, w, h)).toBe(true);
          expect(rects.length).toBeGreaterThan(1);
        });
      }
    }
  }

  it('irregular layouts reach the piece count on a normal photo', () => {
    expect(focusLayout(new Rng(3), 1200, 800, 40, true)).toHaveLength(40);
  });

  it('irregular layouts reach 200 pieces on a normal photo, in any proportion, and keep every piece big enough to use', () => {
    for (const [w, h] of [[1200, 800], [800, 800], [600, 400], [1000, 1500], [1920, 1080], [2400, 600]]) {
      for (let seed = 1; seed <= 5; seed++) {
        const rects = focusLayout(new Rng(seed), w, h, 200, true);
        expect(rects).toHaveLength(200);
        expect(Math.min(...rects.flatMap((r) => [r.w, r.h]))).toBeGreaterThanOrEqual(Math.max(8, Math.floor(Math.min(w, h) / 40)));
      }
    }
  });

  it('layouts up to 60 pieces are what they always were', () => {
    const r = focusLayout(new Rng(3), 1200, 800, 40, true);
    expect(r).toHaveLength(40);
    expect(Math.min(...r.flatMap((q) => [q.w, q.h]))).toBeGreaterThanOrEqual(66);        // the cut keeps pieces at least a twelfth of the short side
  });

  it('the same seed gives the same layout', () => {
    const a = focusLayout(new Rng(99), 800, 600, 25, true);
    const b = focusLayout(new Rng(99), 800, 600, 25, true);
    expect(a).toEqual(b);
  });
});

describe('scramble', () => {
  it('never returns the solved order and keeps few pieces in place', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const n of [2, 3, 6, 16, 60]) {
        const p = scramble(new Rng(seed), n);
        expect([...p].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
        const fixed = p.filter((v, i) => v === i).length;
        expect(fixed).toBeLessThan(n);
        expect(fixed).toBeLessThanOrEqual(Math.max(1, Math.floor(n / 4)));
      }
    }
  });
});

describe('FocusGame', () => {
  const make = () => new FocusGame(800, 600, { seed: seedFromText('TEST'), pieces: 12, irregular: true });

  it('starts scrambled and is reproducible from its seed', () => {
    const a = make();
    const b = make();
    expect(a.solved).toBe(false);
    expect(a.slotOf).toEqual(b.slotOf);
  });

  it('two clicks swap two pieces; clicking the chosen one again lets go', () => {
    const g = make();
    const [a, b] = [0, 1];
    const before = [g.slotOf[a], g.slotOf[b]];
    expect(g.click(a)).toBe('select');
    expect(g.click(a)).toBe('deselect');
    expect(g.click(a)).toBe('select');
    expect(g.click(b)).toBe('swap');
    expect([g.slotOf[a], g.slotOf[b]]).toEqual([before[1], before[0]]);
    expect(g.swaps).toBe(1);
    expect(g.selected).toBe(-1);
  });

  it('can be solved by swaps and then ignores clicks', () => {
    const g = make();
    for (let i = 0; i < g.count; i++) {
      if (g.slotOf[i] === i) continue;
      const j = g.slotOf.indexOf(i); // the piece sitting where piece i belongs
      g.click(i);
      g.click(j);
    }
    expect(g.solved).toBe(true);
    expect(g.click(0)).toBe('none');
  });

  it('finds the piece under a point', () => {
    const g = make();
    for (let i = 0; i < g.count; i++) {
      const r = g.slotRect(i);
      expect(g.pieceAt(r.x + r.w / 2, r.y + r.h / 2)).toBe(i);
    }
    expect(g.pieceAt(-5, -5)).toBe(-1);
  });
});
