import type { KindDef, KindId } from './kinds';

/**
 * Hints and bombs: a player's own stock of them (kept on their account) places pieces for them. A hint places one piece; a bomb, dropped on the board, places every piece that lies
 * round the point (see `BLAST`). They are for the puzzles in which a piece placed for the player can never leave the puzzle unsolvable: not Sliding Tiles or Rotascope, where
 * the pieces have to be moved in an order that fits (half of all arrangements cannot be solved), and so one piece put in place by hand could make the rest impossible.
 */
export type HelpKind = 'hint' | 'bomb';

export const HELP_KINDS: readonly HelpKind[] = ['hint', 'bomb'];

/** The puzzles that have them. */
export function hasHelp(kind: KindId | string): boolean {
  return kind === 'focus' || kind === 'overlap' || kind === 'strips' || kind === 'jigsaw';
}

/** How far a bomb reaches, in cells (a piece of a Jigsaw, a cell of Overlap or Strips, about one piece of Tile Swap): every piece that has a cell closer than this to the point is placed. */
export const BLAST = 1;

/** Whether the rectangle comes within `r` of the point (x, y). */
export function nearPoint(rx: number, ry: number, rw: number, rh: number, x: number, y: number, r = BLAST): boolean {
  const dx = Math.max(rx - x, 0, x - (rx + rw));
  const dy = Math.max(ry - y, 0, y - (ry + rh));
  return dx * dx + dy * dy < r * r;
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
