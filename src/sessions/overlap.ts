import { generateOverlap, OverlapGame, overlapGrid, type OverlapState } from '../core/overlap';
import { Rng } from '../core/rng';
import { makePattern } from './patterns';
import { Ripples } from './ripple';
import { beginFrame, drawSlice, type View } from '../render';
import { buzz, startLift, type Lift } from './feedback';
import type { Pt, PuzzleSession, SessionInit } from './types';

const CELL = 50;
const SLOT_W = 144;
const SLOT_H = 130;
const GAP = 18;
const PIECE_Y = 3;             // a piece in a stack sits this far below the top of its slot, clear of the label under it
const SLOT_SCALE = 0.7;        // a piece in a stack is drawn this much smaller than on the board: it reaches a cell out from its centre in every direction
const SLOT_PAD = 4;
/** Bumped when pieces changed what they are: a puzzle that was saved with older ones starts again. */
const LAYOUT = 2;
const TAP = 6;                 // a press that moves less than this is a tap (it turns the piece)
const WRONG_MS = 350;

interface Slot {
  x: number;
  y: number;
}

/** The piece in hand: where the pointer is, whether it has moved (else a tap), and - for a finger - the lift that holds the piece above it. */
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
 */
export class OverlapSession implements PuzzleSession {
  readonly rotatable = true;
  private game: OverlapGame;
  private cols: number;
  private rows: number;
  private crop: { sx: number; sy: number; sw: number; sh: number };
  /** The empty board: a radial pattern. A window cell on a piece shows the bit of it that lies under the piece's home. */
  private pattern: HTMLCanvasElement;
  private mode: 'side' | 'top' = 'side';
  private gridX = 0;
  private gridY = 0;
  private slots: Slot[] = [];
  private held: Held | null = null;
  private lastView: View = { scale: 1, ox: 0, oy: 0 };
  private hoverStack = -1;
  private activeStack = 0;
  private ripples = new Ripples();
  /** How many stacks the pieces wait in: more for a bigger puzzle. */
  private readonly stackN: number;
  private wrong: { cells: { x: number; y: number }[]; at: number } | null = null;

  constructor(private readonly init: SessionInit) {
    ({ cols: this.cols, rows: this.rows } = overlapGrid(init.opts.total, init.width, init.height));
    this.stackN = init.opts.stacks;
    const setup = generateOverlap(new Rng(init.seed), { cols: this.cols, rows: this.rows, turned: init.opts.turned === 1, placed: init.opts.placed, windows: init.opts.windows === 1, stacks: this.stackN });
    this.pattern = makePattern(new Rng((init.seed + 0x9e3779b9) >>> 0), this.cols * CELL * 2, this.rows * CELL * 2);
    this.game = new OverlapGame(setup);
    // the picture is cropped to the grid's proportions
    let sw = init.width;
    let sh = init.height;
    if (sw * this.rows > sh * this.cols) sw = (sh * this.cols) / this.rows;
    else sh = (sw * this.rows) / this.cols;
    this.crop = { sx: (init.width - sw) / 2, sy: (init.height - sh) / 2, sw, sh };
    this.activeStack = Math.max(0, this.game.stacks.findIndex((s) => s.length));
    if (init.restore) {
      const saved = init.restore as { layout?: number; game: OverlapState; activeStack: number };
      if (saved.layout !== LAYOUT) throw new Error('not this puzzle');         // made when pieces were L-shaped
      this.game.restore(saved.game);
      if (Number.isInteger(saved.activeStack) && saved.activeStack >= 0 && saved.activeStack < this.game.stacks.length) this.activeStack = saved.activeStack;
    }
    this.arrange('side');
  }

  serialize(): unknown {
    return { layout: LAYOUT, game: this.game.snapshot(), activeStack: this.activeStack };
  }

  // ---------------------------------------------------------------------------------------------------------------- layout

  private sizeFor(mode: 'side' | 'top'): { width: number; height: number } {
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    if (mode === 'side') return { width: SLOT_W + GAP + gw, height: Math.max(gh, this.stackN * SLOT_H + (this.stackN - 1) * 10) };
    return { width: Math.max(gw, this.stackN * SLOT_W + (this.stackN - 1) * 10), height: SLOT_H + GAP + gh };
  }

  /** Puts the stacks beside the grid on a wide canvas and above it on a tall one - whichever lets the board be bigger. */
  layout(cw: number, ch: number): { width: number; height: number } {
    const fit = (m: 'side' | 'top') => {
      const s = this.sizeFor(m);
      return Math.min(cw / s.width, ch / s.height);
    };
    this.arrange(fit('side') >= fit('top') ? 'side' : 'top');
    return this.sizeFor(this.mode);
  }

  private arrange(mode: 'side' | 'top'): void {
    this.mode = mode;
    const size = this.sizeFor(mode);
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    this.slots = [];
    if (mode === 'side') {
      this.gridX = SLOT_W + GAP;
      this.gridY = (size.height - gh) / 2;
      const total = this.stackN * SLOT_H + (this.stackN - 1) * 10;
      const y0 = (size.height - total) / 2;
      for (let i = 0; i < this.stackN; i++) this.slots.push({ x: 0, y: y0 + i * (SLOT_H + 10) });
    } else {
      this.gridX = (size.width - gw) / 2;
      this.gridY = SLOT_H + GAP;
      const total = this.stackN * SLOT_W + (this.stackN - 1) * 10;
      const x0 = (size.width - total) / 2;
      for (let i = 0; i < this.stackN; i++) this.slots.push({ x: x0 + i * (SLOT_W + 10), y: 0 });
    }
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
   * pattern from the place the piece belongs. With the grid off a piece has no border at all.
   */
  private drawPiece(ctx: CanvasRenderingContext2D, id: number, ox: number, oy: number, alpha = 1, edge = 'rgba(255,255,255,0.9)', scale = 1): void {
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
    if (this.init.flag('grid')) {                                  // with the grid off a piece has no border at all; with it on, a line as thin as the board's own grid lines
      ctx.strokeStyle = edge;
      ctx.lineWidth = 1;
      for (const c of now) ctx.strokeRect(ox + c.x * CELL + 0.5, oy + c.y * CELL + 0.5, CELL - 1, CELL - 1);
    }
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    this.lastView = view;
    let running = false;
    const g = this.game;
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    const grid = this.init.flag('grid');
    // the board: the empty board's pattern where the picture does not show yet
    ctx.drawImage(this.pattern, this.gridX, this.gridY, gw, gh);                // the empty board, in one piece (no seams), then the revealed cells over it
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = cy * this.cols + cx;
        const x = this.gridX + cx * CELL;
        const y = this.gridY + cy * CELL;
        if (g.revealed[i] || g.solved) {
          this.cellImage(ctx, cx, cy, x, y, CELL);
        }
      }
    }
    if (grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let cx = 0; cx <= this.cols; cx++) {
        ctx.moveTo(this.gridX + cx * CELL + 0.5, this.gridY);
        ctx.lineTo(this.gridX + cx * CELL + 0.5, this.gridY + gh);
      }
      for (let cy = 0; cy <= this.rows; cy++) {
        ctx.moveTo(this.gridX, this.gridY + cy * CELL + 0.5);
        ctx.lineTo(this.gridX + gw, this.gridY + cy * CELL + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#6b4a36';
    ctx.lineWidth = 3;
    ctx.strokeRect(this.gridX - 1.5, this.gridY - 1.5, gw + 3, gh + 3);
    if (this.ripples.draw(ctx, now)) running = true;
    if (this.wrong) {
      const k = 1 - (now - this.wrong.at) / WRONG_MS;
      if (k > 0) {
        ctx.fillStyle = `rgba(230,60,40,${0.45 * k})`;
        for (const c of this.wrong.cells) ctx.fillRect(this.gridX + c.x * CELL, this.gridY + c.y * CELL, CELL, CELL);
        running = true;
      } else this.wrong = null;
    }
    // the stacks
    if (!g.solved) {
      for (let s = 0; s < this.stackN; s++) this.drawSlot(ctx, s);
      if (this.held) {
        this.drawHeld(ctx, now);
        if (this.held.lift && !this.held.lift.done(now)) running = true;           // a piece a finger has picked up is still rising
      }
    }
    return running;
  }

  private drawSlot(ctx: CanvasRenderingContext2D, s: number): void {
    const slot = this.slots[s];
    const g = this.game;
    const target = this.held?.moved && this.slotAt(this.held.at) === s;          // a held piece is over this drawer
    ctx.fillStyle = target ? '#4a2c1a' : s === this.activeStack ? '#3a2519' : '#2a1b14';
    ctx.strokeStyle = target || s === this.activeStack ? '#ffd84a' : '#6b4a36';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(slot.x + 1, slot.y + 1, SLOT_W - 2, SLOT_H - 2, 10);
    ctx.fill();
    ctx.stroke();
    const top = g.top(s);
    if (top >= 0 && !(this.held && this.held.id === top)) {
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

  /** The top-left corner of the centre cell of a stack's top piece (it reaches a cell out from there in every direction). */
  private slotCentre(s: number): Pt {
    const slot = this.slots[s];
    return { x: slot.x + SLOT_PAD + CELL * SLOT_SCALE, y: slot.y + PIECE_Y + CELL * SLOT_SCALE };
  }

  /** Where the held piece's centre cell goes: snapped to the cell under the pointer when that is on the grid, else centred on the pointer. */
  private heldBox(h: { at: Pt }): { x: number; y: number; cell: Pt | null } {
    const over = h.at.x >= this.gridX && h.at.y >= this.gridY && h.at.x < this.gridX + this.cols * CELL && h.at.y < this.gridY + this.rows * CELL;
    if (over) {
      const x = Math.floor((h.at.x - this.gridX) / CELL);
      const y = Math.floor((h.at.y - this.gridY) / CELL);
      return { x: this.gridX + x * CELL, y: this.gridY + y * CELL, cell: { x, y } };
    }
    return { x: h.at.x - CELL / 2, y: h.at.y - CELL / 2, cell: null };
  }

  /** Where the held piece is: at the pointer, or - held by a finger - a little above it. */
  private heldPoint(h: Held, now: number): Pt {
    return h.lift ? h.lift.held(h.at, now) : h.at;
  }

  private drawHeld(ctx: CanvasRenderingContext2D, now: number): void {
    const h = this.held;
    if (!h || !h.moved) return;
    const box = this.heldBox({ at: this.heldPoint(h, now) });
    ctx.save();
    if (this.init.flag('grid')) {                                  // (with the grid off the held piece has no shadow either)
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
    }
    this.drawPiece(ctx, h.id, box.x, box.y, 1, '#ffd84a');          // (full colour: a window tile looks the same held, in its stack and on the board)
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  private slotAt(p: Pt): number {
    return this.slots.findIndex((s) => p.x >= s.x && p.y >= s.y && p.x < s.x + SLOT_W && p.y < s.y + SLOT_H);
  }

  pointerDown(p: Pt, touch = false): void {
    const g = this.game;
    if (g.solved) return;
    const s = this.slotAt(p);
    if (s < 0) return;
    this.activeStack = s;
    for (const up of [true, false]) {
      const r = this.arrowRect(s, up);
      if (g.stacks[s].length > 1 && p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h) {
        g.cycle(s, up ? -1 : 1);
        buzz(this.init, 'turn');
        this.init.requestDraw();
        return;
      }
    }
    const top = g.top(s);
    const slot = this.slots[s];
    const reach = 3 * CELL * SLOT_SCALE;
    if (top >= 0 && p.x >= slot.x + SLOT_PAD && p.x < slot.x + SLOT_PAD + reach && p.y >= slot.y + PIECE_Y && p.y < slot.y + PIECE_Y + reach) {
      this.held = { id: top, stack: s, at: p, moved: false, start: p, touch, lift: null };
      buzz(this.init, 'grab');
    }
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    const s = this.slotAt(p);
    if (s !== this.hoverStack) this.hoverStack = s;
    const h = this.held;
    if (!h) return;
    h.at = p;
    if (!h.moved && Math.hypot(p.x - h.start.x, p.y - h.start.y) > TAP) {
      h.moved = true;
      h.lift = startLift(this.init, h.touch, this.lastView, performance.now());          // a finger lifts the piece above itself from here on (a tap does not)
    }
    this.init.requestDraw();
  }

  pointerUp(p: Pt): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    h.at = p;
    const g = this.game;
    if (!h.moved) {                                           // a tap turns the piece (the press has buzzed already: a second buzz would only cancel it)
      g.rotate(h.id);
    } else {
      const at = this.heldPoint(h, performance.now());       // where the piece is, which is not where a finger is
      const box = this.heldBox({ at });
      const drawer = this.slotAt(at);
      if (drawer >= 0) {                                      // put down on a drawer (its own or another): the piece goes on top of it
        g.moveToStack(h.id, drawer);
        this.activeStack = drawer;
        buzz(this.init, 'drop');
      } else if (box.cell) {
        if (g.drop(h.id, box.cell.x, box.cell.y) === 'placed') {
          this.ripples.add(g.cellsNow(h.id).map((c) => ({ x: this.gridX + (box.cell!.x + c.x) * CELL, y: this.gridY + (box.cell!.y + c.y) * CELL, w: CELL, h: CELL })), performance.now());
          buzz(this.init, g.solved ? 'solved' : 'placed');
        } else {
          const cell = box.cell;
          this.wrong = { cells: g.cellsNow(h.id).map((c) => ({ x: cell.x + c.x, y: cell.y + c.y })).filter((c) => c.x >= 0 && c.y >= 0 && c.x < this.cols && c.y < this.rows), at: performance.now() };
          buzz(this.init, 'drop');
        }
      } else buzz(this.init, 'drop');
    }
    this.init.requestDraw();
  }

  pointerCancel(): void {
    this.held = null;
    this.init.requestDraw();
  }

  secondary(): void {
    const g = this.game;
    if (g.solved) return;
    const id = this.held ? this.held.id : g.top(this.hoverStack >= 0 ? this.hoverStack : this.activeStack);
    g.rotate(id);
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
}
