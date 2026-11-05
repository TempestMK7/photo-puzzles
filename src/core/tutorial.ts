/** What the player has been shown: the kinds of puzzle whose How To Play they have opened, and the steps of the walk through hints, bombs and ads that they have taken. */
export interface Progress {
  howto: string[];
  hint: boolean;
  bomb: boolean;
  ad: boolean;
}

export type Step = 'howto' | 'hint' | 'bomb' | 'ad';

/** What is true of the player and the puzzle on the screen at the moment. */
export interface Situation {
  /** Hints and bombs can be used in this puzzle by this player (the puzzle has them, the account is signed in, the host allowed them). */
  helpers: boolean;
  hints: number;
  bombs: number;
  /** An ad for hints or a bomb can be watched (or, for a paid account, taken) now. */
  adReady: boolean;
}

export const NO_PROGRESS: Progress = { howto: [], hint: false, bomb: false, ad: false };

/**
 * What the screen should point out next, or nothing. The button of How To Play comes first, until it has been pressed once in any puzzle; then the first hint and the first bomb, one
 * after the other (a step is skipped while the player has none of that item: there is nothing to try); and once both have been used (or the player has run out of both after trying
 * one) the ad for more, which is only pointed out while one can be watched.
 */
export function nextStep(p: Progress, s: Situation): Step | null {
  if (p.howto.length === 0) return 'howto';
  if (!s.helpers) return null;
  if (!p.hint && s.hints > 0) return 'hint';
  if (!p.bomb && s.bombs > 0) return 'bomb';
  const tried = (p.hint && p.bomb) || ((p.hint || p.bomb) && s.hints < 1 && s.bombs < 1);
  if (tried && !p.ad && s.adReady) return 'ad';
  return null;
}

/** Whether the How To Play button of this kind of puzzle should glow: it has never been pressed there. */
export const howtoNew = (p: Progress, kind: string): boolean => !p.howto.includes(kind);
