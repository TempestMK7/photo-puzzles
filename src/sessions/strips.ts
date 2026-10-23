import { Rng } from '../core/rng';
import { boxOf, generateStrips, MARGIN, pictureSize, StripsGame } from '../core/strips';
import { beginFrame, drawSlice, type View } from '../render';
import type { Pt, PuzzleSession, SessionInit } from './types';

const S = 30;                  // one cell, in board units
const DWELL_MS = 600;          // a dragged strip that rests on a tab goes to it
const TAP = 5;
const FLASH_MS = 600;

/**
 * Strips: straight strips have been cut out of the picture and lie turned and scattered over the board. Drag each one back to the hole it came from; a tap (or the
 * right button, a second finger, R) turns it a quarter turn. It locks when it lies exactly in its hole, turned the right way.
 */
export class StripsSession implements PuzzleSession {
  readonly toggles = [{ key: 'grid', label: 'Grid', title: 'Grid lines' }];
  readonly rotatable = true;
  private game: StripsGame;
  private picCols: number;
  private picRows: number;
  private crop: { sx: number; sy: number; sw: number; sh: number };
  /** For each picture cell, the strips cut from it. */
  private owners: number[][];
  private selected = -1;
  private drag: { id: number; gx: number; gy: number; start: Pt; moved: boolean } | null = null;
  private flash = new Map<number, number>();
  private tab = 0;
  private overTab = -1;
  private dwell = 0;

  constructor(private readonly init: SessionInit) {
    const pic = pictureSize(init.width, init.height, init.opts.cells);
    this.picCols = pic.picCols;
    this.picRows = pic.picRows;
    const setup = generateStrips(new Rng(init.seed), {
      picCols: this.picCols,
      picRows: this.picRows,
      maxLen: init.opts.length,
      placed: init.opts.placed,
      tabs: init.opts.tabs,
    });
    this.game = new StripsGame(setup);
    let sw = init.width;
    let sh = init.height;
    if (sw * this.picRows > sh * this.picCols) sw = (sh * this.picCols) / this.picRows;
    else sh = (sw * this.picRows) / this.picCols;
    this.crop = { sx: (init.width - sw) / 2, sy: (init.height - sh) / 2, sw, sh };
    this.tab = Math.max(0, this.game.looseCounts().findIndex((n) => n > 0));
    this.owners = Array.from({ length: this.picCols * this.picRows }, () => []);
    for (const d of this.game.defs) {
      const b = boxOf(d, 0);
      for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) this.owners[(d.hy - MARGIN + dy) * this.picCols + d.hx - MARGIN + dx].push(d.id);
    }
  }

  layout(): { width: number; height: number } {
    return { width: this.game.cols * S, height: this.game.rows * S };
  }

  private cellImage(ctx: CanvasRenderingContext2D, pc: number, pr: number, dx: number, dy: number): void {
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.picCols;
    const h = sh / this.picRows;
    drawSlice(ctx, this.init.source, sx + pc * w, sy + pr * h, w, h, dx, dy, S, S);
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    const g = this.game;
    let running = false;
    const { width, height } = this.layout();
    ctx.fillStyle = '#100a08';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#6b4a36';
    ctx.lineWidth = 3;
    ctx.strokeRect(-1.5, -1.5, width + 3, height + 3);
    // the picture: its cells show unless a strip that was cut from them is still loose
    for (let r = 0; r < this.picRows; r++) {
      for (let c = 0; c < this.picCols; c++) {
        const i = r * this.picCols + c;
        const owners = this.owners[i];
        const x = (MARGIN + c) * S;
        const y = (MARGIN + r) * S;
        if (g.solved || owners.length === 0 || owners.some((id) => g.state[id].locked)) {
          this.cellImage(ctx, c, r, x, y);
          const t = this.flash.get(i);
          if (t !== undefined) {
            const k = 1 - (now - t) / FLASH_MS;
            if (k > 0) {
              ctx.fillStyle = `rgba(255,255,255,${0.6 * k})`;
              ctx.fillRect(x, y, S, S);
              running = true;
            } else this.flash.delete(i);
          }
        } else {
          ctx.fillStyle = '#1d120d';
          ctx.fillRect(x, y, S, S);
        }
      }
    }
    if (this.init.flag('grid')) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 0; c <= g.cols; c++) {
        ctx.moveTo(c * S + 0.5, 0);
        ctx.lineTo(c * S + 0.5, height);
      }
      for (let r = 0; r <= g.rows; r++) {
        ctx.moveTo(0, r * S + 0.5);
        ctx.lineTo(width, r * S + 0.5);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,216,74,0.35)';
      ctx.strokeRect(MARGIN * S + 0.5, MARGIN * S + 0.5, this.picCols * S, this.picRows * S);
    }
    if (!g.solved) {
      for (const id of g.z) {
        const s = g.state[id];
        if (!s.locked && s.tab === this.tab) this.drawStrip(ctx, id, id === this.selected);
      }
    }
    return running;
  }

  private drawStrip(ctx: CanvasRenderingContext2D, id: number, selected: boolean): void {
    const d = this.game.defs[id];
    const s = this.game.state[id];
    const b = boxOf(d, s.angle);
    const hw = d.horizontal ? d.len : 1;
    const hh = d.horizontal ? 1 : d.len;
    ctx.save();
    ctx.translate((s.x + b.w / 2) * S, (s.y + b.h / 2) * S);
    ctx.rotate((s.angle * Math.PI) / 2);
    for (let k = 0; k < d.len; k++) {
      const pc = d.hx - MARGIN + (d.horizontal ? k : 0);
      const pr = d.hy - MARGIN + (d.horizontal ? 0 : k);
      this.cellImage(ctx, pc, pr, -(hw * S) / 2 + (d.horizontal ? k : 0) * S, -(hh * S) / 2 + (d.horizontal ? 0 : k) * S);
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-(hw * S) / 2, -(hh * S) / 2, hw * S, hh * S);
    ctx.strokeStyle = selected ? '#ffd84a' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = selected ? 1.5 : 0.75;
    ctx.strokeRect(-(hw * S) / 2 + 0.5, -(hh * S) / 2 + 0.5, hw * S - 1, hh * S - 1);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  pointerDown(p: Pt): void {
    const g = this.game;
    if (g.solved) return;
    const cx = Math.floor(p.x / S);
    const cy = Math.floor(p.y / S);
    const id = g.stripAt(cx, cy, this.tab);
    if (id < 0) {
      this.selected = -1;
    } else {
      g.bringToFront(id);
      this.selected = id;
      this.drag = { id, gx: cx - g.state[id].x, gy: cy - g.state[id].y, start: p, moved: false };
    }
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) > TAP) d.moved = true;
    if (d.moved) {
      this.game.moveTo(d.id, Math.floor(p.x / S) - d.gx, Math.floor(p.y / S) - d.gy);
      if (this.game.lockIfHome(d.id)) {                            // over its own hole, turned right: it drops by itself, the button need not be released
        this.locked(d.id);
        this.drag = null;
        window.clearTimeout(this.dwell);
        this.overTab = -1;
      }
    }
    this.init.requestDraw();
  }

  pointerUp(): void {
    const d = this.drag;
    this.drag = null;
    window.clearTimeout(this.dwell);
    if (!d) return;
    if (d.moved && this.overTab >= 0 && this.overTab !== this.tab) {                  // let go over another tab: the strip goes there
      this.game.moveToTab(d.id, this.overTab);
      this.tab = this.overTab;
    } else if (!d.moved) this.turn(d.id);                              // a tap turns the strip
    else if (this.game.lockIfHome(d.id)) this.locked(d.id);
    this.overTab = -1;
    this.init.requestDraw();
  }

  pointerCancel(): void {
    window.clearTimeout(this.dwell);
    this.overTab = -1;
    this.drag = null;
    this.init.requestDraw();
  }

  secondary(): void {
    const id = this.drag ? this.drag.id : this.selected;
    if (id >= 0 && !this.game.solved) this.turn(id);
    this.init.requestDraw();
  }

  private turn(id: number): void {
    if (this.game.rotate(id)) this.locked(id);
  }

  private locked(id: number): void {
    const d = this.game.defs[id];
    const b = boxOf(d, 0);
    const now = performance.now();
    for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) this.flash.set((d.hy - MARGIN + dy) * this.picCols + d.hx - MARGIN + dx, now);
    if (this.selected === id) this.selected = -1;
    this.game.moves++;
    const counts = this.game.looseCounts();                       // the tab is empty: on to the next one that still has strips
    if (counts[this.tab] === 0 && !this.game.solved) {
      for (let k = 1; k <= counts.length; k++) {
        const t = (this.tab + k) % counts.length;
        if (counts[t] > 0) {
          this.tab = t;
          break;
        }
      }
    }
  }

  tabInfo(): { counts: number[]; active: number } | null {
    return this.game.tabs > 1 ? { counts: this.game.looseCounts(), active: this.tab } : null;
  }

  selectTab(tab: number): void {
    if (this.drag || tab < 0 || tab >= this.game.tabs || tab === this.tab) return;
    this.tab = tab;
    this.selected = -1;
    this.init.requestDraw();
  }

  /** A strip being dragged that rests on another tab's button for a moment goes to that tab, and the drag goes on there. */
  dragOverTab(tab: number): void {
    if (!this.drag || !this.drag.moved || tab === this.overTab) return;
    this.overTab = tab;
    window.clearTimeout(this.dwell);
    if (tab < 0 || tab === this.tab) return;
    this.dwell = window.setTimeout(() => {
      if (!this.drag || this.overTab !== tab) return;
      this.game.moveToTab(this.drag.id, tab);
      this.tab = tab;
      this.overTab = -1;
      this.init.requestDraw();
      this.init.tabsChanged?.();
    }, DWELL_MS);
  }

  status(): string {
    return `${this.game.lockedCount} / ${this.game.total} placed`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {
    this.init.requestDraw();
  }
}
