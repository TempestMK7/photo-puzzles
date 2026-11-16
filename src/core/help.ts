import type { KindDef, KindId } from './kinds';

/**
 * Hints and bombs: a player's own stock of them (kept on their account) places pieces for them. A hint places one piece; a bomb, dropped on the board, places every piece that lies
 * the nearest to a point (see `BOMB_PIECES`). They are for the puzzles in which a piece placed for the player can never leave the puzzle unsolvable: not Sliding Tiles or Rotascope, where
 * the pieces have to be moved in an order that fits (half of all arrangements cannot be solved), and so one piece put in place by hand could make the rest impossible.
 */
export type HelpKind = 'hint' | 'bomb';

export const HELP_KINDS: readonly HelpKind[] = ['hint', 'bomb'];

/** The puzzles that have them. */
export function hasHelp(kind: KindId | string): boolean {
  return kind === 'focus' || kind === 'overlap' || kind === 'strips' || kind === 'jigsaw';
}

/** What a bomb places in every kind of puzzle: the pieces not yet in place that are nearest to the point it falls on (fewer only when fewer are left). */
export const BOMB_PIECES = 8;

/** How far the point (x, y) is from the rectangle (0 when it is inside). */
export function rectDistance(rx: number, ry: number, rw: number, rh: number, x: number, y: number): number {
  const dx = Math.max(rx - x, 0, x - (rx + rw));
  const dy = Math.max(ry - y, 0, y - (ry + rh));
  return Math.hypot(dx, dy);
}

/**
 * The pieces that a bomb at (x, y) places: of `pieces` (those not in place yet, each with the rectangle of its place) the `BOMB_PIECES` nearest to the point, nearest first. A piece's distance
 * is the distance to its rectangle, and of two at the same distance the one whose middle is nearer goes first (then the one that comes first in `pieces`), so that the same board and the
 * same point always name the same pieces, on every screen and on the server.
 */
export function nearestToBomb<T extends { id: number; x: number; y: number; w: number; h: number }>(pieces: T[], x: number, y: number): number[] {
  return pieces
    .map((p, order) => ({ id: p.id, d: rectDistance(p.x, p.y, p.w, p.h, x, y), c: Math.hypot(p.x + p.w / 2 - x, p.y + p.h / 2 - y), order }))
    .sort((a, b) => a.d - b.d || a.c - b.c || a.order - b.order)
    .slice(0, BOMB_PIECES)
    .map((p) => p.id);
}

/** Hints a solved puzzle gives: one for a small puzzle (S and M), two for a bigger one. */
export const HINTS_SMALL = 1;
export const HINTS_LARGE = 2;

/** What a puzzle of this kind and size gives when it is solved (`opts` hold what the size sets, as the sessions read them: for a puzzle played with friends, the numbers it was made with). */
export function hintsFor(kind: KindDef, opts: Record<string, number>): number {
  const sizes = kind.sizes?.values;
  if (!sizes || sizes.length < 2) return HINTS_SMALL;
  const key = Object.keys(sizes[0])[0];
  return opts[key] <= sizes[1][key] ? HINTS_SMALL : HINTS_LARGE;
}
