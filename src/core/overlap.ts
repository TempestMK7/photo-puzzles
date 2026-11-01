import { Rng } from './rng';

export interface Cell {
  x: number;
  y: number;
}

/** The four neighbours of a cell, clockwise from the top: a piece reaches out from its centre cell along some of these. Turning a piece a quarter turn clockwise moves each to the next. */
export const DIRS: readonly Cell[] = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];

export interface PieceDef {
  id: number;
  /** The piece's centre cell, where it belongs. */
  cx: number;
  cy: number;
  /** The neighbours of the centre (indexes into `DIRS`, ascending) that the piece covers as well, in the orientation it has at home: two to four. */
  arms: number[];
  /**
   * Which of the piece's cells (0 is the centre, then the arms in order) is a window (-1: none). A window shows what the board holds at that place - the empty board's pattern,
   * a hint to where the piece goes - and does not reveal its cell when the piece is placed. Only an overlap cell (never the centre) can be one.
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
  /** How many stacks the pieces wait in (`STACKS` when not given; the size of the puzzle says, see `kinds.ts`). */
  stacks?: number;
}

export interface OverlapSetup {
  cols: number;
  rows: number;
  pieces: PieceDef[];
  /** Turn each piece starts off by (quarter turns clockwise from its home orientation). */
  rot: number[];
  /** Pieces already in place at the start. */
  placedAtStart: number[];
  /** The stacks, bottom to top. */
  stacks: number[][];
}

/** Stacks a small puzzle has. */
export const STACKS = 3;

/** The grid for about `total` cells in the proportions of a picture: as many columns and rows as come closest (never fewer than four by three, nor more than 120 across). */
export function overlapGrid(total: number, width: number, height: number): { cols: number; rows: number } {
  const cols = Math.min(120, Math.max(4, Math.round(Math.sqrt((total * width) / height))));
  return { cols, rows: Math.max(3, Math.round(total / cols)) };
}

/**
 * Lays the pieces over the grid and shuffles them. The cells are divided like a checkerboard: every other cell is a piece's own cell (its centre, which nothing else covers),
 * the others are overlap cells, each of which two or more pieces cover. Each piece is a centre cell and two to four of the overlap cells next to it, so it has three to five
 * cells; every overlap cell is covered by at least two pieces (the two it touches, for a corner). Then some pieces are put in place and the rest dealt to the stacks (three unless `o.stacks` says otherwise).
 * Everything comes from the seed.
 */
export function generateOverlap(rng: Rng, o: OverlapOptions): OverlapSetup {
  const { cols, rows } = o;
  const parity = rng.below(2);                                       // which colour of the checkerboard holds the pieces' own cells
  const isCentre = (x: number, y: number): boolean => (x + y) % 2 === parity;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < cols && y < rows;
  const pieces: PieceDef[] = [];
  const armsOf = new Map<number, Set<number>>();                    // centre cell -> the directions it reaches along
  const near = (x: number, y: number): number[] => [0, 1, 2, 3].filter((d) => inside(x + DIRS[d].x, y + DIRS[d].y));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!isCentre(x, y)) continue;
      const dirs = near(x, y);                                       // (a corner has two, an edge three, the rest four)
      const take = 2 + rng.below(dirs.length - 1);                   // two to all of them
      for (let i = dirs.length - 1; i > 0; i--) {
        const j = rng.below(i + 1);
        [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
      }
      armsOf.set(y * cols + x, new Set(dirs.slice(0, take)));
    }
  }
  // an overlap cell that fewer than two pieces reach gets itself added to a neighbouring piece that does not reach it yet
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (isCentre(x, y)) continue;
      const reaching = near(x, y).filter((d) => armsOf.get((y + DIRS[d].y) * cols + x + DIRS[d].x)!.has((d + 2) % 4));
      const missing = near(x, y).filter((d) => !reaching.includes(d));
      for (let i = missing.length - 1; i > 0; i--) {
        const j = rng.below(i + 1);
        [missing[i], missing[j]] = [missing[j], missing[i]];
      }
      for (let n = reaching.length; n < 2 && missing.length; n++) {
        const d = missing.pop()!;
        armsOf.get((y + DIRS[d].y) * cols + x + DIRS[d].x)!.add((d + 2) % 4);
      }
    }
  }
  for (const [cell, dirs] of armsOf) pieces.push({ id: 0, cx: cell % cols, cy: Math.floor(cell / cols), arms: [...dirs].sort((a, b) => a - b), marker: -1 });
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }
  pieces.forEach((p, i) => (p.id = i));
  const placedCount = Math.min(pieces.length - 1, Math.round((pieces.length * Math.min(50, Math.max(0, o.placed))) / 100));
  const rot = pieces.map((_, i) => (i < placedCount || !o.turned ? 0 : rng.below(4)));
  // windows: an overlap cell that other pieces cover too, so it always gets revealed; `solid` counts the pieces that cover a cell and reveal it
  const cellsOf = (p: PieceDef): number[] => [p.cy * cols + p.cx, ...p.arms.map((d) => (p.cy + DIRS[d].y) * cols + p.cx + DIRS[d].x)];
  const solid = new Array<number>(cols * rows).fill(0);
  for (const p of pieces) for (const cell of cellsOf(p)) solid[cell]++;
  if (o.windows) {
    for (let i = placedCount; i < pieces.length; i++) {
      if (rng.below(3) !== 0) continue;
      const p = pieces[i];
      const cells = cellsOf(p);
      const shared = cells.map((cell, k) => (k > 0 && solid[cell] > 1 ? k : -1)).filter((k) => k >= 0);
      if (!shared.length) continue;
      p.marker = shared[rng.below(shared.length)];
      solid[cells[p.marker]]--;
    }
  }
  const stackN = Math.max(1, Math.floor(o.stacks ?? STACKS));
  const stacks: number[][] = Array.from({ length: stackN }, () => []);
  let dealt = 0;
  for (let i = placedCount; i < pieces.length; i++) stacks[dealt++ % stackN].push(i);
  for (const st of stacks) st.sort((a, b) => Number(pieces[a].marker >= 0) - Number(pieces[b].marker >= 0));        // pieces with a window lie on top, where they can be seen (the sort is stable)
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
  /** Pieces that are in place (every piece has to be: its centre cell shows nowhere else). */
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

  /** The cells a piece covers now, relative to its centre cell (which stays where it is when the piece turns), in the same order as `homeCells`: the centre first. */
  cellsNow(id: number): Cell[] {
    return [{ x: 0, y: 0 }, ...this.pieces[id].arms.map((d) => DIRS[(d + this.rot[id]) % 4])];
  }

  /** The window cell of a piece (its index among its cells), or -1 when it has none or the cell it looks at shows already. */
  windowOf(id: number): number {
    const m = this.pieces[id].marker;
    if (m < 0) return -1;
    const c = this.homeCells(id)[m];
    return this.revealed[c.y * this.cols + c.x] ? -1 : m;
  }

  /** The picture cells the piece belongs over (its own cells, in the same order as cellsNow). */
  homeCells(id: number): Cell[] {
    const p = this.pieces[id];
    return [{ x: p.cx, y: p.cy }, ...p.arms.map((d) => ({ x: p.cx + DIRS[d].x, y: p.cy + DIRS[d].y }))];
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

  /** Puts piece `id` (the top of its stack) down with its centre on cell (cx, cy). Right place and turn: it stays and reveals its cells. */
  drop(id: number, cx: number, cy: number): DropResult {
    const p = this.pieces[id];
    if (this.done[id] || cx !== p.cx || cy !== p.cy || this.rot[id] !== 0) {
      this.misses++;
      return 'wrong';
    }
    for (const s of this.stacks) {
      const i = s.indexOf(id);
      if (i >= 0) s.splice(i, 1);
    }
    this.reveal(id);
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
}

/** The Overlap puzzle for a picture of this size (`opts` are the kind's options, see kinds.ts): both the game on a screen and a server that keeps a shared board make it with this, so they start from the same one. */
export function makeOverlap(seed: number, width: number, height: number, opts: Record<string, number>): { game: OverlapGame; cols: number; rows: number } {
  const { cols, rows } = overlapGrid(opts.total, width, height);
  const setup = generateOverlap(new Rng(seed), { cols, rows, turned: opts.turned === 1, placed: opts.placed, windows: opts.windows === 1, stacks: opts.stacks });
  return { game: new OverlapGame(setup), cols, rows };
}
