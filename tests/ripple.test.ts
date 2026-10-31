import { describe, expect, it } from 'vitest';
import { GroupRipple } from '../src/sessions/ripple';

describe('GroupRipple', () => {
  const cols = 10;
  const size = 50;
  const members = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it('starts at the pieces that were put down and travels outward, lighting each piece in turn', () => {
    const r = new GroupRipple();
    r.start(7, members, [0], cols, size, 1000);
    expect(r.step(1000 + 60)).toBe(true);
    expect(r.ks[0]).toBeGreaterThan(0);                           // the first piece is lit at once ...
    expect(r.ks[9]).toBe(0);                                      // ... and the far end has not been reached
    let reachedFarEnd = false;
    for (let t = 1000; t < 3000; t += 16) {
      if (!r.step(t)) break;
      if (r.ks[9] > 0.5) reachedFarEnd = true;
      expect(Math.max(...r.ks)).toBeLessThanOrEqual(1);
      expect(Math.min(...r.ks)).toBeGreaterThanOrEqual(0);
    }
    expect(reachedFarEnd).toBe(true);
  });

  it('is over within about a second however many pieces are locked together, and then forgets the group', () => {
    const r = new GroupRipple();
    const many = Array.from({ length: 400 }, (_, i) => i);
    r.start(3, many, [0], 20, size, 0);
    expect(r.step(1200)).toBe(false);
    expect(r.gid).toBe(-1);
    expect(r.members).toEqual([]);
  });

  it('a single piece just glows and fades', () => {
    const r = new GroupRipple();
    r.start(1, [4], [4], cols, size, 0);
    expect(r.step(150)).toBe(true);
    expect(r.ks[0]).toBeGreaterThan(0.5);
    expect(r.step(600)).toBe(false);
  });
});
