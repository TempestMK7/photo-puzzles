/** A player who has made no progress for this long is taken for stuck: the Hint (or Bomb) button is pointed out. */
export const STUCK_MS = 75 * 1000;
/** Most nudges in one puzzle (each comes after another stretch of no progress, so a player who ignores them is left alone). */
export const NUDGES_PER_PUZZLE = 3;

export type Nudge = 'hint' | 'bomb' | 'ad';

/**
 * What to point out to a player who has been stuck for `idleMs` (no progress, and no earlier nudge, since), or nothing. The first nudge is the hint, the second the bomb (a patch of pieces: it
 * is a step up from one piece), then the hint again; with none of the help left it is the ad for more, when one can be watched. `hints` and `bombs` count what the player may use now.
 */
export function stuckNudge(s: { idleMs: number; nudges: number; hints: number; bombs: number; adReady: boolean }): Nudge | null {
  if (s.idleMs < STUCK_MS || s.nudges >= NUDGES_PER_PUZZLE) return null;
  if (s.nudges % 2 === 1 && s.bombs > 0) return 'bomb';
  if (s.hints > 0) return 'hint';
  if (s.bombs > 0) return 'bomb';
  return s.adReady ? 'ad' : null;
}
