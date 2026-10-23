import { edgeSegments, JigsawGame, layoutJigsaw, reverseSegments, TAB_REACH, type JigsawLayout } from '../core/jigsaw';
import { Rng } from '../core/rng';
import { beginFrame, type View } from '../render';
import type { Pt, PuzzleSession, SessionInit } from './types';

const WORLD_K = 4;             // the usable area is this many puzzles wide and high
const SCATTER_K = 0.75;        // pieces start this far round the puzzle (in puzzle widths / heights), not all over the world
const PAN_TAP = 3;

/** The pieces, cut out of the picture once and laid side by side on one canvas (the "atlas"), so that drawing a piece is a single drawImage. */
interface Atlas {
  canvas: HTMLCanvasElement;
  plain: HTMLCanvasElement;
  pad: number;
  tile: number;
  pitch: number;
}

/** Walks piece (c, r)'s outline with its cell's top-left corner at (ox, oy). */
function tracePiece(ctx: CanvasRenderingContext2D, l: JigsawLayout, c: number, r: number, ox: number, oy: number): void {
  const s = l.size;
  const top = edgeSegments(l.h[r * l.cols + c]);
  const right = edgeSegments(l.v[r * (l.cols + 1) + c + 1]);
  const bottom = reverseSegments(edgeSegments(l.h[(r + 1) * l.cols + c]));
  const left = reverseSegments(edgeSegments(l.v[r * (l.cols + 1) + c]));
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  const run = (segs: ReturnType<typeof edgeSegments>, map: (u: number, v: number) => [number, number]): void => {
    for (const q of segs) {
      const [x1, y1] = map(q[0], q[1]);
      const [x2, y2] = map(q[2], q[3]);
      const [x, y] = map(q[4], q[5]);
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
    }
  };
  run(top, (u, v) => [ox + u * s, oy + v * s]);
  run(right, (u, v) => [ox + s + v * s, oy + u * s]);
  run(bottom, (u, v) => [ox + u * s, oy + s + v * s]);
  run(left, (u, v) => [ox + v * s, oy + u * s]);
  ctx.closePath();
}

function buildAtlas(img: HTMLCanvasElement, l: JigsawLayout): Atlas {
  const pad = Math.ceil(l.size * TAB_REACH) + 1;
  const tile = Math.ceil(l.size) + 2 * pad;
  const pitch = tile + 2;
  const make = (): CanvasRenderingContext2D => {
    const canvas = document.createElement('canvas');
    canvas.width = l.cols * pitch;
    canvas.height = l.rows * pitch;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    return g;
  };
  const lit = make();          // loose pieces: with their outline
  const plain = make();        // pieces in the picture: no outline, and a hair wider than the cell so no gap shows between neighbours
  const pattern = lit.createPattern(img, 'no-repeat')!;
  const edge = Math.max(1, l.size * 0.03);
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const tx = c * pitch + 1;
      const ty = r * pitch + 1;
      const ox = tx + pad;
      const oy = ty + pad;
      pattern.setTransform(new DOMMatrix().translate(tx - (l.cropX + c * l.size - pad), ty - (l.cropY + r * l.size - pad)));
      for (const g of [lit, plain]) {
        g.fillStyle = pattern;
        g.strokeStyle = pattern;
        tracePiece(g, l, c, r, ox, oy);
        g.fill();
        g.lineWidth = g === plain ? 1.5 : 0.6;
        g.stroke();
      }
      lit.save();
      tracePiece(lit, l, c, r, ox, oy);
      lit.clip();
      lit.strokeStyle = 'rgba(255,255,255,0.28)';                      // a light line just inside the edge ...
      lit.lineWidth = edge * 2;
      tracePiece(lit, l, c, r, ox, oy);
      lit.stroke();
      lit.restore();
      lit.strokeStyle = 'rgba(0,0,0,0.55)';                            // ... and a dark one on it
      lit.lineWidth = edge;
      tracePiece(lit, l, c, r, ox, oy);
      lit.stroke();
    }
  }
  return { canvas: lit.canvas, plain: plain.canvas, pad, tile, pitch };
}

/** A still copy of what the pieces are cut from (a video is frozen at its current picture). */
function snapshot(init: SessionInit): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = init.width;
  c.height = init.height;
  c.getContext('2d')!.drawImage(init.source, 0, 0, init.width, init.height);
  return c;
}

/**
 * Jigsaw: pieces with tabs and blanks lie scattered round the frame of the picture. Drag them (left button); a piece put next to a piece it belongs beside joins it, and
 * joined pieces move as one; anything that joins a corner piece becomes part of the finished picture. The mouse wheel (and the control at the bottom right) zooms, the right
 * button (or the left one, on bare ground) pans.
 */
export class JigsawSession implements PuzzleSession {
  readonly toggles = [];
  readonly rotatable = false;
  readonly stillSource = true;
  private layout_: JigsawLayout;
  private game: JigsawGame;
  private atlas: Atlas;
  private worldW: number;
  private worldH: number;
  private frameX: number;
  private frameY: number;
  private cam = { zoom: 1, cx: 0, cy: 0 };
  private canvasW = 0;
  private canvasH = 0;
  private fitZoom = 1;
  private inited = false;
  private drag: { gid: number; gx: number; gy: number; moved: boolean } | null = null;
  private pan: { anchor: Pt; moved: boolean } | null = null;
  private flash = new Set<number>();
  private flashStart = 0;

  constructor(private readonly init: SessionInit) {
    const rng = new Rng(init.seed);
    const img = snapshot(init);
    this.layout_ = layoutJigsaw(rng, img.width, img.height, init.opts.pieces);
    const l = this.layout_;
    this.atlas = buildAtlas(img, l);
    const puzzleW = l.cols * l.size;
    const puzzleH = l.rows * l.size;
    this.worldW = puzzleW * WORLD_K;
    this.worldH = puzzleH * WORLD_K;
    this.frameX = (this.worldW - puzzleW) / 2;
    this.frameY = (this.worldH - puzzleH) / 2;
    const mx = puzzleW * SCATTER_K;
    const my = puzzleH * SCATTER_K;
    // every loose piece starts somewhere round the frame, not on it
    this.game = new JigsawGame(l, (i) => {
      const c = i % l.cols;
      const r = Math.floor(i / l.cols);
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = this.frameX - mx + rng.unit() * (puzzleW + 2 * mx - l.size);
        y = this.frameY - my + rng.unit() * (puzzleH + 2 * my - l.size);
        const onFrame = x + l.size > this.frameX && x < this.frameX + puzzleW && y + l.size > this.frameY && y < this.frameY + puzzleH;
        if (!onFrame) break;
      }
      return { dx: x - (this.frameX + c * l.size), dy: y - (this.frameY + r * l.size) };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------- camera

  layout(): { width: number; height: number } {
    return { width: this.worldW, height: this.worldH };
  }

  private get minZoom(): number {
    return Math.min(this.canvasW / this.worldW, this.canvasH / this.worldH) * 0.95;
  }

  private get maxZoom(): number {
    return Math.max(this.fitZoom * 2, 280 / this.layout_.size);
  }

  /** The view that shows the whole area the pieces start in. */
  private fit(): void {
    const l = this.layout_;
    const w = l.cols * l.size * (1 + 2 * SCATTER_K);
    const h = l.rows * l.size * (1 + 2 * SCATTER_K);
    this.fitZoom = Math.max(1e-4, Math.min(this.canvasW / w, this.canvasH / h) * 0.96);
    this.cam = { zoom: this.fitZoom, cx: this.worldW / 2, cy: this.worldH / 2 };
  }

  view(cw: number, ch: number): View {
    if (cw !== this.canvasW || ch !== this.canvasH) {
      const first = !this.inited;
      this.canvasW = cw;
      this.canvasH = ch;
      if (first) {
        this.fit();
        this.inited = true;
      } else this.cam.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.cam.zoom));
    }
    return { scale: this.cam.zoom, ox: cw / 2 - this.cam.cx * this.cam.zoom, oy: ch / 2 - this.cam.cy * this.cam.zoom };
  }

  private clampCentre(): void {
    this.cam.cx = Math.min(this.worldW, Math.max(0, this.cam.cx));
    this.cam.cy = Math.min(this.worldH, Math.max(0, this.cam.cy));
  }

  /** Zoom by a factor, keeping the world point `at` where it is on the screen. */
  private zoomAt(at: Pt, factor: number): void {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.cam.zoom * factor));
    const k = this.cam.zoom / z;
    this.cam.cx = at.x + (this.cam.cx - at.x) * k;
    this.cam.cy = at.y + (this.cam.cy - at.y) * k;
    this.cam.zoom = z;
    this.clampCentre();
    this.init.requestDraw();
  }

  wheel(at: Pt, deltaY: number): void {
    this.zoomAt(at, Math.exp(-deltaY * 0.0015));
  }

  /** Two fingers moved: what was under `from` (canvas pixels) now lies under `to`, and the picture is `factor` times bigger. */
  pinch(from: Pt, to: Pt, factor: number): void {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.cam.zoom * factor));
    const wx = this.cam.cx + (from.x - this.canvasW / 2) / this.cam.zoom;
    const wy = this.cam.cy + (from.y - this.canvasH / 2) / this.cam.zoom;
    this.cam.zoom = z;
    this.cam.cx = wx + (this.canvasW / 2 - to.x) / z;
    this.cam.cy = wy + (this.canvasH / 2 - to.y) / z;
    this.clampCentre();
    this.init.requestDraw();
  }

  zoomBy(factor: number): void {
    this.zoomAt({ x: this.cam.cx, y: this.cam.cy }, factor);
  }

  zoomFit(): void {
    this.fit();
    this.init.requestDraw();
  }

  zoomLabel(): string {
    return `${Math.round((this.cam.zoom / this.fitZoom) * 100)}%`;
  }

  // ---------------------------------------------------------------------------------------------------------------- drawing

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    const l = this.layout_;
    const g = this.game;
    ctx.fillStyle = '#241711';
    ctx.fillRect(0, 0, this.worldW, this.worldH);
    ctx.strokeStyle = '#6b4a36';
    ctx.lineWidth = 3 / view.scale;
    ctx.strokeRect(0, 0, this.worldW, this.worldH);
    // where the picture goes
    const pw = l.cols * l.size;
    const ph = l.rows * l.size;
    ctx.fillStyle = '#2d1e15';
    ctx.fillRect(this.frameX, this.frameY, pw, ph);
    ctx.strokeStyle = 'rgba(255,216,74,0.3)';
    ctx.lineWidth = 2 / view.scale;
    ctx.setLineDash([8 / view.scale, 6 / view.scale]);
    ctx.strokeRect(this.frameX, this.frameY, pw, ph);
    ctx.setLineDash([]);
    ctx.imageSmoothingQuality = view.scale < 0.6 ? 'low' : 'high';
    const { canvas: lit, plain, pad, tile, pitch } = this.atlas;
    const x0 = -view.ox / view.scale;
    const y0 = -view.oy / view.scale;
    const x1 = (this.canvasW - view.ox) / view.scale;
    const y1 = (this.canvasH - view.oy) / view.scale;
    const drawGroup = (atlas: HTMLCanvasElement, members: number[], dx: number, dy: number): void => {
      for (const m of members) {
        const c = m % l.cols;
        const r = Math.floor(m / l.cols);
        const wx = this.frameX + c * l.size + dx - pad;
        const wy = this.frameY + r * l.size + dy - pad;
        if (wx > x1 || wy > y1 || wx + tile < x0 || wy + tile < y0) continue;
        ctx.drawImage(atlas, c * pitch + 1, r * pitch + 1, tile, tile, wx, wy, tile, tile);
      }
    };
    for (const grp of g.groups.values()) if (grp.anchored) drawGroup(plain, grp.members, 0, 0);
    for (const id of g.z) {
      const grp = g.groups.get(id)!;
      drawGroup(lit, grp.members, grp.dx, grp.dy);
    }
    // a moment's glow where pieces have just joined the picture
    let running = false;
    if (this.flash.size) {
      const k = 1 - (now - this.flashStart) / 500;
      if (k > 0) {
        ctx.fillStyle = `rgba(255,255,255,${0.35 * k})`;
        for (const m of this.flash) ctx.fillRect(this.frameX + (m % l.cols) * l.size, this.frameY + Math.floor(m / l.cols) * l.size, l.size, l.size);
        running = true;
      } else this.flash.clear();
    }
    return running;
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  private world(p: Pt): Pt {
    return { x: Math.min(this.worldW, Math.max(0, p.x)), y: Math.min(this.worldH, Math.max(0, p.y)) };
  }

  /** How close a piece has to be to its neighbour to join it: generous on screen, in any zoom. */
  private tolerance(): number {
    const s = this.layout_.size;
    return Math.min(0.5 * s, Math.max(0.2 * s, 10 / this.cam.zoom));
  }

  pointerDown(p: Pt): void {
    const gid = this.game.groupAt(p.x - this.frameX, p.y - this.frameY);
    if (gid < 0) {
      this.pan = { anchor: p, moved: false };
      return;
    }
    const grp = this.game.groups.get(gid)!;
    this.game.bringToFront(gid);
    this.drag = { gid, gx: p.x - this.frameX - grp.dx, gy: p.y - this.frameY - grp.dy, moved: false };
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    if (this.pan) {
      this.panTo(p);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const q = this.world(p);
    this.game.moveTo(d.gid, q.x - this.frameX - d.gx, q.y - this.frameY - d.gy);
    d.moved = true;
    this.settle(d.gid);                                           // against the right neighbour: it joins, without letting go
    this.init.requestDraw();
  }

  pointerUp(): void {
    const d = this.drag;
    if (d && d.moved) this.settle(d.gid);
    this.drag = null;
    this.pan = null;
    this.init.requestDraw();
  }

  pointerCancel(): void {
    this.drag = null;
    this.pan = null;
  }

  rightDown(p: Pt): void {
    if (this.game.groupAt(p.x - this.frameX, p.y - this.frameY) >= 0) return;       // on a piece: the right button does nothing
    this.pan = { anchor: p, moved: false };
  }

  rightMove(p: Pt): void {
    if (this.pan) this.panTo(p);
  }

  rightUp(): void {
    this.pan = null;
  }

  private panTo(p: Pt): void {
    const pan = this.pan!;
    if (!pan.moved && Math.hypot(p.x - pan.anchor.x, p.y - pan.anchor.y) * this.cam.zoom < PAN_TAP) return;
    pan.moved = true;
    this.cam.cx += pan.anchor.x - p.x;                            // the world point that was under the pointer stays under it
    this.cam.cy += pan.anchor.y - p.y;
    this.clampCentre();
    this.init.requestDraw();
  }

  /** Joins the dragged group to whatever it now lies right against; if it joined something the drag ends there. */
  private settle(gid: number): void {
    const g = this.game;
    if (!g.groups.has(gid)) return;
    const before = new Set(g.groups.get(gid)!.members);
    const wasAnchored = g.anchoredCount;
    const res = g.connect(gid, this.tolerance());
    if (res.joins === 0) return;
    this.drag = null;
    if (g.anchoredCount > wasAnchored) {
      this.flash = before;
      this.flashStart = performance.now();
    }
  }

  secondary(): void {}

  status(): string {
    return `${this.game.anchoredCount} / ${this.game.count} placed`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {}
}
