import type { Rng } from './rng';

/**
 * The cells of a board that start filled in: `count` of the cells that `eligible` allows (as indexes, row by row), in four patches, one round the centre of each quarter of the board. Each patch
 * takes the free cells nearest to its centre (a little scattered, so that its edge is ragged) and has a quarter of the count (the first patches one more when it does not divide). Fewer
 * come back if there are not as many cells to choose from. Nothing is drawn from `rng` when `count` is 0.
 */
export function prefillPatches(rng: Rng, cols: number, rows: number, eligible: (x: number, y: number) => boolean, count: number): number[] {
  const cells: number[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (eligible(x, y)) cells.push(y * cols + x);
  const n = Math.min(Math.floor(count), cells.length);
  if (n <= 0) return [];
  const centres = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([fx, fy]) => ({ x: fx * cols, y: fy * rows }));
  const taken = new Set<number>();
  const out: number[] = [];
  centres.forEach((centre, q) => {
    const share = Math.floor(n / 4) + (q < n % 4 ? 1 : 0);
    if (share <= 0) return;
    const ranked = cells
      .filter((c) => !taken.has(c))
      .map((c) => ({ c, d: Math.hypot((c % cols) + 0.5 - centre.x, Math.floor(c / cols) + 0.5 - centre.y) + (rng.below(100) / 100) * 1.5 }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < share && i < ranked.length; i++) {
      taken.add(ranked[i].c);
      out.push(ranked[i].c);
    }
  });
  return out;
}

/** Puts `percent` of `count` pieces in place at the start, picked at random (`place` does it for one piece): never all of them, and none when `percent` is 0 (nothing is drawn from `rng` then). */
export function placeAtRandom(count: number, rng: Rng, percent: number, place: (id: number) => void): void {
  const want = Math.min(count - 1, Math.round((count * Math.min(100, Math.max(0, percent))) / 100));
  if (want <= 0) return;
  const ids = Array.from({ length: count }, (_, i) => i);
  for (let k = 0; k < want; k++) {                                // the first `want` of a shuffle
    const j = k + rng.below(count - k);
    [ids[k], ids[j]] = [ids[j], ids[k]];
    place(ids[k]);
  }
}
