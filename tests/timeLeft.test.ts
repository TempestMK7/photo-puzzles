import { describe, expect, it } from 'vitest';
import { timeLeft } from '../src/ui/online';

describe('timeLeft', () => {
  const now = 1_000_000_000;
  const min = 60_000;

  it('says minutes up to an hour, hours up to two days, and days after that', () => {
    expect(timeLeft(now + 5 * min, now)).toBe('5 min');
    expect(timeLeft(now + 59 * min, now)).toBe('59 min');
    expect(timeLeft(now + 90 * min, now)).toBe('about 2 h');
    expect(timeLeft(now + 24 * 60 * min, now)).toBe('about 24 h');
    expect(timeLeft(now + 3 * 24 * 60 * min, now)).toBe('about 3 days');
  });

  it('does not say zero or less', () => {
    expect(timeLeft(now + 20_000, now)).toBe('under a minute');
    expect(timeLeft(now - 5 * min, now)).toBe('under a minute');
  });
});
