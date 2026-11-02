import type { Rect } from '../core/layout';

/** How long a bomb falls from above the top of the screen to where it lands, in ms ("about a second"). */
export const FALL_MS = 1000;

/** What a bomb does: where it falls, and the pieces it is going to put in their places, in board units (the units of the board's own drawing). */
export interface BombPlan {
  /** Where it lands. */
  x: number;
  y: number;
  /** One cell, or one piece: what the sizes of the bomb, the fire and the smoke are measured in. */
  unit: number;
  /** Where the pieces lie that it is going to put in their places: the fire covers this. */
  area: readonly Rect[];
  /** The fire's circles are this many `unit`s across, at the smallest and at the largest. */
  lo: number;
  hi: number;
}

interface Fire {
  x: number;
  y: number;
  /** When it begins and how long it lasts, ms. */
  at: number;
  life: number;
  /** Across, in board units; and its colour, from yellow to red. */
  size: number;
  colour: string;
}

interface Smoke {
  x: number;
  y: number;
  /** Where it drifts, board units a second (up is negative y). */
  vx: number;
  vy: number;
  at: number;
  life: number;
  size: number;
}

/** The fire starts over this long after the landing, each circle at its own moment. */
const BLAST_MS = 420;
const FIRE_MIN_MS = 260;
const FIRE_MAX_MS = 460;
const SMOKE_MIN_MS = 500;
const SMOKE_MAX_MS = 1000;
/** The flash of the landing. */
const FLASH_MS = 130;

const between = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/**
 * A bomb that falls from above the screen and explodes where it lands, for every kind of board. The caller decides when each thing happens (`drop`, then `explode` a fall later) and
 * draws it with the board's transform set, over the pieces. The explosion is retro: hard-edged circles from yellow to red that pop up, all over the place the bomb is about to clear, and a
 * square of grey smoke that floats up and away from each of them. Nothing is allocated while it is drawn.
 */
export class BombFx {
  private bomb: { x: number; y: number; size: number; at: number } | null = null;
  private fire: Fire[] = [];
  private smoke: Smoke[] = [];
  private flash: { x: number; y: number; size: number; at: number } | null = null;

  /** `enabled` says whether animations are wanted (the player's Animations setting): when not, nothing is shown. */
  constructor(private readonly enabled: () => boolean = () => true) {}

  /** The bomb begins to fall (it lands `FALL_MS` from `now`). */
  drop(plan: BombPlan, now: number): void {
    if (!this.enabled()) return;
    this.bomb = { x: plan.x, y: plan.y, size: plan.unit * 1.1, at: now };
  }

  /** The bomb lands: it is gone, and the explosion begins. */
  explode(plan: BombPlan, now: number): void {
    this.bomb = null;
    if (!this.enabled()) return;
    const { x, y, unit, area, lo, hi } = plan;
    this.flash = { x, y, size: unit * 2, at: now };
    const total = area.reduce((n, r) => n + r.w * r.h, 0);
    const count = Math.min(90, Math.max(10, Math.round((total / (unit * unit)) * 0.9)));
    for (let i = 0; i < count; i++) {
      // a place in the area that is to be cleared (a little beyond it too), chosen by the size of each piece's rectangle
      let pick = Math.random() * total;
      let r = area[area.length - 1];
      for (const candidate of area) {
        pick -= candidate.w * candidate.h;
        if (pick <= 0) {
          r = candidate;
          break;
        }
      }
      const slack = unit * 0.25;
      const px = r ? between(r.x - slack, r.x + r.w + slack) : x + between(-unit, unit);
      const py = r ? between(r.y - slack, r.y + r.h + slack) : y + between(-unit, unit);
      const at = now + Math.random() * BLAST_MS;
      this.fire.push({ x: px, y: py, at, life: between(FIRE_MIN_MS, FIRE_MAX_MS), size: unit * between(lo, hi), colour: `hsl(${Math.round(between(0, 58))}, 100%, ${Math.round(between(48, 58))}%)` });
      this.smoke.push({
        x: px,
        y: py,
        vx: (px < x ? -1 : 1) * unit * between(0.1, 0.9),                // (away from where it fell)
        vy: -unit * between(1.2, 2.6),                                    // (and up)
        at,
        life: between(SMOKE_MIN_MS, SMOKE_MAX_MS),
        size: unit * between(0.3, 0.6),
      });
    }
  }

  /** Something is showing (a bomb falling, or the fire and smoke): the board has to be drawn on. */
  get active(): boolean {
    return !!this.bomb || !!this.flash || this.fire.length > 0 || this.smoke.length > 0;
  }

  /** The bomb that is still falling is taken away (the board was changed under it). What was lit stays and finishes. */
  cancelFall(): void {
    this.bomb = null;
  }

  /** Nothing is shown any more. */
  clear(): void {
    this.bomb = null;
    this.flash = null;
    this.fire.length = 0;
    this.smoke.length = 0;
  }

  /** Draws it (the transform is the board's); true while there is more to come. */
  draw(ctx: CanvasRenderingContext2D, now: number): boolean {
    if (!this.bomb && !this.flash && !this.fire.length && !this.smoke.length) return false;
    ctx.save();
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      const t = (now - s.at) / s.life;
      if (t >= 1) {
        this.smoke.splice(i, 1);
        continue;
      }
      if (t < 0) continue;
      const secs = (now - s.at) / 1000;
      ctx.globalAlpha = 0.6 * (1 - t);
      ctx.fillStyle = '#8a8a8a';
      const side = s.size * (1 + 0.6 * t);                                // (it swells a little as it rises)
      ctx.fillRect(s.x + s.vx * secs - side / 2, s.y + s.vy * secs - side / 2, side, side);
    }
    ctx.globalAlpha = 1;
    if (this.flash) {
      const t = (now - this.flash.at) / FLASH_MS;
      if (t >= 1) this.flash = null;
      else {
        ctx.fillStyle = t < 0.5 ? '#ffffff' : '#fff3a8';
        ctx.beginPath();
        ctx.arc(this.flash.x, this.flash.y, (this.flash.size / 2) * (0.6 + 0.8 * t), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (let i = this.fire.length - 1; i >= 0; i--) {
      const f = this.fire[i];
      const t = (now - f.at) / f.life;
      if (t >= 1) {
        this.fire.splice(i, 1);
        continue;
      }
      if (t < 0) continue;
      const k = t < 0.2 ? t / 0.2 : 1 - ((t - 0.2) / 0.8) * 0.6;           // (it pops up, then shrinks as it dies)
      ctx.fillStyle = f.colour;
      ctx.beginPath();
      ctx.arc(f.x, f.y, (f.size / 2) * k, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.bomb) this.drawBomb(ctx, this.bomb, now);
    ctx.restore();
    return this.active;                                                   // (what has run its course is gone)
  }

  /** The bomb itself, falling faster as it goes, from above the top of the screen to where it lands. */
  private drawBomb(ctx: CanvasRenderingContext2D, b: { x: number; y: number; size: number; at: number }, now: number): void {
    const m = ctx.getTransform();
    const top = -m.f / m.d;                                                // (the board's y at the top of the screen)
    const from = Math.min(top, b.y) - b.size * 1.6;
    const t = Math.min(1, Math.max(0, (now - b.at) / FALL_MS));
    const y = from + (b.y - from) * t * t;
    const r = b.size / 2;
    ctx.fillStyle = '#17120f';
    ctx.beginPath();
    ctx.arc(b.x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = r * 0.16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(b.x, y, r * 0.98, Math.PI * 0.95, Math.PI * 1.35);              // (a shine at the top left)
    ctx.stroke();
    ctx.globalAlpha = 1;
    // the fuse, and the spark at its end, which flickers
    const fx = b.x + r * 0.55;
    const fy = y - r * 0.95;
    ctx.strokeStyle = '#c9a15a';
    ctx.lineWidth = r * 0.2;
    ctx.beginPath();
    ctx.moveTo(b.x + r * 0.25, y - r * 0.85);
    ctx.quadraticCurveTo(b.x + r * 0.5, y - r * 1.15, fx + r * 0.2, fy - r * 0.35);
    ctx.stroke();
    ctx.fillStyle = Math.floor(now / 60) % 2 ? '#ffd84a' : '#ff7a1a';
    ctx.beginPath();
    ctx.arc(fx + r * 0.25, fy - r * 0.4, r * (0.22 + 0.12 * Math.random()), 0, Math.PI * 2);
    ctx.fill();
  }
}
