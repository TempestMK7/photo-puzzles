import { RotascopeGame, type RotascopeState } from '../core/rotascope';
import { beginFrame, type View } from '../render';
import { buzz } from './feedback';
import { Camera } from './camera';
import { VideoLayer, videoGlAvailable } from './videoGl';
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
  readonly rotatable = false;
  private game: RotascopeGame;
  private readonly side: number;          // the picture is cropped to this square; the board is the disc inside it
  private readonly cropX: number;
  private readonly cropY: number;
  private readonly radius: number;
  private slides = new Map<number, Slide>();      // by piece
  private hover = -1;
  /** A puzzle made from a video draws its pieces on the graphics card (see videoGl.ts) and gives this canvas to the play screen to lay over the board. */
  private layer: VideoLayer | null = null;
  private lastView: View = { scale: 1, ox: 0, oy: 0 };
  private canvasW = 1;
  private canvasH = 1;
  private cam: Camera;
  /** Where the press that may turn out to be a click went down (a press that moves the camera is no click). */
  private press: Pt | null = null;
  videoFrame?: (now: number) => void;

  constructor(private readonly init: SessionInit) {
    this.cam = new Camera(Math.min(init.width, init.height), Math.min(init.width, init.height), 2, () => init.requestDraw());
    this.game = new RotascopeGame(init.opts.rings, init.opts.wedges, init.seed);
    if (init.restore) this.game.restore((init.restore as { game: RotascopeState }).game);
    this.side = Math.min(init.width, init.height);
    this.cropX = (init.width - this.side) / 2;
    this.cropY = (init.height - this.side) / 2;
    this.radius = this.side / 2 - 1;
    if (init.video && videoGlAvailable()) {
      try {
        this.layer = new VideoLayer(init.video);
        this.videoFrame = (now) => void this.drawGl(now);
      } catch {
        this.layer = null;                                        // no graphics card to draw with: the pieces are cut from copies of the video's pictures
      }
    }
  }

  get overlay(): HTMLCanvasElement | undefined {
    return this.layer?.canvas;
  }

  dispose(): void {
    this.layer?.dispose();
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

  /** A piece of a video puzzle as triangles: every point of its wedge takes its colour from the point of the picture that the piece's own wedge has there (turned and scaled). */
  private pieceGl(L: VideoLayer, piece: number, e: Extent): void {
    const g = this.game;
    const home = this.extent(piece);
    const c = this.side / 2;
    const steps = Math.max(2, Math.ceil(g.step / 5));
    const pt = (r: number, deg: number): [number, number] => [c + r * Math.cos(deg * RAD), c + r * Math.sin(deg * RAD)];
    const src = (r: number, deg: number): [number, number] => {
      const [x, y] = pt(r, deg);
      return [(this.cropX + x) / L.vw, (this.cropY + y) / L.vh];
    };
    for (let i = 0; i < steps; i++) {
      const da = e.a0 + (g.step * i) / steps;
      const db = e.a0 + (g.step * (i + 1)) / steps;
      const ha = home.a0 + (g.step * i) / steps;
      const hb = home.a0 + (g.step * (i + 1)) / steps;
      const d00 = pt(e.r0, da);
      const d10 = pt(e.r0, db);
      const d01 = pt(e.r0 * g.ratio, da);
      const d11 = pt(e.r0 * g.ratio, db);
      const s00 = src(home.r0, ha);
      const s10 = src(home.r0, hb);
      const s01 = src(home.r0 * g.ratio, ha);
      const s11 = src(home.r0 * g.ratio, hb);
      L.tri(d00[0], d00[1], s00[0], s00[1], d10[0], d10[1], s10[0], s10[1], d01[0], d01[1], s01[0], s01[1]);
      L.tri(d10[0], d10[1], s10[0], s10[1], d11[0], d11[1], s11[0], s11[1], d01[0], d01[1], s01[0], s01[1]);
    }
  }

  /** The pieces of a video puzzle, drawn on the graphics card; true while a piece is still sliding. */
  private drawGl(now: number): boolean {
    const L = this.layer!;
    const g = this.game;
    const view = this.lastView;
    if (!L.begin(this.canvasW, this.canvasH, view)) return false;
    const c = this.side / 2;
    const R = this.radius;
    // the whole picture, dimmed: it shows in the empty cell, and in the middle (which is not a piece)
    const dim = g.solved ? 1 : 0.26;
    const rim = 96;
    const at = (a: number): [number, number] => [c + R * Math.cos(a), c + R * Math.sin(a)];
    const uvOf = (x: number, y: number): [number, number] => [(this.cropX + x) / L.vw, (this.cropY + y) / L.vh];
    const cuv = uvOf(c, c);
    for (let i = 0; i < rim; i++) {
      const p = at((i / rim) * Math.PI * 2);
      const q = at(((i + 1) / rim) * Math.PI * 2);
      const pu = uvOf(p[0], p[1]);
      const qu = uvOf(q[0], q[1]);
      L.tri(c, c, cuv[0], cuv[1], p[0], p[1], pu[0], pu[1], q[0], q[1], qu[0], qu[1], dim);
    }
    if (g.solved) {
      L.end();
      return false;
    }
    let running = false;
    const moving: [number, Extent][] = [];
    for (let cell = 0; cell < g.cells; cell++) {
      const p = g.content[cell];
      if (p < 0) continue;
      const s = this.slides.get(p);
      if (s) {
        const t = (now - s.start) / SLIDE_MS;
        if (t < 1) {
          const k = ease(Math.max(0, t));
          const da = ((((s.to.a0 - s.from.a0 + 540) % 360) + 360) % 360) - 180;
          moving.push([p, { r0: s.from.r0 + (s.to.r0 - s.from.r0) * k, a0: s.from.a0 + da * k }]);
          running = true;
          continue;
        }
        this.slides.delete(p);
      }
      this.pieceGl(L, p, this.extent(cell));
    }
    for (const [p, e] of moving) this.pieceGl(L, p, e);
    const white: [number, number, number, number] = [1, 1, 1, 0.85];
    if (this.init.flag('grid')) {
      const arc = (r: number, a0: number, a1: number, pixels: number, rgba: [number, number, number, number]) => {
        const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 6));
        for (let i = 0; i < n; i++) {
          const x0 = c + r * Math.cos((a0 + ((a1 - a0) * i) / n) * RAD);
          const y0 = c + r * Math.sin((a0 + ((a1 - a0) * i) / n) * RAD);
          const x1 = c + r * Math.cos((a0 + ((a1 - a0) * (i + 1)) / n) * RAD);
          const y1 = c + r * Math.sin((a0 + ((a1 - a0) * (i + 1)) / n) * RAD);
          L.seg(x0, y0, x1, y1, pixels, rgba);
        }
      };
      for (let k = 0; k <= g.rings; k++) arc(g.boundary(k) * R, 0, 360, 1.5, white);
      for (let col = 0; col < g.wedges; col++) {
        const a = g.startAngle(col) * RAD;
        L.seg(c + g.boundary(0) * R * Math.cos(a), c + g.boundary(0) * R * Math.sin(a), c + R * Math.cos(a), c + R * Math.sin(a), 1.5, white);
      }
    }
    if (this.hover >= 0 && g.adjacent(this.hover, g.blank) && g.content[this.hover] >= 0) {
      const gold: [number, number, number, number] = [1, 0.85, 0.29, 1];
      const inset = 2 / view.scale;
      if (this.hover === g.centre) {
        const n = 48;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const b = ((i + 1) / n) * Math.PI * 2;
          const r = g.boundary(0) * R - inset;
          L.seg(c + r * Math.cos(a), c + r * Math.sin(a), c + r * Math.cos(b), c + r * Math.sin(b), 4, gold);
        }
      } else {
        const e = this.extent(this.hover);
        const r0 = e.r0 + inset;
        const r1 = e.r0 * g.ratio - inset;
        const a0 = e.a0 + inset / e.r0 / RAD;
        const a1 = e.a0 + g.step - inset / e.r0 / RAD;
        const edge = (r: number, from: number, to: number) => {
          const n = Math.max(3, Math.ceil((to - from) / 6));
          for (let i = 0; i < n; i++) {
            const t0 = (from + ((to - from) * i) / n) * RAD;
            const t1 = (from + ((to - from) * (i + 1)) / n) * RAD;
            L.seg(c + r * Math.cos(t0), c + r * Math.sin(t0), c + r * Math.cos(t1), c + r * Math.sin(t1), 4, gold);
          }
        };
        edge(r0, a0, a1);
        edge(r1, a0, a1);
        L.seg(c + r0 * Math.cos(a0 * RAD), c + r0 * Math.sin(a0 * RAD), c + r1 * Math.cos(a0 * RAD), c + r1 * Math.sin(a0 * RAD), 4, gold);
        L.seg(c + r0 * Math.cos(a1 * RAD), c + r0 * Math.sin(a1 * RAD), c + r1 * Math.cos(a1 * RAD), c + r1 * Math.sin(a1 * RAD), 4, gold);
      }
    }
    L.end();
    return running;
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    const g = this.game;
    beginFrame(ctx, view);
    if (this.layer) {
      this.lastView = view;
      this.canvasW = ctx.canvas.width;
      this.canvasH = ctx.canvas.height;
      return this.drawGl(now);
    }
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
    this.press = p;
    this.cam.startPan(p);
  }

  /** A click on the board at `p`, once the press has ended without moving the camera. */
  private click(p: Pt): void {
    const cell = this.cellAt(p);
    if (cell < 0) return;
    const from = this.extent(cell);
    const m = this.game.click(cell);
    if (m) buzz(this.init, this.game.solved ? 'solved' : 'move');
    if (m && this.init.flag('animate')) this.slides.set(m.piece, { from, to: this.extent(m.to), start: performance.now() });
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    if (this.cam.panning && this.cam.panTo(p)) {
      this.press = null;
      this.hover = -1;
      return;
    }
    const cell = this.cellAt(p);
    if (cell !== this.hover) {
      this.hover = cell;
      this.init.requestDraw();
    }
  }

  pointerUp(): void {
    const moved = this.cam.endPan();
    const p = this.press;
    this.press = null;
    if (p && !moved) this.click(p);
  }

  pointerCancel(): void {
    this.cam.endPan();
    this.press = null;
    this.hover = -1;
  }

  secondary(): void {}

  // ---------------------------------------------------------------------------------------------------------------- camera

  view(cw: number, ch: number): View {
    return this.cam.view(cw, ch);
  }

  wheel(at: Pt, deltaY: number): void {
    this.cam.wheel(at, deltaY);
  }

  pinch(from: Pt, to: Pt, factor: number): void {
    this.cam.pinch(from, to, factor);
  }

  zoomBy(factor: number): void {
    this.cam.zoomBy(factor);
  }

  zoomFit(): void {
    this.cam.zoomFit();
  }

  zoomLabel(): string {
    return this.cam.zoomLabel();
  }

  /** The right button moves the camera (there is nothing for it to turn). */
  rightDown(p: Pt): void {
    this.cam.startPan(p);
  }

  rightMove(p: Pt): void {
    this.cam.panTo(p);
  }

  rightUp(): void {
    this.cam.endPan();
  }

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
