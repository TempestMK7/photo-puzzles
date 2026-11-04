import { describe, expect, it } from 'vitest';
import { pickTurn } from '../src/sessions/videoTurn';

describe('pickTurn', () => {
  it('takes no turn when the texture already looks like the picture', () => {
    expect(pickTurn([3, 900, 1200, 880])).toBe(0);
  });

  it('takes the turn that makes the texture look like the picture', () => {
    expect(pickTurn([900, 4, 1100, 950])).toBe(1);
    expect(pickTurn([900, 950, 1100, 7])).toBe(3);
    expect(pickTurn([2500, 1800, 20, 2000])).toBe(2);
  });

  it('takes none when no turn is clearly better than none (a picture that looks alike turned)', () => {
    expect(pickTurn([500, 480, 520, 495])).toBe(0);
  });
});
