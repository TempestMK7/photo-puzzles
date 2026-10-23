import { Rng } from './rng';

export interface Cell {
  x: number;
  y: number;
}

/** The four orientations of the L-shaped piece: each cell relative to the first one (down then left, left then up, up then right, right then down). */
const RAW: Cell[][] = [
  [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 1 }],
  [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: -1, y: -1 }],
  [{ x: 0, y: 0 }, { x: 0, y: -1 }, { x: 1, y: -1 }],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
];

/** Cells of the L in orientation o (0..3), moved so that the bounding box starts at (0, 0). The order of the cells is the same in every orientation. */
export function shapeCells(o: number): Cell[] {
  const raw = RAW[((o % 4) + 4) % 4];
  const minX = Math.min(...raw.map((c) => c.x));
  const minY = Math.min(...raw.map((c) => c.y));
  return raw.map((c) => ({ x: c.x - minX, y: c.y - minY }));
}

export interface PieceDef {
  id: number;
  /** Top-left of the bounding box where the piece belongs, and the orientation it has there. */
  bx: number;
  by: number;
  orient: number;
  /**
   * Which of the piece's three cells is a window (-1: none). A window shows what the board holds at that place - the empty board's pattern, a hint to where
   * the piece goes - and does not reveal its cell when the piece is placed.
   */
  marker: number;
}

export interface OverlapOptions {
  cols: number;
  rows: number;
  /** Start some pieces turned. */
  turned: boolean;
  /** Percent of the pieces that are already in place at the start. */
  placed: number;
  /** Some pieces have a window cell. */
  windows: boolean;
}

export interface OverlapSetup {
  cols: number;
  rows: number;
  pieces: PieceDef[];
  /** Turn each piece starts off by (quarter turns clockwise from its home orientation). */
  rot: number[];
  /** Pieces already in place at the start. */
  placedAtStart: number[];
  /** The three stacks, bottom to top. */
  stacks: number[][];
}

export const STACKS = 3;

/**
 * Covers the grid with L-shaped pieces that overlap where that helps (a cell may belong to several pieces), shuffles them, puts some in place and deals the rest to
 * three stacks. Everything comes from the seed.
 */
export function generateOverlap(rng: Rng, o: OverlapOptions): OverlapSetup {
  const { cols, rows } = o;
  const cover = new Array<number>(cols * rows).fill(0);
  const order = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pieces: PieceDef[] = [];
  for (const cell of order) {
    if (cover[cell]) continue;
    const tx = cell % cols;
    const ty = Math.floor(cell / cols);
    let best: { bx: number; by: number; orient: number; score: number }[] = [];
    let bestScore = -1;
    for (let orient = 0; orient < 4; orient++) {
      const rel = shapeCells(orient);
      for (const anchor of rel) {                                  // any of the three cells may be the one that lands on the target
        const bx = tx - anchor.x;
        const by = ty - anchor.y;
        if (bx < 0 || by < 0 || bx + 2 > cols || by + 2 > rows) continue;
        let score = 0;
        for (const c of rel) if (!cover[(by + c.y) * cols + bx + c.x]) score++;
        if (score > bestScore) {
          bestScore = score;
          best = [];
        }
        if (score === bestScore) best.push({ bx, by, orient, score });
      }
    }
    const pick = best[rng.below(best.length)];
    pieces.push({ id: 0, bx: pick.bx, by: pick.by, orient: pick.orient, marker: -1 });
    for (const c of shapeCells(pick.orient)) cover[(pick.by + c.y) * cols + pick.bx + c.x]++;
  }
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }
  pieces.forEach((p, i) => (p.id = i));
  const placedCount = Math.min(pieces.length - 1, Math.round((pieces.length * Math.min(50, Math.max(0, o.placed))) / 100));
  const rot = pieces.map((_, i) => (i < placedCount || !o.turned ? 0 : rng.below(4)));
  // windows: a cell that other pieces cover too, so it always gets revealed; `solid` counts the pieces that cover a cell and reveal it
  const solid = new Array<number>(cols * rows).fill(0);
  for (const p of pieces) for (const c of shapeCells(p.orient)) solid[(p.by + c.y) * cols + p.bx + c.x]++;
  if (o.windows) {
    for (let i = placedCount; i < pieces.length; i++) {
      if (rng.below(3) !== 0) continue;
      const p = pieces[i];
      const cells = shapeCells(p.orient).map((c) => (p.by + c.y) * cols + p.bx + c.x);
      const shared = cells.map((cell, k) => (solid[cell] > 1 ? k : -1)).filter((k) => k >= 0);
      if (!shared.length) continue;
      p.marker = shared[rng.below(shared.length)];
      solid[cells[p.marker]]--;
    }
  }
  const stacks: number[][] = Array.from({ length: STACKS }, () => []);
  let dealt = 0;
  for (let i = placedCount; i < pieces.length; i++) stacks[dealt++ % STACKS].push(i);
  for (const s of stacks) s.sort((a, b) => Number(pieces[a].marker >= 0) - Number(pieces[b].marker >= 0));        // pieces with a window lie on top, where they can be seen (the sort is stable)
  return { cols, rows, pieces, rot, placedAtStart: pieces.slice(0, placedCount).map((p) => p.id), stacks };
}

export type DropResult = 'placed' | 'wrong';

/** The rules of Overlap. */
export interface OverlapState {
  rot: number[];
  revealed: boolean[];
  stacks: number[][];
  done: boolean[];
  misses: number;
}

export class OverlapGame {
  readonly cols: number;
  readonly rows: number;
  readonly pieces: PieceDef[];
  readonly rot: number[];
  /** Which cells of the picture are showing. */
  readonly revealed: boolean[];
  readonly stacks: number[][];
  /** Pieces that are in place or were taken off a stack because everything they cover already shows. */
  readonly done: boolean[];
  misses = 0;

  constructor(setup: OverlapSetup) {
    this.cols = setup.cols;
    this.rows = setup.rows;
    this.pieces = setup.pieces;
    this.rot = [...setup.rot];
    this.stacks = setup.stacks.map((s) => [...s]);
    this.revealed = new Array<boolean>(this.cols * this.rows).fill(false);
    this.done = new Array<boolean>(this.pieces.length).fill(false);
    for (const id of setup.placedAtStart) this.reveal(id);
    this.dropRedundant();
  }

  /** Everything that changes while the puzzle is played, as plain data (the rest follows from the seed). */
  snapshot(): OverlapState {
    return { rot: [...this.rot], revealed: [...this.revealed], stacks: this.stacks.map((s) => [...s]), done: [...this.done], misses: this.misses };
  }

  /** Puts a snapshot back; throws if it does not belong to this puzzle. */
  restore(s: OverlapState): void {
    const n = this.pieces.length;
    const onStacks = s.stacks?.flat() ?? [];
    if (
      s.rot?.length !== n ||
      s.done?.length !== n ||
      s.revealed?.length !== this.revealed.length ||
      s.stacks?.length !== this.stacks.length ||
      !onStacks.every((id) => Number.isInteger(id) && id >= 0 && id < n) ||
      !s.rot.every((r) => Number.isInteger(r) && r >= 0 && r < 4)
    )
      throw new Error('not this puzzle');
    for (let i = 0; i < n; i++) {
      this.rot[i] = s.rot[i];
      this.done[i] = !!s.done[i];
    }
    for (let i = 0; i < this.revealed.length; i++) this.revealed[i] = !!s.revealed[i];
    for (let i = 0; i < this.stacks.length; i++) this.stacks[i] = [...s.stacks[i]];
    this.misses = Math.max(0, Math.floor(Number(s.misses) || 0));
  }

  get total(): number {
    return this.pieces.length;
  }

  get remaining(): number {
    return this.done.filter((d) => !d).length;
  }

  get solved(): boolean {
    return this.remaining === 0;
  }

  /** The cells a piece covers now, relative to its bounding box. */
  cellsNow(id: number): Cell[] {
    return shapeCells(this.pieces[id].orient + this.rot[id]);
  }

  /** The window cell of a piece (its index among the three), or -1 when it has none or the cell it looks at shows already. */
  windowOf(id: number): number {
    const m = this.pieces[id].marker;
    if (m < 0) return -1;
    const c = this.homeCells(id)[m];
    return this.revealed[c.y * this.cols + c.x] ? -1 : m;
  }

  /** The picture cells the piece belongs over (its own cells, in the same order as cellsNow). */
  homeCells(id: number): Cell[] {
    const p = this.pieces[id];
    return shapeCells(p.orient).map((c) => ({ x: p.bx + c.x, y: p.by + c.y }));
  }

  top(stack: number): number {
    const s = this.stacks[stack];
    return s.length ? s[s.length - 1] : -1;
  }

  /** Quarter turn clockwise (or back). Only a piece that is not in place. */
  rotate(id: number, delta = 1): void {
    if (id < 0 || this.done[id]) return;
    this.rot[id] = (this.rot[id] + delta + 4) % 4;
  }

  /** The top piece goes to the bottom (dir = 1) or the bottom piece comes to the top (dir = -1). */
  cycle(stack: number, dir: 1 | -1): void {
    const s = this.stacks[stack];
    if (s.length < 2) return;
    if (dir === 1) s.unshift(s.pop()!);
    else s.push(s.shift()!);
  }

  /** Puts piece `id` (the top of its stack) down with its bounding box at cell (bx, by). Right place and turn: it stays and reveals its cells. */
  drop(id: number, bx: number, by: number): DropResult {
    const p = this.pieces[id];
    if (this.done[id] || bx !== p.bx || by !== p.by || this.rot[id] !== 0) {
      this.misses++;
      return 'wrong';
    }
    for (const s of this.stacks) {
      const i = s.indexOf(id);
      if (i >= 0) s.splice(i, 1);
    }
    this.reveal(id);
    this.dropRedundant();
    return 'placed';
  }

  /** Puts a piece on top of another stack (a piece dragged from one drawer to another). */
  moveToStack(id: number, stack: number): void {
    if (this.done[id] || stack < 0 || stack >= this.stacks.length) return;
    for (const s of this.stacks) {
      const i = s.indexOf(id);
      if (i >= 0) s.splice(i, 1);
    }
    this.stacks[stack].push(id);
  }

  private reveal(id: number): void {
    this.done[id] = true;
    this.homeCells(id).forEach((c, k) => {
      if (k !== this.pieces[id].marker) this.revealed[c.y * this.cols + c.x] = true;
    });
  }

  /** A piece on top of a stack whose cells all show already has nothing left to do: it goes, and so on down the stack. */
  private dropRedundant(): void {
    let again = true;
    while (again) {
      again = false;
      for (const s of this.stacks) {
        while (s.length) {
          const id = s[s.length - 1];
          const marker = this.pieces[id].marker;
          if (!this.homeCells(id).every((c, k) => k === marker || this.revealed[c.y * this.cols + c.x])) break;
          s.pop();
          this.done[id] = true;
          again = true;
        }
      }
    }
  }
}
