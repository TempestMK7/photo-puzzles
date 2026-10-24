import { slidingGrid, SlidingGame, type SlidingState } from '../core/sliding';
import { drawSlice, type View } from '../render';
import type { Pt, PuzzleSession, SessionInit } from './types';

const SLIDE_MS = 170;

interface Slide {
  from: number;
  to: number;
  start: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Sliding Tiles: the picture is cut into a grid and one tile is missing. Click a tile in the empty cell's row or column and it (with the tiles between it and the empty
 * cell) slides over. The picture is complete again when every tile is back at its own place.
 */
export class SlidingSession implements PuzzleSession {
  readonly toggles = [
    { key: 'grid', label: 'Grid', title: 'Lines between the tiles' },
    { key: 'animate', label: 'Animate', title: 'Sliding animations' },
  ];
  readonly rotatable = false;
  private game: SlidingGame;
  private cw: number;
  private ch: number;
  private slides = new Map<number, Slide>();      // by piece
  private hover = -1;

  constructor(private readonly init: SessionInit) {
    const grid = slidingGrid(init.width, init.height, init.opts.tiles);
    this.game = new SlidingGame(grid, init.seed);
    if (init.restore) this.game.restore((init.restore as { game: SlidingState }).game);
    this.cw = init.width / grid.cols;
    this.ch = init.height / grid.rows;
  }

  serialize(): unknown {
    return { game: this.game.snapshot() };
  }

  layout(): { width: number; height: number } {
    return { width: this.init.width, height: this.init.height };
  }

  private cellAt(p: Pt): number {
    const c = Math.floor(p.x / this.cw);
    const r = Math.floor(p.y / this.ch);
    return c < 0 || r < 0 || c >= this.game.cols || r >= this.game.rows ? -1 : r * this.game.cols + c;
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    const g = this.game;
    const { canvas } = ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1210';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    const { width, height } = this.init;
    const line = 1 / view.scale;
    // the hole: a dark cell (the picture shows through where the last tile belongs once the puzzle is solved)
    ctx.fillStyle = '#100a08';
    ctx.fillRect(0, 0, width, height);

    let running = false;
    const grid = this.init.flag('grid');
    const hole = g.hole;
    // sliding tiles are drawn last, on top
    const order = [...g.cells.keys()].sort((a, b) => Number(this.slides.has(g.cells[a])) - Number(this.slides.has(g.cells[b])));
    for (const cell of order) {
      const piece = g.cells[cell];
      if (piece === hole && !g.solved) continue;
      let x = (cell % g.cols) * this.cw;
      let y = Math.floor(cell / g.cols) * this.ch;
      const s = this.slides.get(piece);
      if (s) {
        const t = (now - s.start) / SLIDE_MS;
        if (t >= 1) this.slides.delete(piece);
        else {
          const k = ease(Math.max(0, t));
          x = ((s.from % g.cols) * (1 - k) + (s.to % g.cols) * k) * this.cw;
          y = (Math.floor(s.from / g.cols) * (1 - k) + Math.floor(s.to / g.cols) * k) * this.ch;
          running = true;
        }
      }
      const sx = (piece % g.cols) * this.cw;
      const sy = Math.floor(piece / g.cols) * this.ch;
      drawSlice(ctx, this.init.source, sx, sy, this.cw, this.ch, x, y, this.cw, this.ch);
      if (grid && !g.solved) {
        ctx.lineWidth = line * 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeRect(x, y, this.cw, this.ch);
      }
    }
    if (!g.solved && this.hover >= 0 && g.chain(this.hover).length) {
      const x = (this.hover % g.cols) * this.cw;
      const y = Math.floor(this.hover / g.cols) * this.ch;
      ctx.lineWidth = line * 4;
      ctx.strokeStyle = '#ffd84a';
      ctx.strokeRect(x + line * 2, y + line * 2, this.cw - line * 4, this.ch - line * 4);
    }
    return running;
  }

  pointerDown(p: Pt): void {
    const cell = this.cellAt(p);
    if (cell < 0) return;
    const moved = this.game.click(cell);
    if (moved.length && this.init.flag('animate')) {
      const now = performance.now();
      for (const m of moved) this.slides.set(m.piece, { from: m.from, to: m.to, start: now });
    }
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
