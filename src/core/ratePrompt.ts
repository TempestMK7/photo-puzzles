/** The player is not asked to rate the app before they have solved this many puzzles. */
export const RATE_AFTER_SOLVED = 3;
/** After being asked and putting it off, the player is not asked again for this long. */
export const RATE_AGAIN_MS = 3 * 24 * 60 * 60 * 1000;

/** What this device remembers for the "Rate Me!" prompt. */
export interface RateState {
  /** Puzzles solved here (alone or with friends). */
  solved: number;
  /** When the player was last shown the prompt (ms since 1970), or null if never. */
  asked: number | null;
  /** The player pressed Rate Me! (they went to the store: they are not asked again). */
  rated: boolean;
}

export const NO_RATING: RateState = { solved: 0, asked: null, rated: false };

/** Whether to show the prompt now: after enough solved puzzles, never again once the player went to rate, and not within three days of the last time it was shown. */
export function shouldAskToRate(s: RateState, now: number): boolean {
  if (s.rated || s.solved < RATE_AFTER_SOLVED) return false;
  return s.asked === null || now - s.asked >= RATE_AGAIN_MS || now < s.asked;
}
