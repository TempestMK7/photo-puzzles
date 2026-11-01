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
  /** The longest strip, in cells (the shortest is 3). */
  maxLen: number;
  /** Percent of the strips that are already in place at the start. */
  placed: number;
  /** How many tabs the loose strips are spread over (1 - 12). */
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

/** The picture's size in cells: about `cells` of them, in the shape of the photo. */
export function pictureSize(width: number, height: number, cells: number): { picCols: number; picRows: number } {
  const picCols = Math.min(80, Math.max(4, Math.round(Math.sqrt((cells * width) / Math.max(1, height)))));
  const picRows = Math.min(80, Math.max(4, Math.round(cells / picCols)));
  return { picCols, picRows };
}

/** A strip as laid in the picture (cell coordinates inside the picture). */
interface Cut {
  x: number;
  y: number;
  len: number;
  horizontal: boolean;
}

/**
 * Covers the whole picture with straight strips (1 x N cells, N from 3 to maxLen), so that every cell is covered and every strip covers at least one cell that no
 * other strip covers (that cell is what makes the strip's place certain). Strips may cross; strips lying along each other are avoided where there is a choice.
 * The number of strips is whatever that takes. Returns null when some cell could not be covered under these rules (the caller tries again).
 */
function coverPicture(rng: Rng, picCols: number, picRows: number, maxLen: number): Cut[] | null {
  const owner: number[][] = Array.from({ length: picCols * picRows }, () => []);
  const cuts: Cut[] = [];
  const unique: number[] = [];
  const order = Array.from({ length: picCols * picRows }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.below(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const cell of order) {
    if (owner[cell].length) continue;
    const cx = cell % picCols;
    const cy = Math.floor(cell / picCols);
    const all: { cut: Cut; fresh: number; parallel: boolean }[] = [];
    for (const horizontal of [true, false]) {
      for (let len = 3; len <= maxLen; len++) {
        for (let k = 0; k < len; k++) {
          const x = horizontal ? cx - k : cx;
          const y = horizontal ? cy : cy - k;
          if (x < 0 || y < 0 || (horizontal ? x + len > picCols : x >= picCols) || (horizontal ? y >= picRows : y + len > picRows)) continue;
          const lost = new Map<number, number>();                  // strips that would lose a cell that only they cover
          let fresh = 0;
          let parallel = false;
          for (let i = 0; i < len; i++) {
            const owners = owner[(horizontal ? y : y + i) * picCols + (horizontal ? x + i : x)];
            if (!owners.length) fresh++;
            if (owners.length === 1) lost.set(owners[0], (lost.get(owners[0]) ?? 0) + 1);
            for (const o of owners) if (cuts[o].horizontal === horizontal) parallel = true;
          }
          let ok = fresh >= 1;
          for (const [o, n] of lost) if (unique[o] - n < 1) ok = false;
          if (ok) all.push({ cut: { x, y, len, horizontal }, fresh, parallel });
        }
      }
    }
    let pool = all.filter((c) => !c.parallel);                    // not along another strip, if that can be avoided
    if (!pool.length) pool = all;
    const half = pool.filter((c) => c.fresh * 2 >= c.cut.len);   // and covering mostly new cells, if that can be had
    if (half.length) pool = half;
    if (!pool.length) return null;
    const { cut } = pool[rng.below(pool.length)];
    const id = cuts.length;
    cuts.push(cut);
    unique.push(0);
    for (let i = 0; i < cut.len; i++) {
      const c = (cut.horizontal ? cut.y : cut.y + i) * picCols + (cut.horizontal ? cut.x + i : cut.x);
      if (owner[c].length === 0) unique[id]++;
      else if (owner[c].length === 1) unique[owner[c][0]]--;
      owner[c].push(id);
    }
  }
  return cuts;
}

/** Width and height in cells of a strip's box at a given turn. */
export function boxOf(def: StripDef, angle: number): { w: number; h: number } {
  const alongX = def.horizontal === (angle % 2 === 0);
  return alongX ? { w: def.len, h: 1 } : { w: 1, h: def.len };
}

/** Cuts the whole picture into overlapping straight strips (see coverPicture) and scatters them over the field, turned at random, on the tabs. */
export function generateStrips(rng: Rng, o: StripsOptions): StripsSetup {
  const { picCols, picRows } = o;
  const cols = picCols + 2 * MARGIN;
  const rows = picRows + 2 * MARGIN;
  const maxLen = Math.max(3, Math.min(o.maxLen, Math.max(picCols, picRows)));
  let cuts: Cut[] | null = null;
  for (let attempt = 0; attempt < 40 && !cuts; attempt++) cuts = coverPicture(rng, picCols, picRows, maxLen);
  if (!cuts) throw new Error('could not cut the picture into strips');
  const defs: StripDef[] = cuts.map((c, id) => ({ id, len: c.len, horizontal: c.horizontal, hx: MARGIN + c.x, hy: MARGIN + c.y }));
  const tabs = Math.min(12, Math.max(1, Math.round(o.tabs)));
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

export interface StripsState {
  state: StripState[];
  z: number[];
  moves: number;
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

  /** Everything that changes while the puzzle is played, as plain data (the rest follows from the seed). */
  snapshot(): StripsState {
    return { state: this.state.map((s) => ({ ...s })), z: [...this.z], moves: this.moves };
  }

  /** Puts a snapshot back; throws if it does not belong to this puzzle. */
  restore(s: StripsState): void {
    const n = this.defs.length;
    if (s.state?.length !== n || s.z?.length !== n || new Set(s.z).size !== n || !s.z.every((v) => Number.isInteger(v) && v >= 0 && v < n)) throw new Error('not this puzzle');
    const ok = s.state.every(
      (t) => Number.isInteger(t.angle) && t.angle >= 0 && t.angle < 4 && Number.isInteger(t.x) && Number.isInteger(t.y) && Number.isInteger(t.tab) && t.tab >= 0 && t.tab < this.tabs,
    );
    if (!ok) throw new Error('not this puzzle');
    for (let i = 0; i < n; i++) this.state[i] = { angle: s.state[i].angle, x: s.state[i].x, y: s.state[i].y, locked: !!s.state[i].locked, tab: s.state[i].tab };
    for (let i = 0; i < n; i++) this.z[i] = s.z[i];
    this.moves = Math.max(0, Math.floor(Number(s.moves) || 0));
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
