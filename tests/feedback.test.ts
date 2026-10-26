import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lift, LIFT_CSS, LIFT_MS, startLift } from '../src/sessions/feedback';
import type { SessionInit } from '../src/sessions/types';

afterEach(() => vi.unstubAllGlobals());

const view = { scale: 2, ox: 0, oy: 0 };
const init = (offset: boolean) => ({ flag: (k: string) => (k === 'offset' ? offset : true) }) as unknown as SessionInit;

describe('Lift', () => {
  it('rises over a short time to its distance above the finger, and never goes past it', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const lift = new Lift(40, 1000);
    expect(lift.held({ x: 10, y: 500 }, 1000, view)).toEqual({ x: 10, y: 500 });
    const half = lift.held({ x: 10, y: 500 }, 1000 + LIFT_MS / 2, view);
    expect(half.y).toBeGreaterThan(460);
    expect(half.y).toBeLessThan(500);
    expect(lift.held({ x: 10, y: 500 }, 1000 + LIFT_MS, view)).toEqual({ x: 10, y: 460 });
    expect(lift.held({ x: 10, y: 500 }, 99999, view)).toEqual({ x: 10, y: 460 });
    expect(lift.done(1000 + LIFT_MS - 1)).toBe(false);
    expect(lift.done(1000 + LIFT_MS)).toBe(true);
  });

  it('keeps the piece on the screen when the finger is near the top: 24 css pixels down, or the finger itself if that is higher', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    const lift = new Lift(40, 0);
    // the top margin is 24 css pixels = 48 canvas pixels = 24 board units at scale 2, from a board whose top is at the canvas top
    expect(lift.held({ x: 0, y: 30 }, 999, view).y).toBe(24);
    expect(lift.held({ x: 0, y: 10 }, 999, view).y).toBe(10);
    expect(lift.held({ x: 0, y: 200 }, 999, view).y).toBe(160);
  });
});

describe('startLift', () => {
  it('only for a finger, and only when the player has not turned it off; the distance is in screen pixels whatever the zoom', () => {
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(startLift(init(true), false, view, 0)).toBeNull();
    expect(startLift(init(false), true, view, 0)).toBeNull();
    const lift = startLift(init(true), true, view, 0)!;
    expect(lift.distance).toBeCloseTo((LIFT_CSS * 3) / 2);
    expect(startLift(init(true), true, { scale: 0.5, ox: 0, oy: 0 }, 0)!.distance).toBeCloseTo((LIFT_CSS * 3) / 0.5);
  });
});
