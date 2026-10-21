import { focusLayout, type Rect } from './layout';
import { Rng } from './rng';

export interface FocusOptions {
  seed: number;
  pieces: number;
  irregular: boolean;
}

/**
 * Focus Point style puzzle. The picture is cut into rectangles ("homes"). Piece i shows the part of the picture that belongs in home i, but starts in some other
 * home's place (its "slot") and is stretched to that slot's size. Clicking two pieces makes them trade places and sizes; the puzzle is solved when every piece is
 * back in its own home.
 */
export class FocusGame {
  readonly homes: Rect[];
  /** slotOf[i] = the home whose place piece i sits in. */
  readonly slotOf: number[];
  selected = -1;
  swaps = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    options: FocusOptions,
  ) {
    const rng = new Rng(options.seed);
    this.homes = focusLayout(new Rng(rng.below(0x7fffffff)), width, height, options.pieces, options.irregular);
    this.slotOf = scramble(rng, this.homes.length);
  }

  get count(): number {
    return this.homes.length;
  }

  get solved(): boolean {
    return this.slotOf.every((s, i) => s === i);
  }

  /** Where piece i is drawn now. */
  slotRect(piece: number): Rect {
    return this.homes[this.slotOf[piece]];
  }

  /** The piece that is drawn at a picture position, or -1. (Later pieces win where rectangles touch.) */
  pieceAt(x: number, y: number): number {
    for (let i = 0; i < this.count; i++) {
      const r = this.slotRect(i);
      if (x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) return i;
    }
    return -1;
  }

  /** Is piece i where it belongs? */
  placed(piece: number): boolean {
    return this.slotOf[piece] === piece;
  }

  /**
   * A click on a piece: chooses it, or (when another is already chosen) swaps the two. Returns what happened.
   * 'select' / 'deselect' / 'swap' / 'none'.
   */
  click(piece: number): 'select' | 'deselect' | 'swap' | 'none' {
    if (this.solved || piece < 0 || piece >= this.count) return 'none';
    if (this.selected < 0) {
      this.selected = piece;
      return 'select';
    }
    if (this.selected === piece) {
      this.selected = -1;
      return 'deselect';
    }
    this.swap(this.selected, piece);
    this.selected = -1;
    return 'swap';
  }

  swap(a: number, b: number): void {
    const t = this.slotOf[a];
    this.slotOf[a] = this.slotOf[b];
    this.slotOf[b] = t;
    this.swaps++;
  }
}

/** A shuffle with few pieces left where they belong, and never the solved puzzle. */
export function scramble(rng: Rng, n: number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  if (n < 2) return p;
  const allowed = Math.floor(n / 4);
  for (let attempt = 0; attempt < 200; attempt++) {
    for (let i = 0; i < n; i++) p[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = rng.below(i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    let fixed = 0;
    for (let i = 0; i < n; i++) if (p[i] === i) fixed++;
    if (fixed <= allowed && fixed < n) return p;
  }
  return p.map((_, i) => (i + 1) % n); // a rotation moves every piece
}
