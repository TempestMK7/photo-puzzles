import { haptic, type Haptic } from '../haptics';
import type { View } from '../render';
import type { Pt, SessionInit } from './types';

/** Gives touch feedback, unless the player has switched it off. */
export function buzz(init: SessionInit, kind: Haptic): void {
  if (init.flag('haptics')) haptic(kind);
}

/** A bomb places its pieces one after the other this far apart (the ripple and the bell of each), as a cascade ... */
export const CASCADE_MS = 200;
/** ... but the whole cascade is over within this, however many pieces the bomb places. */
const CASCADE_MAX_MS = 3000;

/** The time between the pieces of a bomb that places `n` of them. */
export function cascadeStep(n: number): number {
  return Math.min(CASCADE_MS, CASCADE_MAX_MS / Math.max(1, n - 1));
}

/** The colour of the ripple over a piece put in place by `by` (this player, if nobody is named): theirs in a puzzle played with friends, and none (the ripple's own) when played alone. */
export function rippleColor(init: SessionInit, by?: string): string | undefined {
  const online = init.online;
  return online ? online.colorOf(by ?? online.self) : undefined;
}

/** `items` nearest first to the point (x, y), as far as `at` says where each one is. The order of a bomb's cascade: it spreads out from where the bomb fell. */
export function nearestFirst<T>(items: readonly T[], x: number, y: number, at: (item: T) => Pt): T[] {
  const dist = (item: T): number => Math.hypot(at(item).x - x, at(item).y - y);
  return [...items].sort((a, b) => dist(a) - dist(b));
}

/** A finger holds a piece this far (CSS pixels) above the point it touched, so that the finger does not hide it; the piece rises to there over LIFT_MS. */
export const LIFT_CSS = 76;
export const LIFT_MS = 110;

/**
 * A held piece that a finger holds above the finger. `held(p)` is where the piece is for a finger at p: the finger's place, `distance` board units higher once the piece has
 * risen. It is not kept on the screen: a finger near the top takes the piece up past the edge, which is what putting a piece on the edge of the board needs.
 */
export class Lift {
  constructor(
    /** How far above the finger, in board units. */
    readonly distance: number,
    private readonly t0: number,
  ) {}

  /** 0 (just picked up) to 1 (risen). */
  progress(now: number): number {
    const t = Math.min(1, Math.max(0, (now - this.t0) / LIFT_MS));
    return t * t * (3 - 2 * t);
  }

  done(now: number): boolean {
    return now - this.t0 >= LIFT_MS;
  }

  held(p: Pt, now: number): Pt {
    return { x: p.x, y: p.y - this.distance * this.progress(now) };
  }
}

/** The lift for a piece just picked up by a finger (null for a mouse or a pen, or when the player has turned the offset off). */
export function startLift(init: SessionInit, touch: boolean, view: View, now: number): Lift | null {
  if (!touch || !init.flag('offset')) return null;
  return new Lift((LIFT_CSS * (window.devicePixelRatio || 1)) / view.scale, now);
}
