import { RotascopeGame, type RotascopeState } from '../core/rotascope';
import { beginFrame, type View } from '../render';
import type { Pt, PuzzleSession, SessionInit } from './types';

const SLIDE_MS = 240;
const RAD = Math.PI / 180;

interface Slide {
  from: Extent;
  to: Extent;
  start: number;
}

/** Where a cell's wedge lies: from radius r0 outwards (a ring ratio further out) and from angle a0 (degrees) round by one step. */
interface Extent {
  r0: number;
  a0: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Rotascope: the picture is a disc cut into rings of wedges round an empty middle. Click a piece that touches the empty cell and it slides in, changing size and turning
 * to fit its new ring. Every piece back where it came from makes the picture whole again.
 */
export class RotascopeSession implements PuzzleSession {
  readonly toggles = [
    { key: 'grid', label: 'Grid', title: 'Lines between the pieces' },
    { key: 'animate', label: 'Animate', title: 'Sliding animations' },
  ];
  readonly rotatable = false;
  private game: RotascopeGame;
  private readonly side: number;          // the picture is cropped to this square; the board is the disc inside it
  private readonly cropX: number;
  private readonly cropY: number;
  private readonly radius: number;
  private slides = new Map<number, Slide>();      // by piece
  private hover = -1;

  constructor(private readonly init: SessionInit) {
    this.game = new RotascopeGame(init.opts.rings, init.opts.wedges, init.seed);
    if (init.restore) this.game.restore((init.restore as { game: RotascopeState }).game);
    this.side = Math.min(init.width, init.height);
    this.cropX = (init.width - this.side) / 2;
    this.cropY = (init.height - this.side) / 2;
    this.radius = this.side / 2 - 1;
  }

  serialize(): unknown {
    return { game: this.game.snapshot() };
  }

  layout(): { width: number; height: number } {
    return { width: this.side, height: this.side };
  }

  /** The wedge of a cell as it is drawn now: the middle shows the piece in it as it would lie one ring further in, at its own angle. */
  private extent(cell: number): Extent {
    const g = this.game;
    const ring = g.ringOf(cell);
    if (ring >= 0) return { r0: g.boundary(ring) * this.radius, a0: g.startAngle(g.colOf(cell)) };
    const piece = g.content[cell];
    return { r0: (g.boundary(0) / g.ratio) * this.radius, a0: g.startAngle(piece < 0 ? 0 : g.colOf(piece)) };
  }

  /** The outline of a wedge, a little wider than it is (`grow`) so that neighbours overlap instead of leaving a hairline between them. */
  private wedge(ctx: CanvasRenderingContext2D, e: Extent, grow = 0): void {
    const r0 = Math.max(0, e.r0 - grow);
    const r1 = e.r0 * this.game.ratio + grow;
    const a0 = e.a0 * RAD - (grow ? grow / e.r0 : 0);
    const a1 = (e.a0 + this.game.step) * RAD + (grow ? grow / e.r0 : 0);
    const c = this.side / 2;
    ctx.beginPath();
    ctx.arc(c, c, r1, a0, a1);
    ctx.arc(c, c, r0, a1, a0, true);
    ctx.closePath();
  }

  /** Draws a piece of the picture into a wedge: the picture is turned and scaled about the middle so that the piece's own wedge lands on this one. */
  private piece(ctx: CanvasRenderingContext2D, piece: number, e: Extent, grow: number): void {
    const home = this.extent(piece);
    const c = this.side / 2;
    ctx.save();
    this.wedge(ctx, e, grow);
    ctx.clip();
    const k = e.r0 / home.r0;
    ctx.translate(c, c);
    ctx.rotate((e.a0 - home.a0) * RAD);
    ctx.scale(k, k);
    ctx.translate(-c, -c);
    ctx.drawImage(this.init.source, this.cropX, this.cropY, this.side, this.side, 0, 0, this.side, this.side);
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    const g = this.game;
    beginFrame(ctx, view);
    const c = this.side / 2;
    const line = 1 / view.scale;
    const disc = () => {
      ctx.beginPath();
      ctx.arc(c, c, this.radius, 0, Math.PI * 2);
      ctx.closePath();
    };
    // the whole picture, dimmed: it shows in the empty cell, and in the middle (which is not a piece)
    ctx.save();
    disc();
    ctx.clip();
    ctx.drawImage(this.init.source, this.cropX, this.cropY, this.side, this.side, 0, 0, this.side, this.side);
    ctx.fillStyle = g.solved ? 'rgba(16,10,8,0)' : 'rgba(16,10,8,0.74)';
    ctx.fillRect(0, 0, this.side, this.side);
    ctx.restore();
    if (g.solved) return false;

    let running = false;
    const grid = this.init.flag('grid');
    const grow = 0.6 * line;
    const moving: [number, Extent][] = [];
    for (let cell = 0; cell < g.cells; cell++) {
      const p = g.content[cell];
      if (p < 0) continue;
      const s = this.slides.get(p);
      if (s) {
        const t = (now - s.start) / SLIDE_MS;
        if (t < 1) {
          const k = ease(Math.max(0, t));
          const da = ((((s.to.a0 - s.from.a0 + 540) % 360) + 360) % 360) - 180;       // the short way round
          moving.push([p, { r0: s.from.r0 + (s.to.r0 - s.from.r0) * k, a0: s.from.a0 + da * k }]);
          running = true;
          continue;
        }
        this.slides.delete(p);
      }
      const e = this.extent(cell);
      this.piece(ctx, p, e, grow);
      if (grid) this.outline(ctx, e, line);
    }
    for (const [p, e] of moving) {
      this.piece(ctx, p, e, grow);
      if (grid) this.outline(ctx, e, line);
    }
    if (grid) {
      ctx.lineWidth = line * 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(c, c, g.boundary(0) * this.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.hover >= 0 && g.adjacent(this.hover, g.blank) && g.content[this.hover] >= 0) {
      ctx.lineWidth = line * 4;
      ctx.strokeStyle = '#ffd84a';
      if (this.hover === g.centre) {
        ctx.beginPath();
        ctx.arc(c, c, g.boundary(0) * this.radius - line * 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        this.wedge(ctx, this.extent(this.hover), -line * 2);
        ctx.stroke();
      }
    }
    return running;
  }

  private outline(ctx: CanvasRenderingContext2D, e: Extent, line: number): void {
    ctx.lineWidth = line * 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    this.wedge(ctx, e);
    ctx.stroke();
  }

  private cellAt(p: Pt): number {
    const dx = p.x - this.side / 2;
    const dy = p.y - this.side / 2;
    return this.game.cellAt(Math.hypot(dx, dy) / this.radius, Math.atan2(dy, dx) / RAD);
  }

  pointerDown(p: Pt): void {
    const cell = this.cellAt(p);
    if (cell < 0) return;
    const from = this.extent(cell);
    const m = this.game.click(cell);
    if (m && this.init.flag('animate')) this.slides.set(m.piece, { from, to: this.extent(m.to), start: performance.now() });
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    const cell = this.cellAt(p);
    if (cell !== this.hover) {
      this.hover = cell;
      this.init.requestDraw();
    }
  }

  pointerUp(): void {}

  pointerCancel(): void {
    this.hover = -1;
  }

  secondary(): void {}

  status(): string {
    const n = this.game.moves;
    return `${n} ${n === 1 ? 'move' : 'moves'}`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {
    if (!this.init.flag('animate')) this.slides.clear();
    this.init.requestDraw();
  }
}
