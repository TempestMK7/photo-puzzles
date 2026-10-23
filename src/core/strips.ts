import { Rng } from './rng';

/** The room loose strips have round the picture, in cells. */
export const MARGIN = 3;

export interface StripDef {
  id: number;
  len: number;
  /** In the picture the strip runs along x (true) or along y (false). */
  horizontal: boolean;
  /** Top-left cell of the strip's home, in field cells (the picture sits MARGIN cells in from the field's edge). */
  hx: number;
  hy: number;
}

export interface StripState {
  /** Quarter turns clockwise from the way it lies in the picture. */
  angle: number;
  /** Top-left cell of the strip's box now. */
  x: number;
  y: number;
  locked: boolean;
  /** The tab the strip lies on (every tab shows the same picture with the same holes and its own loose strips). */
  tab: number;
}

export interface StripsOptions {
  /** Picture size in cells. */
  picCols: number;
  picRows: number;
  strips: number;
  maxLen: number;
  /** Percent of the strips that are already in place at the start. */
  placed: number;
  /** How many tabs the loose strips are spread over (1 - 10). */
  tabs: number;
}

export interface StripsSetup {
  cols: number;
  rows: number;
  picCols: number;
  picRows: number;
  tabs: number;
  defs: StripDef[];
  state: StripState[];
}

/**
 * The picture's size in cells: the more strips there are (and the longer they may be), the more cells there are, so that the strips keep covering about the same
 * share of the picture. 14 strips of up to 8 cells on a 3:2 photo give 16 x 11.
 */
export function pictureCells(width: number, height: number, strips: number, maxLen: number): { picCols: number; picRows: number } {
  const longest = Math.max(3, maxLen);
  const total = Math.max(60, (strips * (3 + longest)) / 2 / 0.45);
  const aspect = Math.max(width, height) / Math.max(1, Math.min(width, height));
  const long = Math.min(64, Math.max(10, longest + 2, Math.round(Math.sqrt(total * aspect))));
  const short = Math.min(long, Math.max(6, Math.round(total / long)));
  return width >= height ? { picCols: long, picRows: short } : { picCols: short, picRows: long };
}

/** Width and height in cells of a strip's box at a given turn. */
export function boxOf(def: StripDef, angle: number): { w: number; h: number } {
  const alongX = def.horizontal === (angle % 2 === 0);
  return alongX ? { w: def.len, h: 1 } : { w: 1, h: def.len };
}

/** Cuts straight strips (1 x N cells) out of the picture - they may cross, never run along each other - and scatters them over the field turned at random. */
export function generateStrips(rng: Rng, o: StripsOptions): StripsSetup {
  const { picCols, picRows } = o;
  const cols = picCols + 2 * MARGIN;
  const rows = picRows + 2 * MARGIN;
  const maxLen = Math.max(3, Math.min(o.maxLen, Math.max(picCols, picRows)));
  const owner: number[][] = Array.from({ length: picCols * picRows }, () => []);
  const defs: StripDef[] = [];
  for (let attempt = 0; attempt < 4000 + 200 * o.strips && defs.length < o.strips; attempt++) {
    const horizontal = rng.below(2) === 0;
    const len = 3 + rng.below(maxLen - 2);
    const w = horizontal ? len : 1;
    const h = horizontal ? 1 : len;
    if (w > picCols || h > picRows) continue;
    const x = rng.below(picCols - w + 1);
    const y = rng.below(picRows - h + 1);
    let ok = true;
    let shared = 0;
    for (let dy = 0; dy < h && ok; dy++) {
      for (let dx = 0; dx < w; dx++) {
        for (const other of owner[(y + dy) * picCols + x + dx]) {
          shared++;
          if (defs[other].horizontal === horizontal) ok = false;       // two strips along each other would be ambiguous
        }
      }
    }
    if (!ok || shared > 1) continue;
    const id = defs.length;
    defs.push({ id, len, horizontal, hx: MARGIN + x, hy: MARGIN + y });
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) owner[(y + dy) * picCols + x + dx].push(id);
  }
  const tabs = Math.min(10, Math.max(1, Math.round(o.tabs)));
  const placedCount = Math.min(defs.length - 1, Math.round((defs.length * Math.min(50, Math.max(0, o.placed))) / 100));
  const state: StripState[] = defs.map((d, i) => {
    if (i < placedCount) return { angle: 0, x: d.hx, y: d.hy, locked: true, tab: 0 };
    for (;;) {
      const angle = rng.below(4);
      const b = boxOf(d, angle);
      const x = rng.below(cols - b.w + 1);
      const y = rng.below(rows - b.h + 1);
      if (angle === 0 && x === d.hx && y === d.hy) continue;           // never already home
      return { angle, x, y, locked: false, tab: rng.below(tabs) };
    }
  });
  return { cols, rows, picCols, picRows, tabs, defs, state };
}

/** The rules of Strips. */
export class StripsGame {
  readonly cols: number;
  readonly rows: number;
  readonly picCols: number;
  readonly picRows: number;
  readonly tabs: number;
  readonly defs: StripDef[];
  readonly state: StripState[];
  /** Back to front. */
  readonly z: number[];
  moves = 0;

  constructor(setup: StripsSetup) {
    this.cols = setup.cols;
    this.rows = setup.rows;
    this.picCols = setup.picCols;
    this.picRows = setup.picRows;
    this.tabs = setup.tabs;
    this.defs = setup.defs;
    this.state = setup.state.map((s) => ({ ...s }));
    this.z = this.defs.map((d) => d.id);
  }

  get total(): number {
    return this.defs.length;
  }

  get lockedCount(): number {
    return this.state.filter((s) => s.locked).length;
  }

  get solved(): boolean {
    return this.state.every((s) => s.locked);
  }

  isHome(id: number): boolean {
    const s = this.state[id];
    const d = this.defs[id];
    return s.angle === 0 && s.x === d.hx && s.y === d.hy;
  }

  /** How many loose strips lie on each tab. */
  looseCounts(): number[] {
    const n = new Array<number>(this.tabs).fill(0);
    for (const s of this.state) if (!s.locked) n[s.tab]++;
    return n;
  }

  /** Puts a loose strip on another tab (where it lies on the board stays as it is). */
  moveToTab(id: number, tab: number): void {
    if (this.state[id].locked || tab < 0 || tab >= this.tabs) return;
    this.state[id].tab = tab;
  }

  /** The front-most loose strip on `tab` covering field cell (cx, cy), or -1. */
  stripAt(cx: number, cy: number, tab = 0): number {
    for (let i = this.z.length - 1; i >= 0; i--) {
      const id = this.z[i];
      const s = this.state[id];
      if (s.locked || s.tab !== tab) continue;
      const b = boxOf(this.defs[id], s.angle);
      if (cx >= s.x && cy >= s.y && cx < s.x + b.w && cy < s.y + b.h) return id;
    }
    return -1;
  }

  bringToFront(id: number): void {
    this.z.splice(this.z.indexOf(id), 1);
    this.z.push(id);
  }

  /** Moves the strip's box to (x, y), kept inside the field. */
  moveTo(id: number, x: number, y: number): void {
    const s = this.state[id];
    if (s.locked) return;
    const b = boxOf(this.defs[id], s.angle);
    s.x = Math.min(this.cols - b.w, Math.max(0, x));
    s.y = Math.min(this.rows - b.h, Math.max(0, y));
  }

  /** A quarter turn about the strip's middle cell; the strip stays inside the field. Returns true when the turn put it home (and locked it). */
  rotate(id: number, delta = 1): boolean {
    const s = this.state[id];
    const d = this.defs[id];
    if (s.locked) return false;
    const before = boxOf(d, s.angle);
    const pivot = Math.floor((d.len - 1) / 2);
    s.angle = (s.angle + delta + 4) % 4;
    const after = boxOf(d, s.angle);
    if (before.w !== after.w) {                                 // the middle cell stays where it is
      if (before.w > 1) { s.x += pivot; s.y -= pivot; }          // lying down -> standing up
      else { s.x -= pivot; s.y += pivot; }
    }
    this.moveTo(id, s.x, s.y);
    return this.lockIfHome(id);
  }

  /** Called when a strip is put down: it locks when it lies exactly where it belongs, turned the right way. */
  lockIfHome(id: number): boolean {
    if (!this.isHome(id) || this.state[id].locked) return false;
    this.state[id].locked = true;
    return true;
  }
}
