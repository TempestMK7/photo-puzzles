import { Rng } from './rng';

export interface SlidingGrid {
  cols: number;
  rows: number;
}

/**
 * The grid whose number of tiles (cells less the empty one) is nearest `tiles`, with tiles as close to square as the picture allows: the whole picture is used, so a
 * wide picture gets more columns than rows. The count is only approximate - 15 tiles is a 4 x 4 grid, 14 would have to be 5 x 3.
 */
export function slidingGrid(width: number, height: number, tiles: number): SlidingGrid {
  let best: SlidingGrid = { cols: 3, rows: 3 };
  let bestCost = Infinity;
  for (let cols = 2; cols <= 30; cols++) {
    for (let rows = 2; rows <= 30; rows++) {
      const aspect = width / cols / (height / rows);
      const cost = Math.abs(cols * rows - 1 - tiles) / tiles + 0.3 * Math.abs(Math.log(aspect));
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = { cols, rows };
      }
    }
  }
  return best;
}

export interface SlideMove {
  /** The piece that moved, and the cells it left and went to. */
  piece: number;
  from: number;
  to: number;
}

export interface SlidingState {
  cells: number[];
  moves: number;
}

/**
 * Sliding tiles. The picture is cut into cols x rows tiles and the last one is taken out, leaving a hole; the tiles are shuffled by sliding them about (so the
 * puzzle can always be solved). A tile in the hole's row or column slides towards the hole, and takes the tiles between it and the hole along.
 */
export class SlidingGame {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  /** The piece lying in each cell (a piece is its own cell number when solved); the last piece, count - 1, is the hole. */
  readonly cells: number[];
  moves = 0;

  constructor(grid: SlidingGrid, seed: number) {
    this.cols = grid.cols;
    this.rows = grid.rows;
    this.count = grid.cols * grid.rows;
    this.cells = Array.from({ length: this.count }, (_, i) => i);
    this.shuffle(new Rng(seed));
  }

  get hole(): number {
    return this.count - 1;
  }

  /** The cell the hole is in. */
  get blank(): number {
    return this.cells.indexOf(this.hole);
  }

  get solved(): boolean {
    return this.cells.every((p, i) => p === i);
  }

  private neighbours(cell: number): number[] {
    const c = cell % this.cols;
    const r = Math.floor(cell / this.cols);
    const out: number[] = [];
    if (r > 0) out.push(cell - this.cols);
    if (c > 0) out.push(cell - 1);
    if (c < this.cols - 1) out.push(cell + 1);
    if (r < this.rows - 1) out.push(cell + this.cols);
    return out;
  }

  /** Slides the hole about at random, never straight back, for long enough that the tiles are well mixed. */
  private shuffle(rng: Rng): void {
    let blank = this.count - 1;
    let before = -1;
    const steps = Math.max(200, this.count * 40);
    for (let i = 0; i < steps || this.solved; i++) {
      const options = this.neighbours(blank).filter((n) => n !== before);
      const next = options[rng.below(options.length)];
      this.cells[blank] = this.cells[next];
      this.cells[next] = this.hole;
      before = blank;
      blank = next;
    }
  }

  /** The cells that would move if `cell` were clicked, the one next to the hole first; empty when the click does nothing. */
  chain(cell: number): number[] {
    const blank = this.blank;
    if (cell === blank || cell < 0 || cell >= this.count) return [];
    const sameRow = Math.floor(cell / this.cols) === Math.floor(blank / this.cols);
    const sameCol = cell % this.cols === blank % this.cols;
    if (!sameRow && !sameCol) return [];
    const step = sameRow ? Math.sign(cell - blank) : Math.sign(cell - blank) * this.cols;
    const out: number[] = [];
    for (let at = blank + step; ; at += step) {
      out.push(at);
      if (at === cell) break;
    }
    return out;
  }

  /** Clicks a cell: its tile, and the ones between it and the hole, slide into the hole. Returns what moved. */
  click(cell: number): SlideMove[] {
    if (this.solved) return [];
    const chain = this.chain(cell);
    const moved: SlideMove[] = [];
    let blank = this.blank;
    for (const from of chain) {
      moved.push({ piece: this.cells[from], from, to: blank });
      this.cells[blank] = this.cells[from];
      this.cells[from] = this.hole;
      blank = from;
    }
    if (moved.length) this.moves++;
    return moved;
  }

  /** Everything that changes while the puzzle is played, as plain data (the picture's cutting follows from the grid). */
  snapshot(): SlidingState {
    return { cells: [...this.cells], moves: this.moves };
  }

  /** Puts a snapshot back; throws if it does not belong to this puzzle. */
  restore(s: SlidingState): void {
    const n = this.count;
    if (!Array.isArray(s.cells) || s.cells.length !== n || new Set(s.cells).size !== n || !s.cells.every((v) => Number.isInteger(v) && v >= 0 && v < n)) throw new Error('not this puzzle');
    for (let i = 0; i < n; i++) this.cells[i] = s.cells[i];
    this.moves = Math.max(0, Math.floor(Number(s.moves) || 0));
  }
}
