import type { Rect } from '../core/layout';
import type { Pt } from './types';

export const RIPPLE_MS = 650;

/** The ring is drawn three times, wide and faint to narrow and bright: its width (as a share of the band) and opacity. */
const RINGS: readonly (readonly [number, number])[] = [[1, 0.22], [0.55, 0.4], [0.18, 0.85]];

interface Ripple {
  rects: Rect[];
  x: number;
  y: number;
  /** The farthest the ring has to go to have crossed every rectangle. */
  reach: number;
  t0: number;
}

/**
 * The brief ripple over pieces that have just locked in place: a ring of light spreads from the middle of the pieces and shows only over them, with a faint glow that
 * fades behind it. Drawn in board units over everything else (the caller has set the board's transform); nothing is allocated while it runs.
 */
export class Ripples {
  private list: Ripple[] = [];

  /** A ripple over `rects`, starting `delay` milliseconds from `now` (a swap that is still moving has to arrive first). */
  add(rects: readonly Rect[], now: number, delay = 0): void {
    if (!rects.length) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w);
      y1 = Math.max(y1, r.y + r.h);
    }
    const origin: Pt = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    let reach = 0;
    for (const r of rects) for (const cx of [r.x, r.x + r.w]) for (const cy of [r.y, r.y + r.h]) reach = Math.max(reach, Math.hypot(cx - origin.x, cy - origin.y));
    this.list.push({ rects: [...rects], x: origin.x, y: origin.y, reach, t0: now + delay });
  }

  clear(): void {
    this.list.length = 0;
  }

  /** Draws the ripples; true while one is still on its way. */
  draw(ctx: CanvasRenderingContext2D, now: number): boolean {
    for (let i = this.list.length - 1; i >= 0; i--) if (now - this.list[i].t0 >= RIPPLE_MS) this.list.splice(i, 1);
    for (const rp of this.list) {
      const t = (now - rp.t0) / RIPPLE_MS;
      if (t < 0) continue;
      const fade = 1 - t;
      const band = Math.max(4, rp.reach * 0.3);
      const radius = rp.reach * (1 - (1 - t) * (1 - t)) + band * 0.5;           // quick out of the middle, slowing towards the edge
      ctx.save();
      ctx.beginPath();
      for (const r of rp.rects) ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.3 * fade * fade;
      ctx.fillRect(rp.x - rp.reach - band, rp.y - rp.reach - band, 2 * (rp.reach + band), 2 * (rp.reach + band));
      ctx.strokeStyle = '#ffd84a';
      for (const [share, alpha] of RINGS) {
        ctx.globalAlpha = alpha * fade;
        ctx.lineWidth = band * share;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    return this.list.length > 0;
  }
}

const WAVE_MS = 380;                 // how long one piece glows as the ripple passes it
const WAVE_TRAVEL_MS = 700;          // the longest the ripple takes to reach the farthest piece, however many pieces are locked together
const WAVE_CELLS_PER_S = 12;         // how fast it travels over a few pieces

/**
 * The ripple over pieces that are locked together (a Jigsaw group): it spreads from where the pieces were put down and each piece glows as it passes, so it travels over
 * all of them. `step` works out how bright each piece is (`ks`, in the order of `members`) and says whether it is still running.
 */
export class GroupRipple {
  gid = -1;
  members: number[] = [];
  ks: number[] = [];
  private delay: number[] = [];
  private t0 = 0;
  private end = 0;

  /** A ripple over `members` of group `gid`, from the middle of `from` (pieces of the same picture, laid out in a grid of `cols` cells of `size`). */
  start(gid: number, members: readonly number[], from: readonly number[], cols: number, size: number, now: number): void {
    const centre = (m: number): Pt => ({ x: ((m % cols) + 0.5) * size, y: (Math.floor(m / cols) + 0.5) * size });
    let ox = 0;
    let oy = 0;
    for (const m of from) {
      const c = centre(m);
      ox += c.x / from.length;
      oy += c.y / from.length;
    }
    const dist = members.map((m) => Math.hypot(centre(m).x - ox, centre(m).y - oy));
    const far = dist.reduce((a, b) => Math.max(a, b), 0);
    const travel = Math.min(WAVE_TRAVEL_MS, far / ((size * WAVE_CELLS_PER_S) / 1000));
    this.gid = gid;
    this.members = [...members];
    this.delay = dist.map((d) => (far > 0 ? (d / far) * travel : 0));
    this.ks = new Array<number>(members.length).fill(0);
    this.t0 = now;
    this.end = now + travel + WAVE_MS;
  }

  /** The brightness (0 to 1) of every piece at `now`; false, with nothing left, once the ripple is over. */
  step(now: number): boolean {
    if (this.gid < 0) return false;
    if (now >= this.end) {
      this.gid = -1;
      this.members = [];
      return false;
    }
    for (let i = 0; i < this.ks.length; i++) {
      const local = (now - this.t0 - this.delay[i]) / WAVE_MS;
      const s = Math.sin(Math.PI * local);
      this.ks[i] = local > 0 && local < 1 ? s * s : 0;
    }
    return true;
  }
}
