import { applyBoardOp, boardCheck, type Board, type BoardOp } from '../core/boardRoom';
import type { RoomEvent, RoomState } from '../core/jigsawRoom';
import { makeOverlap, type OverlapGame, type OverlapState } from '../core/overlap';
import { Rng } from '../core/rng';
import { makePattern } from './patterns';
import { Ripples } from './ripple';
import { beginFrame, drawSlice, type View } from '../render';
import { playEffect } from '../sounds';
import { buzz, startLift, type Lift } from './feedback';
import { FrontLayer, rgba, VideoLayer, videoGlAvailable } from './videoGl';
import type { Pt, PuzzleSession, SessionInit } from './types';

const CELL = 50;
const SLOT_W = 144;
const SLOT_H = 130;
const SLOT_GAP = 10;
const PANEL_PAD = 8;           // room around the stacks in their panel
const PANEL_W = SLOT_W + 2 * PANEL_PAD;
const PIECE_Y = 3;             // a piece in a stack sits this far below the top of its slot, clear of the label under it
const SLOT_SCALE = 0.7;        // a piece in a stack is drawn this much smaller than on the board: it reaches a cell out from its centre in every direction
const SLOT_PAD = 4;
/** Bumped when pieces changed what they are: a puzzle that was saved with older ones starts again. */
const LAYOUT = 2;
const TAP = 6;                 // a press that moves less than this many CSS pixels is a tap (it turns the piece)
const WRONG_MS = 350;
const MARGIN = 12;             // CSS pixels of room around the board when all of it shows
const EDGE = 40;               // a piece held this close (CSS pixels) to the top or bottom of the stacks' panel makes the panel scroll
const SCROLL_SPEED = 700;      // CSS pixels a second, at the very edge
const UNIT: View = { scale: 1, ox: 0, oy: 0 };

interface Slot {
  x: number;
  y: number;
}

/** The piece in hand: where the pointer is and where it went down (canvas pixels), whether it has moved (else a tap), and - for a finger - the lift that holds the piece above it. */
interface Held {
  id: number;
  stack: number;
  at: Pt;
  moved: boolean;
  start: Pt;
  touch: boolean;
  lift: Lift | null;
}

/**
 * Overlap: the picture is covered by pieces that overlap, each a centre cell and some of the cells around it. Pieces wait in stacks; drag the top one onto the grid, turned the
 * way it lies in the picture, with its centre over its own cell, and it stays and shows its part of the picture. A tap on a piece turns it; the arrows next to a stack shuffle
 * the pieces under it.
 *
 * With friends everybody plays on the same board: what a player does (puts a piece down, turns it, moves it to another stack, shuffles a stack) is sent to the room, and what the others do arrives
 * in its order and is applied here (see core/boardRoom.ts). A piece in hand is on its player's screen only.
 *
 * The board has a camera (zoom with the wheel, two fingers or the buttons; drag the bare board to move it). The stacks do not: they are a panel down the left side of the canvas, in canvas
 * pixels, that scrolls when there are more stacks than fit.
 */
export class OverlapSession implements PuzzleSession {
  readonly rotatable = true;
  private game: OverlapGame;
  private rules: Board;
  private cols: number;
  private rows: number;
  private crop: { sx: number; sy: number; sw: number; sh: number };
  /** The empty board: a radial pattern. A window cell on a piece shows the bit of it that lies under the piece's home. */
  private pattern: HTMLCanvasElement;
  /** The stacks' places in the panel, in the panel's own units (see `trayK`). */
  private slots: Slot[] = [];
  private held: Held | null = null;
  private hoverStack = -1;
  private activeStack = 0;
  private ripples = new Ripples();
  /** How many stacks the pieces wait in: more for a bigger puzzle. */
  private readonly stackN: number;
  private wrong: { cells: { x: number; y: number }[]; at: number } | null = null;
  /** A puzzle made from a video draws its pieces on the graphics card (see videoGl.ts), with the ripples on a canvas over them; both lie over the board's canvas, which has the empty board and the stacks. */
  private layer: VideoLayer | null = null;
  private frontLayer: FrontLayer | null = null;
  private canvasW = 1;
  private canvasH = 1;
  videoFrame?: (now: number) => void;

  // the camera: the board point at the middle of the area right of the panel, and how many canvas pixels a board unit is
  private cam = { zoom: 1, cx: 0, cy: 0 };
  private fitZoom = 1;
  private inited = false;
  private pendingCam: { ratio: number; cx: number; cy: number } | null = null;        // the camera of a saved game, until the canvas has a size
  private cur: View = { scale: 1, ox: 0, oy: 0 };
  // the panel of stacks: its width in canvas pixels, canvas pixels a panel unit is, where the panel's top is on the canvas, how far it is scrolled and how tall all of it is
  private panelW = 0;
  private trayK = 1;
  private trayOy = 0;
  private scroll = 0;
  private listH = 0;
  private scrolling: { y: number; from: number } | null = null;
  private scrollAt = 0;                       // when the panel last scrolled by itself (a held piece near its edge), or 0
  private pan: { anchor: Pt; moved: boolean } | null = null;
  private rightClick = false;                 // the right button is down and has not moved the camera: letting go turns a piece

  constructor(private readonly init: SessionInit) {
    const made = makeOverlap(init.seed, init.width, init.height, init.opts);
    ({ cols: this.cols, rows: this.rows } = made);
    this.stackN = init.opts.stacks;
    this.pattern = makePattern(new Rng((init.seed + 0x9e3779b9) >>> 0), this.cols * CELL * 2, this.rows * CELL * 2);
    this.game = made.game;
    this.rules = { kind: 'overlap', game: made.game, cols: made.cols, rows: made.rows };
    // the picture is cropped to the grid's proportions
    let sw = init.width;
    let sh = init.height;
    if (sw * this.rows > sh * this.cols) sw = (sh * this.cols) / this.rows;
    else sh = (sw * this.rows) / this.cols;
    this.crop = { sx: (init.width - sw) / 2, sy: (init.height - sh) / 2, sw, sh };
    this.activeStack = Math.max(0, this.game.stacks.findIndex((s) => s.length));
    if (init.restore) {
      const saved = init.restore as { layout?: number; game: OverlapState; activeStack: number; cam?: { ratio: number; cx: number; cy: number } };
      if (saved.layout !== LAYOUT && !init.online) throw new Error('not this puzzle');         // made when pieces were L-shaped
      this.game.restore(saved.game);
      if (Number.isInteger(saved.activeStack) && saved.activeStack >= 0 && saved.activeStack < this.game.stacks.length) this.activeStack = saved.activeStack;
      if (saved.cam && [saved.cam.ratio, saved.cam.cx, saved.cam.cy].every(Number.isFinite)) this.pendingCam = saved.cam;
    }
    for (let i = 0; i < this.stackN; i++) this.slots.push({ x: PANEL_PAD, y: PANEL_PAD + i * (SLOT_H + SLOT_GAP) });
    if (init.video && videoGlAvailable()) {
      try {
        this.layer = new VideoLayer(init.video);
        this.layer.setImage(this.pattern);                           // (the window cells of a piece show the empty board)
        this.frontLayer = new FrontLayer();
        this.videoFrame = (now) => void this.drawGl(now);
      } catch {
        this.layer = null;                                           // no graphics card to draw with: the cells are cut from copies of the video's pictures
        this.frontLayer = null;
      }
    }
  }

  get overlay(): HTMLCanvasElement | undefined {
    return this.layer?.canvas;
  }

  get front(): HTMLCanvasElement | undefined {
    return this.frontLayer?.canvas;
  }

  dispose(): void {
    this.layer?.dispose();
  }

  serialize(): unknown {
    return { layout: LAYOUT, game: this.game.snapshot(), activeStack: this.activeStack, cam: this.inited ? { ratio: this.cam.zoom / this.fitZoom, cx: this.cam.cx, cy: this.cam.cy } : this.pendingCam };
  }

  // ---------------------------------------------------------------------------------------------------------------- layout and camera

  private get dpr(): number {
    return window.devicePixelRatio || 1;
  }

  /** The size of the board (the grid; the stacks are not part of it). */
  layout(): { width: number; height: number } {
    return { width: this.cols * CELL, height: this.rows * CELL };
  }

  /** Where the panel of stacks is on a canvas of this size: a third of the width at most, smaller on a narrow screen, and scrolled if its stacks are too many for the height. */
  private place(cw: number, ch: number): void {
    if (this.game.solved) {                                          // nothing is left in the stacks: the board has all the room
      this.panelW = 0;
      return;
    }
    const k = this.dpr;
    this.trayK = Math.min(1, Math.max(0.6, ((cw / k) * 0.3) / PANEL_W)) * k;
    this.panelW = PANEL_W * this.trayK;
    this.listH = (2 * PANEL_PAD + this.stackN * SLOT_H + (this.stackN - 1) * SLOT_GAP) * this.trayK;
    const over = Math.max(0, this.listH - ch);
    this.scroll = Math.min(over, Math.max(0, this.scroll));
    this.trayOy = over > 0 ? -this.scroll : (ch - this.listH) / 2;
  }

  private screen(p: Pt): Pt {
    const v = this.cur;
    return { x: p.x * v.scale + v.ox, y: p.y * v.scale + v.oy };
  }

  private board(s: Pt): Pt {
    const v = this.cur;
    return { x: (s.x - v.ox) / v.scale, y: (s.y - v.oy) / v.scale };
  }

  /** A canvas point as a point of the panel's units, and back. */
  private tray(s: Pt): Pt {
    return { x: s.x / this.trayK, y: (s.y - this.trayOy) / this.trayK };
  }

  private trayScreen(t: Pt): Pt {
    return { x: t.x * this.trayK, y: t.y * this.trayK + this.trayOy };
  }

  private inPanel(s: Pt): boolean {
    return s.x < this.panelW;
  }

  private maxZoom(): number {
    return Math.max(this.fitZoom * 2, 4 * this.dpr);
  }

  view(cw: number, ch: number): View {
    this.canvasW = cw;
    this.canvasH = ch;
    this.place(cw, ch);
    const k = this.dpr;
    const areaW = Math.max(1, cw - this.panelW);
    const fit = Math.max(1e-4, Math.min((areaW - 2 * MARGIN * k) / (this.cols * CELL), (ch - 2 * MARGIN * k) / (this.rows * CELL)));
    if (!this.inited) {
      this.fitZoom = fit;
      this.cam = { zoom: fit, cx: (this.cols * CELL) / 2, cy: (this.rows * CELL) / 2 };
      if (this.pendingCam) {                                         // the camera of a saved game: as far in as it was, looking where it was
        this.cam = { zoom: fit * this.pendingCam.ratio, cx: this.pendingCam.cx, cy: this.pendingCam.cy };
        this.pendingCam = null;
      }
      this.inited = true;
    } else if (fit !== this.fitZoom) {                               // the canvas changed shape: as far in as before, relative to showing everything
      this.cam.zoom *= fit / this.fitZoom;
      this.fitZoom = fit;
    }
    this.cam.zoom = Math.min(this.maxZoom(), Math.max(this.fitZoom, this.cam.zoom));
    this.clampCentre(areaW, ch);
    this.cur = { scale: this.cam.zoom, ox: this.panelW + areaW / 2 - this.cam.cx * this.cam.zoom, oy: ch / 2 - this.cam.cy * this.cam.zoom };
    return this.cur;
  }

  /** Keeps the board in view: the camera may go as far as a margin past the board's edge, and a board that is smaller than the view in one direction stays in the middle of it. */
  private clampCentre(areaW: number, ch: number): void {
    const z = this.cam.zoom;
    const m = (MARGIN * this.dpr) / z;
    const fit = (c: number, size: number, shown: number): number => {
      const half = shown / (2 * z);
      const lo = half - m;
      const hi = size - half + m;
      return lo > hi ? size / 2 : Math.min(hi, Math.max(lo, c));
    };
    this.cam.cx = fit(this.cam.cx, this.cols * CELL, areaW);
    this.cam.cy = fit(this.cam.cy, this.rows * CELL, ch);
  }

  /** Zoom by a factor, keeping the board point `at` where it is on the screen. */
  private zoomAt(at: Pt, factor: number): void {
    const z = Math.min(this.maxZoom(), Math.max(this.fitZoom, this.cam.zoom * factor));
    const k = this.cam.zoom / z;
    this.cam.cx = at.x + (this.cam.cx - at.x) * k;
    this.cam.cy = at.y + (this.cam.cy - at.y) * k;
    this.cam.zoom = z;
    this.clampCentre(Math.max(1, this.canvasW - this.panelW), this.canvasH);
    this.init.requestDraw();
  }

  /** The wheel zooms the board about the pointer, and scrolls the panel of stacks when the pointer is over it. */
  wheel(at: Pt, deltaY: number): void {
    if (this.inPanel(this.screen(at))) {
      this.scroll += deltaY * this.dpr;
      this.place(this.canvasW, this.canvasH);
      this.init.requestDraw();
      return;
    }
    this.zoomAt(at, Math.exp(-deltaY * 0.0015));
  }

  /** Two fingers moved: what was under `from` (canvas pixels) now lies under `to`, and the board is `factor` times bigger. */
  pinch(from: Pt, to: Pt, factor: number): void {
    const areaW = Math.max(1, this.canvasW - this.panelW);
    const mx = this.panelW + areaW / 2;
    const my = this.canvasH / 2;
    const z = Math.min(this.maxZoom(), Math.max(this.fitZoom, this.cam.zoom * factor));
    const wx = this.cam.cx + (from.x - mx) / this.cam.zoom;
    const wy = this.cam.cy + (from.y - my) / this.cam.zoom;
    this.cam.zoom = z;
    this.cam.cx = wx + (mx - to.x) / z;
    this.cam.cy = wy + (my - to.y) / z;
    this.clampCentre(areaW, this.canvasH);
    this.init.requestDraw();
  }

  zoomBy(factor: number): void {
    this.zoomAt({ x: this.cam.cx, y: this.cam.cy }, factor);
  }

  zoomFit(): void {
    this.cam = { zoom: this.fitZoom, cx: (this.cols * CELL) / 2, cy: (this.rows * CELL) / 2 };
    this.init.requestDraw();
  }

  zoomLabel(): string {
    return `${Math.round((this.cam.zoom / this.fitZoom) * 100)}%`;
  }

  /** The width, in board units, of a line that is a pixel or two wide on the screen however far the board is zoomed in (and one unit when it is not). */
  private line(scale: number): number {
    return Math.min(1, 1.5 / scale);
  }

  // ---------------------------------------------------------------------------------------------------------------- drawing

  private cellImage(ctx: CanvasRenderingContext2D, cx: number, cy: number, dx: number, dy: number, size: number): void {
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.cols;
    const h = sh / this.rows;
    drawSlice(ctx, this.init.source, sx + cx * w, sy + cy * h, w, h, dx, dy, size, size);
  }

  /** The bit of the empty board's pattern that lies over picture cell (cx, cy). */
  private patternImage(ctx: CanvasRenderingContext2D, cx: number, cy: number, dx: number, dy: number): void {
    drawSlice(ctx, this.pattern, cx * 2 * CELL, cy * 2 * CELL, 2 * CELL, 2 * CELL, dx, dy, CELL, CELL);
  }

  /**
   * A piece with its centre cell's top-left corner at (ox, oy): each cell shows its own bit of the picture, turned with the piece. A window cell shows the empty board's
   * pattern from the place the piece belongs. With the grid off a piece has no border at all; with it on, each cell has a border `line` wide (in the units the piece is drawn in).
   */
  private drawPiece(ctx: CanvasRenderingContext2D, id: number, ox: number, oy: number, alpha = 1, edge = 'rgba(255,255,255,0.9)', scale = 1, line = scale): void {
    const g = this.game;
    const now = g.cellsNow(id);
    const home = g.homeCells(id);
    const win = g.windowOf(id);
    const turn = (g.rot[id] * Math.PI) / 2;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    ox = oy = 0;
    ctx.globalAlpha = alpha;
    now.forEach((c, k) => {
      ctx.save();
      ctx.translate(ox + c.x * CELL + CELL / 2, oy + c.y * CELL + CELL / 2);
      ctx.rotate(turn);
      if (k === win) this.patternImage(ctx, home[k].x, home[k].y, -CELL / 2, -CELL / 2);
      else this.cellImage(ctx, home[k].x, home[k].y, -CELL / 2, -CELL / 2, CELL);
      ctx.restore();
    });
    if (this.init.flag('grid')) {                                  // with the grid off a piece has no border at all
      const w = line / scale;
      ctx.strokeStyle = edge;
      ctx.lineWidth = w;
      for (const c of now) ctx.strokeRect(ox + c.x * CELL + w / 2, oy + c.y * CELL + w / 2, CELL - w, CELL - w);
    }
    ctx.restore();
  }

  /** The colour of an outline given as CSS, as the graphics layer takes it. */
  private static colour(edge: string): [number, number, number, number] {
    return edge === '#ffd84a' ? rgba(255, 216, 74) : rgba(255, 255, 255, 0.9);
  }

  /**
   * A piece as drawPiece draws it, on the graphics card: each cell turned with the piece, a window cell showing the empty board, the thin outline of each cell (grid on) and, for the piece
   * in hand, its shadow (a few see-through rectangles that spread, in place of the blur of a 2D canvas). `shadow` is how many board units a pixel is, or 0 for none.
   */
  private drawPieceGl(L: VideoLayer, id: number, ox: number, oy: number, scale: number, edge: string, line: number, shadow = 0): void {
    const g = this.game;
    const cells = g.cellsNow(id);
    const home = g.homeCells(id);
    const win = g.windowOf(id);
    const turn = g.rot[id];
    const size = CELL * scale;
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.cols;
    const h = sh / this.rows;
    const iw = this.init.width;
    const ih = this.init.height;
    if (shadow > 0) {
      for (const [spread, alpha] of [[8, 0.08], [4, 0.1], [1, 0.12]]) {
        const d = spread * shadow;
        for (const c of cells) L.fill(ox + c.x * size - d, oy + c.y * size + 6 * shadow - d, size + 2 * d, size + 2 * d, rgba(0, 0, 0, alpha));
      }
    }
    cells.forEach((c, k) => {
      const hx = home[k].x;
      const hy = home[k].y;
      const cx = ox + c.x * size + size / 2;
      const cy = oy + c.y * size + size / 2;
      if (k === win) L.turned(cx, cy, size / 2, turn, hx / this.cols, hy / this.rows, (hx + 1) / this.cols, (hy + 1) / this.rows, true);
      else L.turned(cx, cy, size / 2, turn, (sx + hx * w) / iw, (sy + hy * h) / ih, (sx + (hx + 1) * w) / iw, (sy + (hy + 1) * h) / ih);
    });
    if (this.init.flag('grid')) {
      const colour = OverlapSession.colour(edge);
      for (const c of cells) L.frame(ox + c.x * size + line / 2, oy + c.y * size + line / 2, size - line, size - line, line, colour);
    }
  }

  /**
   * What lies over the board's canvas for a video puzzle, in the order a 2D canvas would draw it: the cells that show, the grid, the board's edge and the red flash of a wrong move (all
   * of them only where the panel of stacks is not), then the stacks' top pieces and the piece in hand, whose places are in canvas pixels and so are turned into board units here.
   */
  private drawGl(now: number): void {
    const L = this.layer!;
    const g = this.game;
    const v = this.cur;
    if (!L.begin(this.canvasW, this.canvasH, v)) return;
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.cols;
    const h = sh / this.rows;
    const iw = this.init.width;
    const ih = this.init.height;
    const line = this.line(v.scale);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        if (g.revealed[cy * this.cols + cx] || g.solved) L.quad(cx * CELL, cy * CELL, CELL, CELL, (sx + cx * w) / iw, (sy + cy * h) / ih, (sx + (cx + 1) * w) / iw, (sy + (cy + 1) * h) / ih);
      }
    }
    if (this.init.flag('grid')) {
      const faint = rgba(255, 255, 255, 0.22);
      for (let cx = 0; cx <= this.cols; cx++) L.fill(cx * CELL, 0, line, gh, faint);
      for (let cy = 0; cy <= this.rows; cy++) L.fill(0, cy * CELL, gw, line, faint);
    }
    const edge = Math.min(3, 4 / v.scale);
    L.frame(-edge / 2, -edge / 2, gw + edge, gh + edge, edge, rgba(0x6b, 0x4a, 0x36));
    if (this.wrong) {
      const k = 1 - (now - this.wrong.at) / WRONG_MS;
      if (k > 0) for (const c of this.wrong.cells) L.fill(c.x * CELL, c.y * CELL, CELL, CELL, rgba(230, 60, 40, 0.45 * k));
    }
    L.clipBefore(this.panelW);
    if (g.solved) {
      L.end();
      return;
    }
    const px = 1 / v.scale;
    const stack = SLOT_SCALE * this.trayK;                           // canvas pixels a cell of a piece in a stack is, over CELL
    for (let s = 0; s < this.stackN; s++) {
      const top = g.top(s);
      if (top < 0 || (this.held && this.held.id === top)) continue;
      const at = this.trayScreen(this.slotCentre(s));
      if (at.y + 2 * CELL * stack < 0 || at.y - CELL * stack > this.canvasH) continue;          // scrolled out of sight
      const b = this.board(at);
      this.drawPieceGl(L, top, b.x, b.y, stack * px, 'rgba(255,255,255,0.9)', stack * px);
    }
    const held = this.held;
    if (held?.moved) {
      const at = this.heldPoint(held, now);
      const shadow = this.init.flag('grid') ? px : 0;
      if (this.inPanel(at)) {                                        // over the stacks: the size it has in a stack
        const b = this.board({ x: at.x - (CELL * stack) / 2, y: at.y - (CELL * stack) / 2 });
        this.drawPieceGl(L, held.id, b.x, b.y, stack * px, '#ffd84a', stack * px, shadow);
      } else {
        const box = this.heldBox(at);
        this.drawPieceGl(L, held.id, box.x, box.y, 1, '#ffd84a', line, shadow);
      }
    }
    L.end();
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    this.cur = view;
    this.canvasW = ctx.canvas.width;
    this.canvasH = ctx.canvas.height;
    const gpu = !!this.layer && !!this.frontLayer;
    let running = false;
    const g = this.game;
    if (this.held?.moved && !g.solved && this.autoScroll(now)) running = true;
    else this.scrollAt = 0;
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    const grid = this.init.flag('grid');
    const line = this.line(view.scale);
    // the board: the empty board's pattern where the picture does not show yet
    ctx.drawImage(this.pattern, 0, 0, gw, gh);                                   // the empty board, in one piece (no seams), then the revealed cells over it
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        if ((g.revealed[cy * this.cols + cx] || g.solved) && !gpu) this.cellImage(ctx, cx, cy, cx * CELL, cy * CELL, CELL);
      }
    }
    if (grid && !gpu) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = line;
      ctx.beginPath();
      for (let cx = 0; cx <= this.cols; cx++) {
        ctx.moveTo(cx * CELL + line / 2, 0);
        ctx.lineTo(cx * CELL + line / 2, gh);
      }
      for (let cy = 0; cy <= this.rows; cy++) {
        ctx.moveTo(0, cy * CELL + line / 2);
        ctx.lineTo(gw, cy * CELL + line / 2);
      }
      ctx.stroke();
    }
    if (!gpu) {
      const edge = Math.min(3, 4 / view.scale);
      ctx.strokeStyle = '#6b4a36';
      ctx.lineWidth = edge;
      ctx.strokeRect(-edge / 2, -edge / 2, gw + edge, gh + edge);
      if (this.ripples.draw(ctx, now)) running = true;
    }
    if (this.wrong) {
      const k = 1 - (now - this.wrong.at) / WRONG_MS;
      if (k > 0) {
        if (!gpu) {
          ctx.fillStyle = `rgba(230,60,40,${0.45 * k})`;
          for (const c of this.wrong.cells) ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
        }
        running = true;
      } else this.wrong = null;
    }
    if (!g.solved) {
      this.drawPanel(ctx);                                                      // (over what the board has drawn under it)
      if (this.held) {
        if (!gpu) this.drawHeld(ctx, now);
        if (this.held.lift && !this.held.lift.done(now)) running = true;           // a piece a finger has picked up is still rising
      }
    }
    if (gpu) {                                                                    // the pieces, over what the canvas has drawn, and the ripples over them
      this.drawGl(now);
      if (this.ripples.draw(this.frontLayer!.begin(this.canvasW, this.canvasH, view, this.panelW), now)) running = true;
    }
    return running;
  }

  /** The panel of stacks down the left side, in canvas pixels: its background, the stacks, and a thin bar that says how far it is scrolled. */
  private drawPanel(ctx: CanvasRenderingContext2D): void {
    const k = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#211611';
    ctx.fillRect(0, 0, this.panelW, this.canvasH);
    ctx.fillStyle = '#6b4a36';
    ctx.fillRect(this.panelW - k, 0, k, this.canvasH);
    ctx.setTransform(this.trayK, 0, 0, this.trayK, 0, this.trayOy);
    for (let s = 0; s < this.stackN; s++) this.drawSlot(ctx, s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.listH > this.canvasH) {
      const thumb = Math.max(24 * k, (this.canvasH * this.canvasH) / this.listH);
      const y = (this.scroll / (this.listH - this.canvasH)) * (this.canvasH - thumb);
      ctx.fillStyle = 'rgba(240,217,181,0.35)';
      ctx.beginPath();
      ctx.roundRect(this.panelW - 5 * k, y, 3 * k, thumb, 2 * k);
      ctx.fill();
    }
  }

  /** A piece held near the top or bottom of the panel scrolls it, faster the closer it is to the edge; true while it does. */
  private autoScroll(now: number): boolean {
    const h = this.held!;
    const at = this.heldPoint(h, now);
    if (!this.inPanel(at) || this.listH <= this.canvasH) return false;
    const zone = EDGE * this.dpr;
    const speed = at.y < zone ? -(zone - at.y) / zone : at.y > this.canvasH - zone ? (at.y - (this.canvasH - zone)) / zone : 0;
    if (!speed) return false;
    const dt = this.scrollAt ? Math.min(0.05, (now - this.scrollAt) / 1000) : 0;
    this.scrollAt = now;
    const before = this.scroll;
    this.scroll += Math.min(1, speed) * SCROLL_SPEED * this.dpr * dt;
    this.place(this.canvasW, this.canvasH);
    return this.scroll !== before || dt === 0;
  }

  private drawSlot(ctx: CanvasRenderingContext2D, s: number): void {
    const slot = this.slots[s];
    const g = this.game;
    const target = this.held?.moved && this.drawerOf(this.heldPoint(this.held, performance.now())) === s;          // a held piece is over this drawer
    ctx.fillStyle = target ? '#4a2c1a' : s === this.activeStack ? '#3a2519' : '#2a1b14';
    ctx.strokeStyle = target || s === this.activeStack ? '#ffd84a' : '#6b4a36';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(slot.x + 1, slot.y + 1, SLOT_W - 2, SLOT_H - 2, 10);
    ctx.fill();
    ctx.stroke();
    const top = g.top(s);
    if (top >= 0 && !(this.held && this.held.id === top) && !this.layer) {
      const at = this.slotCentre(s);
      this.drawPiece(ctx, top, at.x, at.y, 1, 'rgba(255,255,255,0.9)', SLOT_SCALE);
    }
    ctx.fillStyle = '#a8896a';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(top < 0 ? 'empty' : `${g.stacks[s].length} left`, slot.x + 10, slot.y + SLOT_H - 6);
    // the arrows: up brings the bottom piece to the top, down sends the top piece to the bottom
    if (g.stacks[s].length > 1) {
      ctx.fillStyle = '#c8793a';
      this.arrow(ctx, this.arrowRect(s, true), true);
      this.arrow(ctx, this.arrowRect(s, false), false);
    }
  }

  private arrowRect(s: number, up: boolean): { x: number; y: number; w: number; h: number } {
    const slot = this.slots[s];
    return { x: slot.x + 112, y: slot.y + (up ? 20 : 62), w: 26, h: 26 };
  }

  private arrow(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, up: boolean): void {
    ctx.save();
    ctx.fillStyle = '#5a2e16';
    ctx.strokeStyle = '#c8793a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f0d9b5';
    ctx.beginPath();
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (up) ctx.moveTo(cx, cy - 6), ctx.lineTo(cx + 7, cy + 5), ctx.lineTo(cx - 7, cy + 5);
    else ctx.moveTo(cx, cy + 6), ctx.lineTo(cx + 7, cy - 5), ctx.lineTo(cx - 7, cy - 5);
    ctx.fill();
    ctx.restore();
  }

  /** The top-left corner of the centre cell of a stack's top piece, in the panel's units (it reaches a cell out from there in every direction). */
  private slotCentre(s: number): Pt {
    const slot = this.slots[s];
    return { x: slot.x + SLOT_PAD + CELL * SLOT_SCALE, y: slot.y + PIECE_Y + CELL * SLOT_SCALE };
  }

  /**
   * Where the held piece's centre cell goes on the board, from where the piece is on the canvas: snapped to the cell under it when that is on the grid (and not under the panel), else
   * centred on it.
   */
  private heldBox(at: Pt): { x: number; y: number; cell: Pt | null } {
    const b = this.board(at);
    const over = !this.inPanel(at) && b.x >= 0 && b.y >= 0 && b.x < this.cols * CELL && b.y < this.rows * CELL;
    if (over) {
      const x = Math.floor(b.x / CELL);
      const y = Math.floor(b.y / CELL);
      return { x: x * CELL, y: y * CELL, cell: { x, y } };
    }
    return { x: b.x - CELL / 2, y: b.y - CELL / 2, cell: null };
  }

  /** Where the held piece is on the canvas: at the pointer, or - held by a finger - a little above it. */
  private heldPoint(h: Held, now: number): Pt {
    return h.lift ? h.lift.held(h.at, now) : h.at;
  }

  private drawHeld(ctx: CanvasRenderingContext2D, now: number): void {
    const h = this.held;
    if (!h || !h.moved) return;
    const at = this.heldPoint(h, now);
    ctx.save();
    if (this.init.flag('grid')) {                                  // (with the grid off the held piece has no shadow either)
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
    }
    if (this.inPanel(at)) {                                        // over the stacks: the size it has in a stack
      const s = SLOT_SCALE * this.trayK;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.drawPiece(ctx, h.id, at.x - (CELL * s) / 2, at.y - (CELL * s) / 2, 1, '#ffd84a', s);          // (full colour: a window tile looks the same held, in its stack and on the board)
    } else {
      const box = this.heldBox(at);
      const v = this.cur;
      ctx.setTransform(v.scale, 0, 0, v.scale, v.ox, v.oy);
      this.drawPiece(ctx, h.id, box.x, box.y, 1, '#ffd84a', 1, this.line(v.scale));
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  private slotAt(t: Pt): number {
    return this.slots.findIndex((s) => t.x >= s.x && t.y >= s.y && t.x < s.x + SLOT_W && t.y < s.y + SLOT_H);
  }

  /** The stack under a point of the canvas (-1: none, also for a point that is not over the panel). */
  private drawerOf(s: Pt): number {
    return this.inPanel(s) ? this.slotAt(this.tray(s)) : -1;
  }

  pointerDown(p: Pt, touch = false): void {
    const g = this.game;
    const s = this.screen(p);
    if (g.solved || !this.inPanel(s)) {                            // bare board: a drag moves the camera
      this.pan = { anchor: p, moved: false };
      return;
    }
    const t = this.tray(s);
    const i = this.slotAt(t);
    if (i >= 0) {
      this.activeStack = i;
      for (const up of [true, false]) {
        const r = this.arrowRect(i, up);
        if (g.stacks[i].length > 1 && t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h) {
          g.cycle(i, up ? -1 : 1);
          this.init.online?.send({ t: 'cycle', stack: i, dir: up ? -1 : 1 });
          buzz(this.init, 'turn');
          this.init.requestDraw();
          return;
        }
      }
      const top = g.top(i);
      const slot = this.slots[i];
      const reach = 3 * CELL * SLOT_SCALE;
      if (top >= 0 && t.x >= slot.x + SLOT_PAD && t.x < slot.x + SLOT_PAD + reach && t.y >= slot.y + PIECE_Y && t.y < slot.y + PIECE_Y + reach) {
        this.held = { id: top, stack: i, at: s, moved: false, start: s, touch, lift: null };
        buzz(this.init, 'grab');
        playEffect('pickup');
        this.init.requestDraw();
        return;
      }
    }
    this.scrolling = { y: s.y, from: this.scroll };                // anywhere else in the panel: a drag scrolls it
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    const s = this.screen(p);
    this.hoverStack = this.drawerOf(s);
    if (this.scrolling) {
      this.scroll = this.scrolling.from - (s.y - this.scrolling.y);
      this.place(this.canvasW, this.canvasH);
      this.init.requestDraw();
      return;
    }
    if (this.pan) {
      this.panTo(p);
      return;
    }
    const h = this.held;
    if (!h) return;
    h.at = s;
    if (!h.moved && Math.hypot(s.x - h.start.x, s.y - h.start.y) > TAP * this.dpr) {
      h.moved = true;
      h.lift = startLift(this.init, h.touch, UNIT, performance.now());          // a finger lifts the piece above itself from here on (a tap does not); canvas pixels, as the piece is held in
    }
    this.init.requestDraw();
  }

  private panTo(p: Pt): void {
    const pan = this.pan!;
    if (!pan.moved && Math.hypot(p.x - pan.anchor.x, p.y - pan.anchor.y) * this.cam.zoom < TAP * this.dpr) return;
    pan.moved = true;
    this.cam.cx += pan.anchor.x - p.x;                             // the board point that was under the pointer stays under it
    this.cam.cy += pan.anchor.y - p.y;
    this.clampCentre(Math.max(1, this.canvasW - this.panelW), this.canvasH);
    this.init.requestDraw();
  }

  pointerUp(p: Pt): void {
    this.scrolling = null;
    this.pan = null;
    const h = this.held;
    if (!h) {
      this.init.requestDraw();
      return;
    }
    this.held = null;
    h.at = this.screen(p);
    const g = this.game;
    if (!h.moved) {                                           // a tap turns the piece (the press has buzzed already: a second buzz would only cancel it)
      g.rotate(h.id);
      this.init.online?.send({ t: 'turn', piece: h.id });
    } else {
      const at = this.heldPoint(h, performance.now());       // where the piece is, which is not where a finger is
      const box = this.heldBox(at);
      const drawer = this.drawerOf(at);
      if (drawer >= 0) {                                      // put down on a drawer (its own or another): the piece goes on top of it
        g.moveToStack(h.id, drawer);
        this.init.online?.send({ t: 'toStack', piece: h.id, stack: drawer });
        this.activeStack = drawer;
        buzz(this.init, 'drop');
      } else if (box.cell) {
        if (g.drop(h.id, box.cell.x, box.cell.y) === 'placed') {
          this.ripples.add(g.cellsNow(h.id).map((c) => ({ x: (box.cell!.x + c.x) * CELL, y: (box.cell!.y + c.y) * CELL, w: CELL, h: CELL })), performance.now());
          buzz(this.init, g.solved ? 'solved' : 'placed');
          if (!g.solved) playEffect('placed');                    // (the end of the puzzle has its own sound)
          this.init.online?.send({ t: 'put', piece: h.id, x: box.cell.x, y: box.cell.y });          // (a piece that did not fit is not news to the others: it is back on its stack)
        } else {
          const cell = box.cell;
          this.wrong = { cells: g.cellsNow(h.id).map((c) => ({ x: cell.x + c.x, y: cell.y + c.y })).filter((c) => c.x >= 0 && c.y >= 0 && c.x < this.cols && c.y < this.rows), at: performance.now() };
          buzz(this.init, 'drop');
          playEffect('wrong');                                    // it does not go there: it is back on its stack
        }
      } else buzz(this.init, 'drop');
    }
    this.init.requestDraw();
  }

  pointerCancel(): void {
    this.held = null;
    this.scrolling = null;
    this.pan = null;
    this.rightClick = false;
    this.init.requestDraw();
  }

  /** A piece is in hand: a second finger then turns it instead of starting a pinch. */
  holding(): boolean {
    return !!this.held;
  }

  /** The right button: a drag on the board moves the camera, a click turns a piece. */
  rightDown(p: Pt): void {
    this.rightClick = true;
    if (!this.inPanel(this.screen(p))) this.pan = { anchor: p, moved: false };
  }

  rightMove(p: Pt): void {
    if (this.pan) this.panTo(p);
  }

  rightUp(): void {
    if (this.rightClick && !this.pan?.moved) this.secondary();
    this.rightClick = false;
    this.pan = null;
  }

  secondary(): void {
    const g = this.game;
    if (g.solved) return;
    const id = this.held ? this.held.id : g.top(this.hoverStack >= 0 ? this.hoverStack : this.activeStack);
    g.rotate(id);
    if (id >= 0 && !g.done[id]) this.init.online?.send({ t: 'turn', piece: id });
    buzz(this.init, 'turn');
    this.init.requestDraw();
  }

  status(): string {
    return `${this.game.total - this.game.remaining} / ${this.game.total} placed`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {
    this.init.requestDraw();
  }

  // ---------------------------------------------------------------------------------------------------------------- with friends

  /** Another player's operation (the room checked it and put it in order). A piece that was put in its place gets its ripple. */
  applyEvent(ev: RoomEvent): void {
    const op = ev.op as BoardOp | undefined;
    if (!op) return;
    const res = applyBoardOp(this.rules, op);
    if (!res.ok) return;
    if (op.t === 'put' && res.placed) {
      this.ripples.add(this.game.cellsNow(op.piece).map((c) => ({ x: (op.x + c.x) * CELL, y: (op.y + c.y) * CELL, w: CELL, h: CELL })), performance.now());
    }
    this.afterOthers();
  }

  /** Takes the room's board in place of this one. */
  resync(state: RoomState): void {
    try {
      this.game.restore(state.game as OverlapState);
    } catch {
      return;                                                     // (the room's board is this puzzle's: this does not happen)
    }
    if (this.activeStack >= this.stackN) this.activeStack = 0;
    this.afterOthers();
  }

  /** The board changed under this player's hand: a piece in hand that was put in its place by someone else is not in hand any more. */
  private afterOthers(): void {
    if (this.held && this.game.done[this.held.id]) this.held = null;
    this.init.requestDraw();
    this.init.progress?.();
  }

  groupCount(): number {
    return boardCheck(this.rules);
  }
}
