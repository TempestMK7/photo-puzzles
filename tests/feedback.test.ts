import { afterEach, describe, expect, it, vi } from 'vitest';
import { CASCADE_MS, cascadeStep, Lift, LIFT_CSS, LIFT_MS, nearestFirst, rippleColor, startLift } from '../src/sessions/feedback';
import type { SessionInit } from '../src/sessions/types';

afterEach(() => vi.unstubAllGlobals());

const view = { scale: 2, ox: 0, oy: 0 };
const init = (offset: boolean) => ({ flag: (k: string) => (k === 'offset' ? offset : true) }) as unknown as SessionInit;

describe('Lift', () => {
  it('rises over a short time to its distance above the finger, and never goes past it', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const lift = new Lift(40, 1000);
    expect(lift.held({ x: 10, y: 500 }, 1000)).toEqual({ x: 10, y: 500 });
    const half = lift.held({ x: 10, y: 500 }, 1000 + LIFT_MS / 2);
    expect(half.y).toBeGreaterThan(460);
    expect(half.y).toBeLessThan(500);
    expect(lift.held({ x: 10, y: 500 }, 1000 + LIFT_MS)).toEqual({ x: 10, y: 460 });
    expect(lift.held({ x: 10, y: 500 }, 99999)).toEqual({ x: 10, y: 460 });
    expect(lift.done(1000 + LIFT_MS - 1)).toBe(false);
    expect(lift.done(1000 + LIFT_MS)).toBe(true);
  });

  it('does not keep the piece on the screen: with the finger near the top it goes up past the edge, so that a piece can be put on the top edge', () => {
    const lift = new Lift(40, 0);
    expect(lift.held({ x: 0, y: 30 }, 999).y).toBe(-10);
    expect(lift.held({ x: 0, y: 10 }, 999).y).toBe(-30);
    expect(lift.held({ x: 0, y: 200 }, 999).y).toBe(160);
  });
});

describe('startLift', () => {
  it('for a finger and for a mouse alike, when the player has not turned it off; the distance is in screen pixels whatever the zoom', () => {
    vi.stubGlobal('window', { devicePixelRatio: 3 });
    expect(startLift(init(false), false, view, 0)).toBeNull();
    expect(startLift(init(false), true, view, 0)).toBeNull();
    expect(startLift(init(true), false, view, 0)!.distance).toBeCloseTo((LIFT_CSS * 3) / 2);          // (a mouse: the piece is held above the pointer too)
    const lift = startLift(init(true), true, view, 0)!;
    expect(lift.distance).toBeCloseTo((LIFT_CSS * 3) / 2);
    expect(startLift(init(true), true, { scale: 0.5, ox: 0, oy: 0 }, 0)!.distance).toBeCloseTo((LIFT_CSS * 3) / 0.5);
  });
});

describe('the cascade of a bomb', () => {
  it('places a piece every 0.2 seconds, and slows down for many so that the whole is over within three seconds', () => {
    expect(CASCADE_MS).toBe(200);
    expect(cascadeStep(1)).toBe(200);
    expect(cascadeStep(6)).toBe(200);
    expect(cascadeStep(16)).toBe(200);
    expect(cascadeStep(31)).toBeCloseTo(100);
    expect(cascadeStep(100) * 99).toBeLessThanOrEqual(3000);
  });

  it('goes from the piece nearest to the bomb outward', () => {
    const at = (p: { x: number; y: number }) => p;
    const pts = [{ x: 9, y: 0 }, { x: 1, y: 0 }, { x: 4, y: 0 }];
    expect(nearestFirst(pts, 0, 0, at)).toEqual([{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 9, y: 0 }]);
    expect(pts[0]).toEqual({ x: 9, y: 0 });                       // (the list given is left as it was)
  });
});

describe('the colour of a ripple', () => {
  const colors: Record<string, string> = { me: '#ffd84a', ann: '#4ac8ff' };
  const online = { self: 'me', colorOf: (id: string) => colors[id] };

  it('is the colour of the player who put the piece there: this player when nobody is named, another when named', () => {
    const together = { online } as unknown as SessionInit;
    expect(rippleColor(together)).toBe('#ffd84a');
    expect(rippleColor(together, 'ann')).toBe('#4ac8ff');
  });

  it('is none (the ripple has its own) when the puzzle is played alone', () => {
    expect(rippleColor({} as SessionInit)).toBeUndefined();
    expect(rippleColor({} as SessionInit, 'ann')).toBeUndefined();
  });
});
