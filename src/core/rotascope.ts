import { Rng } from './rng';

/** The hole in the middle is this share of the board's radius (the rings' sizes grow by a fixed ratio from there to the edge). */
const CENTRE_SHARE = 0.14;

/** What one slide did: the piece (named by its own, home, cell) went from one cell to another. */
export interface RotaMove {
  piece: number;
  from: number;
  to: number;
}

export interface RotascopeState {
  content: number[];
  moves: number;
}

/**
 * Rotascope. A round picture is cut into `rings` concentric rings of `wedges` equal wedges each, round a hole in the middle: a sliding puzzle with one empty cell.
 * Each ring is a fixed number of times wider than the one inside it, so a wedge of one ring is a scaled copy of a wedge of the next, and a piece that slides from ring to
 * ring grows or shrinks and turns to fit. A piece next to the empty cell (the next ring in or out, or beside it in its ring, or the middle for ring 0) slides into it.
 * Cells are numbered ring * wedges + wedge, and the middle is the last; a piece is named by the cell it belongs in. The puzzle is solved when every piece is home (and
 * so the empty cell is the middle).
 */
export class RotascopeGame {
  readonly rings: number;
  readonly wedges: number;
  /** How much wider a ring is than the one inside it. */
  readonly ratio: number;
  readonly cells: number;
  /** The piece in each cell, -1 for the empty one. */
  readonly content: number[];
  moves = 0;

  constructor(rings: number, wedges: number, seed: number) {
    this.rings = rings;
    this.wedges = wedges;
    this.ratio = Math.pow(1 / CENTRE_SHARE, 1 / rings);
    this.cells = rings * wedges + 1;
    this.content = Array.from({ length: this.cells }, (_, i) => (i === this.centre ? -1 : i));
    this.shuffle(new Rng(seed));
  }

  get centre(): number {
    return this.rings * this.wedges;
  }

  get blank(): number {
    return this.content.indexOf(-1);
  }

  get solved(): boolean {
    return this.content.every((p, i) => (i === this.centre ? p === -1 : p === i));
  }

  /** The angle one wedge spans, in degrees. */
  get step(): number {
    return 360 / this.wedges;
  }

  ringOf(cell: number): number {
    return cell === this.centre ? -1 : Math.floor(cell / this.wedges);
  }

  colOf(cell: number): number {
    return cell === this.centre ? 0 : cell % this.wedges;
  }

  cellId(ring: number, col: number): number {
    return ring < 0 ? this.centre : ring * this.wedges + ((col % this.wedges) + this.wedges) % this.wedges;
  }

  /** Where wedge `col` starts, in degrees clockwise from east (the first wedge is centred straight up). */
  startAngle(col: number): number {
    return -90 - this.step / 2 + col * this.step;
  }

  /** The radius where ring k starts, as a share of the board's radius (ring `rings` would start at 1: the edge). */
  boundary(k: number): number {
    return 1 / Math.pow(this.ratio, this.rings - k);
  }

  /** The cells that touch a cell. */
  neighbours(cell: number): number[] {
    if (cell === this.centre) return Array.from({ length: this.wedges }, (_, c) => this.cellId(0, c));
    const ring = this.ringOf(cell);
    const col = this.colOf(cell);
    const out = [this.cellId(ring, col - 1), this.cellId(ring, col + 1)];
    if (ring === 0) out.push(this.centre);
    else out.push(this.cellId(ring - 1, col));
    if (ring < this.rings - 1) out.push(this.cellId(ring + 1, col));
    return out;
  }

  adjacent(a: number, b: number): boolean {
    return this.neighbours(a).includes(b);
  }

  /** The cell at a point, given as its distance (as a share of the board's radius) and its angle (degrees clockwise from east) from the middle; -1 outside the board. */
  cellAt(rho: number, degrees: number): number {
    if (rho >= 1) return -1;
    if (rho < this.boundary(0)) return this.centre;
    let ring = 0;
    while (ring + 1 < this.rings && rho >= this.boundary(ring + 1)) ring++;
    const turned = (((degrees - this.startAngle(0)) % 360) + 360) % 360;
    return this.cellId(ring, Math.min(this.wedges - 1, Math.floor(turned / this.step)));
  }

  /** Slides the hole about at random, never straight back, for long enough that the pieces are well mixed. */
  private shuffle(rng: Rng): void {
    let blank = this.centre;
    let before = -1;
    const steps = Math.max(150, this.cells * 30);
    for (let i = 0; i < steps || this.solved; i++) {
      const options = this.neighbours(blank).filter((n) => n !== before);
      const next = options[rng.below(options.length)];
      this.content[blank] = this.content[next];
      this.content[next] = -1;
      before = blank;
      blank = next;
    }
  }

  /** Clicks a cell: the piece in it slides into the empty cell if it touches it. Returns what moved, or null. */
  click(cell: number): RotaMove | null {
    if (this.solved || cell < 0 || cell >= this.cells) return null;
    const blank = this.blank;
    if (!this.adjacent(cell, blank)) return null;
    const piece = this.content[cell];
    this.content[blank] = piece;
    this.content[cell] = -1;
    this.moves++;
    return { piece, from: cell, to: blank };
  }

  /** Everything that changes while the puzzle is played, as plain data (the cutting follows from the rings and wedges). */
  snapshot(): RotascopeState {
    return { content: [...this.content], moves: this.moves };
  }

  /** Puts a snapshot back; throws if it does not belong to this puzzle. */
  restore(s: RotascopeState): void {
    const n = this.cells;
    const ok = Array.isArray(s.content) && s.content.length === n && new Set(s.content).size === n && s.content.every((v) => Number.isInteger(v) && v >= -1 && v < this.centre);
    if (!ok) throw new Error('not this puzzle');
    for (let i = 0; i < n; i++) this.content[i] = s.content[i];
    this.moves = Math.max(0, Math.floor(Number(s.moves) || 0));
  }
}
