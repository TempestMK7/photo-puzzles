import { haptic, type Haptic } from '../haptics';
import type { View } from '../render';
import { playEffect, stopEffect } from '../sounds';
import { FALL_MS, type BombFx, type BombPlan } from './bomb';
import type { Pt, SessionInit } from './types';

/** Gives touch feedback, unless the player has switched it off. */
export function buzz(init: SessionInit, kind: Haptic): void {
  if (init.flag('haptics')) haptic(kind);
}

/** The bell for a piece that another player put in its place: half of the volume that the player chose (it is the only sound that another player's moves make). */
export function othersBell(delayMs = 0): void {
  playEffect('placed', delayMs, 0.5);
}

/** A bomb places its pieces one after the other this far apart (the ripple and the bell of each), as a cascade ... */
export const CASCADE_MS = 200;
/** ... but the whole cascade is over within this, however many pieces the bomb places. */
const CASCADE_MAX_MS = 3000;

/** The time between the pieces of a bomb that places `n` of them. */
export function cascadeStep(n: number): number {
  return Math.min(CASCADE_MS, CASCADE_MAX_MS / Math.max(1, n - 1));
}

/**
 * The steps of a bomb, one after the other: the first now, each of the others `every` ms after the one before. A step is one piece put in its place, with its ripple and its bell. The
 * board itself changes step by step, so that the pieces really are placed one at a time. If the player does anything else meanwhile (or another player's move comes in), what is left is
 * done at once (`flush`, told `late`, so that it makes no light and no sound): the board has to be what the room's is before anything else is done to it.
 */
export class Cascade {
  private waiting: { timer: ReturnType<typeof setTimeout>; run: (late: boolean) => void }[] = [];

  /** `onEnd`: called when steps that were waiting are done at once or dropped (a bomb that was still falling is taken away). */
  constructor(private readonly onEnd: () => void = () => {}) {}

  /**
   * Starts the steps. `step` is told the item, its place in the row, and whether it is being done late (see `flush`). With no `after` the first runs before this returns; with one (a bomb is
   * falling) every step waits that long, and the first is the moment the bomb lands.
   */
  start<T>(items: readonly T[], every: number, step: (item: T, k: number, late: boolean) => void, after = 0): void {
    items.forEach((item, k) => {
      if (k === 0 && after <= 0) {
        step(item, 0, false);
        return;
      }
      const entry = {
        timer: setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== entry);
          step(item, k, false);
        }, after + k * every),
        run: (late: boolean) => step(item, k, late),
      };
      this.waiting.push(entry);
    });
  }

  /** Steps that have not been done yet. */
  get busy(): boolean {
    return this.waiting.length > 0;
  }

  /** Does what is left at once, in order. */
  flush(): void {
    const left = this.waiting;
    if (!left.length) return;
    this.waiting = [];
    for (const w of left) clearTimeout(w.timer);
    this.onEnd();
    for (const w of left) w.run(true);
  }

  /** Drops what is left (the puzzle is gone). */
  cancel(): void {
    if (!this.waiting.length) return;
    for (const w of this.waiting) clearTimeout(w.timer);
    this.waiting = [];
    this.onEnd();
  }
}

/**
 * A bomb is used (by this player or another): it falls from above the screen (with the sound of a fuse), lands and explodes (the explosion, and its sound; and the first
 * piece is put in its place), and `placeOne` is then called for each of the pieces it places, nearest first, 0.2 s apart. With animations off there is no fall and no fire, and the
 * pieces start at once.
 */
export function dropBomb<T>(cascade: Cascade, fx: BombFx, init: SessionInit, plan: BombPlan, hits: readonly T[], placeOne: (item: T, late: boolean, k: number) => void): void {
  const animate = init.flag('animate');
  if (animate) {
    fx.drop(plan, performance.now());
    playEffect('fuse');
  }
  cascade.start(
    hits,
    cascadeStep(hits.length),
    (item, k, late) => {
      if (k === 0 && !late) {
        stopEffect('fuse');                                            // (it ends if it was still sounding: the bomb has landed)
        fx.explode(plan, performance.now());
        playEffect('explode');
      }
      placeOne(item, late, k);
    },
    animate ? FALL_MS : 0,
  );
}

/** What a Cascade does when it is cut short: a bomb that is still falling is taken away, and its fuse stops. */
export function bombCut(fx: BombFx): () => void {
  return () => {
    fx.cancelFall();
    stopEffect('fuse');
  };
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

/** The lift for a piece just picked up (null when the player has turned the offset off): by a finger, and by a mouse or a pen too, which hold the piece above the pointer. */
export function startLift(init: SessionInit, _touch: boolean, view: View, now: number): Lift | null {
  if (!init.flag('offset')) return null;
  return new Lift((LIFT_CSS * (window.devicePixelRatio || 1)) / view.scale, now);
}
