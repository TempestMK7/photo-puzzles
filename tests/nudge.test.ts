import { describe, expect, it } from 'vitest';
import { NUDGES_PER_PUZZLE, STUCK_MS, stuckNudge } from '../src/core/nudge';

const s = (more: Partial<Parameters<typeof stuckNudge>[0]> = {}) => stuckNudge({ idleMs: STUCK_MS, nudges: 0, hints: 5, bombs: 1, adReady: true, ...more });

describe('who is shown the hint or bomb button', () => {
  it('nobody who has made progress lately', () => {
    expect(s({ idleMs: 0 })).toBeNull();
    expect(s({ idleMs: STUCK_MS - 1 })).toBeNull();
    expect(s({ idleMs: STUCK_MS })).toBe('hint');
  });

  it('the hint first, then the bomb, then the hint again, and no more than three in a puzzle', () => {
    expect(s({ nudges: 0 })).toBe('hint');
    expect(s({ nudges: 1 })).toBe('bomb');
    expect(s({ nudges: 2 })).toBe('hint');
    expect(NUDGES_PER_PUZZLE).toBe(3);
    expect(s({ nudges: 3 })).toBeNull();
  });

  it('only what the player has: no bomb to point at, or no hint', () => {
    expect(s({ nudges: 1, bombs: 0 })).toBe('hint');
    expect(s({ nudges: 0, hints: 0 })).toBe('bomb');
    expect(s({ nudges: 1, hints: 0, bombs: 0 })).toBe('ad');
  });

  it('the ad for more when nothing is left and one can be watched, else nothing', () => {
    expect(s({ hints: 0, bombs: 0 })).toBe('ad');
    expect(s({ hints: 0, bombs: 0, adReady: false })).toBeNull();
  });
});
