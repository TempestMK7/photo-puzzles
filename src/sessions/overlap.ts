import { generateOverlap, OverlapGame, STACKS } from '../core/overlap';
import { Rng } from '../core/rng';
import { makePattern } from './patterns';
import { beginFrame, type View } from '../render';
import type { Pt, PuzzleSession, SessionInit } from './types';

const CELL = 50;
const SLOT_W = 144;
const SLOT_H = 130;
const GAP = 18;
const TAP = 6;                 // a press that moves less than this is a tap (it turns the piece)
const FLASH_MS = 500;
const WRONG_MS = 350;

interface Slot {
  x: number;
  y: number;
}

/**
 * Overlap: the picture is covered by L-shaped pieces that overlap. Pieces wait in stacks; drag the top one onto the grid, turned the way it lies in the picture,
 * and it stays and shows its part of the picture. A tap on a piece turns it; the arrows next to a stack shuffle the pieces under it.
 */
export class OverlapSession implements PuzzleSession {
  readonly toggles = [{ key: 'grid', label: 'Grid', title: 'Grid lines' }];
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
  private held: { id: number; stack: number; at: Pt; moved: boolean; start: Pt } | null = null;
  private hoverStack = -1;
  private activeStack = 0;
  private flash = new Map<number, number>();
  private wrong: { bx: number; by: number; at: number } | null = null;

  constructor(private readonly init: SessionInit) {
    this.cols = init.opts.cells;
    this.rows = Math.min(12, Math.max(3, Math.round((this.cols * init.height) / init.width)));
    const setup = generateOverlap(new Rng(init.seed), { cols: this.cols, rows: this.rows, turned: init.opts.turned === 1, placed: init.opts.placed, windows: init.opts.windows === 1 });
    this.pattern = makePattern(new Rng((init.seed + 0x9e3779b9) >>> 0), this.cols * CELL * 2, this.rows * CELL * 2);
    this.game = new OverlapGame(setup);
    // the picture is cropped to the grid's proportions
    let sw = init.width;
    let sh = init.height;
    if (sw * this.rows > sh * this.cols) sw = (sh * this.cols) / this.rows;
    else sh = (sw * this.rows) / this.cols;
    this.crop = { sx: (init.width - sw) / 2, sy: (init.height - sh) / 2, sw, sh };
    this.activeStack = Math.max(0, this.game.stacks.findIndex((s) => s.length));
    this.arrange('side');
  }

  // ---------------------------------------------------------------------------------------------------------------- layout

  private sizeFor(mode: 'side' | 'top'): { width: number; height: number } {
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    if (mode === 'side') return { width: SLOT_W + GAP + gw, height: Math.max(gh, STACKS * SLOT_H + (STACKS - 1) * 10) };
    return { width: Math.max(gw, STACKS * SLOT_W + (STACKS - 1) * 10), height: SLOT_H + GAP + gh };
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
      const total = STACKS * SLOT_H + (STACKS - 1) * 10;
      const y0 = (size.height - total) / 2;
      for (let i = 0; i < STACKS; i++) this.slots.push({ x: 0, y: y0 + i * (SLOT_H + 10) });
    } else {
      this.gridX = (size.width - gw) / 2;
      this.gridY = SLOT_H + GAP;
      const total = STACKS * SLOT_W + (STACKS - 1) * 10;
      const x0 = (size.width - total) / 2;
      for (let i = 0; i < STACKS; i++) this.slots.push({ x: x0 + i * (SLOT_W + 10), y: 0 });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- drawing

  private cellImage(ctx: CanvasRenderingContext2D, cx: number, cy: number, dx: number, dy: number, size: number): void {
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.cols;
    const h = sh / this.rows;
    ctx.drawImage(this.init.source, sx + cx * w, sy + cy * h, w, h, dx, dy, size + 0.5, size + 0.5);
  }

  /** The bit of the empty board's pattern that lies over picture cell (cx, cy). */
  private patternImage(ctx: CanvasRenderingContext2D, cx: number, cy: number, dx: number, dy: number): void {
    ctx.drawImage(this.pattern, cx * 2 * CELL, cy * 2 * CELL, 2 * CELL, 2 * CELL, dx, dy, CELL + 0.5, CELL + 0.5);
  }

  /**
   * A piece at (ox, oy): each of its three cells shows its own bit of the picture, turned with the piece. A window cell shows the empty board's pattern from the
   * place the piece belongs, in a gold frame. With the grid off only the piece's outline is drawn, not the lines between its cells.
   */
  private drawPiece(ctx: CanvasRenderingContext2D, id: number, ox: number, oy: number, alpha = 1, edge = 'rgba(255,255,255,0.9)'): void {
    const g = this.game;
    const now = g.cellsNow(id);
    const home = g.homeCells(id);
    const win = g.windowOf(id);
    const turn = (g.rot[id] * Math.PI) / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    now.forEach((c, k) => {
      ctx.save();
      ctx.translate(ox + c.x * CELL + CELL / 2, oy + c.y * CELL + CELL / 2);
      ctx.rotate(turn);
      if (k === win) this.patternImage(ctx, home[k].x, home[k].y, -CELL / 2, -CELL / 2);
      else this.cellImage(ctx, home[k].x, home[k].y, -CELL / 2, -CELL / 2, CELL);
      ctx.restore();
    });
    ctx.lineJoin = 'round';
    const grid = this.init.flag('grid');
    const lines = (colour: string, width: number, inset: number): void => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      if (grid) {
        for (const c of now) ctx.strokeRect(ox + c.x * CELL + inset, oy + c.y * CELL + inset, CELL - 2 * inset, CELL - 2 * inset);
        return;
      }
      const has = (x: number, y: number): boolean => now.some((c) => c.x === x && c.y === y);
      ctx.beginPath();
      for (const c of now) {
        const x0 = ox + c.x * CELL + inset;
        const y0 = oy + c.y * CELL + inset;
        const x1 = ox + (c.x + 1) * CELL - inset;
        const y1 = oy + (c.y + 1) * CELL - inset;
        if (!has(c.x, c.y - 1)) ctx.moveTo(x0, y0), ctx.lineTo(x1, y0);
        if (!has(c.x, c.y + 1)) ctx.moveTo(x0, y1), ctx.lineTo(x1, y1);
        if (!has(c.x - 1, c.y)) ctx.moveTo(x0, y0), ctx.lineTo(x0, y1);
        if (!has(c.x + 1, c.y)) ctx.moveTo(x1, y0), ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    };
    lines('rgba(0,0,0,0.55)', 3, 0);
    lines(edge, 1.5, 1);
    if (win >= 0) {
      ctx.strokeStyle = '#ffd84a';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(ox + now[win].x * CELL + 4, oy + now[win].y * CELL + 4, CELL - 8, CELL - 8);
    }
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    let running = false;
    const g = this.game;
    const gw = this.cols * CELL;
    const gh = this.rows * CELL;
    const grid = this.init.flag('grid');
    // the board: dark where the picture does not show yet
    ctx.fillStyle = '#100a08';
    ctx.fillRect(this.gridX, this.gridY, gw, gh);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = cy * this.cols + cx;
        const x = this.gridX + cx * CELL;
        const y = this.gridY + cy * CELL;
        if (g.revealed[i] || g.solved) {
          this.cellImage(ctx, cx, cy, x, y, CELL);
          const t = this.flash.get(i);
          if (t !== undefined) {
            const k = 1 - (now - t) / FLASH_MS;
            if (k > 0) {
              ctx.fillStyle = `rgba(255,255,255,${0.55 * k})`;
              ctx.fillRect(x, y, CELL, CELL);
              running = true;
            } else this.flash.delete(i);
          }
        } else {
          this.patternImage(ctx, cx, cy, x, y);
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(x, y, CELL, CELL);
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
    if (this.wrong) {
      const k = 1 - (now - this.wrong.at) / WRONG_MS;
      if (k > 0) {
        ctx.fillStyle = `rgba(230,60,40,${0.45 * k})`;
        ctx.fillRect(this.gridX + this.wrong.bx * CELL, this.gridY + this.wrong.by * CELL, 2 * CELL, 2 * CELL);
        running = true;
      } else this.wrong = null;
    }
    // the stacks
    if (!g.solved) {
      for (let s = 0; s < STACKS; s++) this.drawSlot(ctx, s);
      if (this.held) this.drawHeld(ctx);
    }
    return running;
  }

  private drawSlot(ctx: CanvasRenderingContext2D, s: number): void {
    const slot = this.slots[s];
    const g = this.game;
    ctx.fillStyle = s === this.activeStack ? '#3a2519' : '#2a1b14';
    ctx.strokeStyle = s === this.activeStack ? '#ffd84a' : '#6b4a36';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(slot.x + 1, slot.y + 1, SLOT_W - 2, SLOT_H - 2, 10);
    ctx.fill();
    ctx.stroke();
    const top = g.top(s);
    if (top >= 0 && !(this.held && this.held.id === top)) this.drawPiece(ctx, top, slot.x + 8, slot.y + 14);
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

  /** Where the held piece's bounding box goes: snapped to the cells when it is over the grid, else centred on the pointer. */
  private heldBox(h: { at: Pt }): { x: number; y: number; cell: Pt | null } {
    const bx = Math.round((h.at.x - this.gridX) / CELL - 1);
    const by = Math.round((h.at.y - this.gridY) / CELL - 1);
    const over = h.at.x >= this.gridX && h.at.y >= this.gridY && h.at.x < this.gridX + this.cols * CELL && h.at.y < this.gridY + this.rows * CELL;
    if (over) {
      const x = Math.min(this.cols - 2, Math.max(0, bx));
      const y = Math.min(this.rows - 2, Math.max(0, by));
      return { x: this.gridX + x * CELL, y: this.gridY + y * CELL, cell: { x, y } };
    }
    return { x: h.at.x - CELL, y: h.at.y - CELL, cell: null };
  }

  private drawHeld(ctx: CanvasRenderingContext2D): void {
    const h = this.held;
    if (!h || !h.moved) return;
    const box = this.heldBox(h);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    this.drawPiece(ctx, h.id, box.x, box.y, box.cell ? 0.95 : 0.85, '#ffd84a');
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  private slotAt(p: Pt): number {
    return this.slots.findIndex((s) => p.x >= s.x && p.y >= s.y && p.x < s.x + SLOT_W && p.y < s.y + SLOT_H);
  }

  pointerDown(p: Pt): void {
    const g = this.game;
    if (g.solved) return;
    const s = this.slotAt(p);
    if (s < 0) return;
    this.activeStack = s;
    for (const up of [true, false]) {
      const r = this.arrowRect(s, up);
      if (g.stacks[s].length > 1 && p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h) {
        g.cycle(s, up ? -1 : 1);
        this.init.requestDraw();
        return;
      }
    }
    const top = g.top(s);
    const slot = this.slots[s];
    if (top >= 0 && p.x >= slot.x + 8 && p.x < slot.x + 8 + 2 * CELL && p.y >= slot.y + 14 && p.y < slot.y + 14 + 2 * CELL) {
      this.held = { id: top, stack: s, at: p, moved: false, start: p };
    }
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    const s = this.slotAt(p);
    if (s !== this.hoverStack) this.hoverStack = s;
    const h = this.held;
    if (!h) return;
    h.at = p;
    if (!h.moved && Math.hypot(p.x - h.start.x, p.y - h.start.y) > TAP) h.moved = true;
    this.init.requestDraw();
  }

  pointerUp(p: Pt): void {
    const h = this.held;
    if (!h) return;
    this.held = null;
    h.at = p;
    const g = this.game;
    if (!h.moved) {                                           // a tap turns the piece
      g.rotate(h.id);
    } else {
      const box = this.heldBox(h);
      if (box.cell) {
        const before = [...g.revealed];
        if (g.drop(h.id, box.cell.x, box.cell.y) === 'placed') {
          const now = performance.now();
          g.revealed.forEach((r, i) => {
            if (r && !before[i]) this.flash.set(i, now);
          });
        } else {
          this.wrong = { bx: box.cell.x, by: box.cell.y, at: performance.now() };
        }
      }
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
