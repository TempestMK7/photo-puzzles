import type { Rng } from './rng';

/**
 * Jigsaw. The picture is cut into square cells (so the number of pieces is only approximately what was asked for); every cell becomes a piece with a tab or a blank
 * on each side that has a neighbour. Pieces lie in groups: a group is one or more pieces that have been joined, which move as one. A group is either loose, or anchored
 * (part of the finished picture, fixed in place). The four corner pieces start anchored; a loose group that is put next to a piece it belongs beside joins that
 * piece's group, and a group that joins an anchored one becomes anchored itself.
 *
 * Positions are kept as offsets from the solved position, in picture pixels: a group with offset (0, 0) is where it belongs.
 */

/** The shape of one tab / blank, shared by the two pieces that meet at the edge. */
export interface Edge {
  /** +1: the piece above (or to the left) has the tab. -1: the other one has. 0: a flat border edge. */
  dir: -1 | 0 | 1;
  /** Where along the edge the tab sits (0.5 = middle), and how wide / tall its parts are, in edge lengths. */
  at: number;
  neck: number;
  head: number;
  height: number;
}

export interface JigsawLayout {
  cols: number;
  rows: number;
  /** Cell size in picture pixels. */
  size: number;
  /** The picture is cropped to cols x rows cells; this is where the crop starts. */
  cropX: number;
  cropY: number;
  /** h[r * cols + c] is the edge above cell (c, r) (r = rows: below the last row); v[r * (cols + 1) + c] is the edge left of cell (c, r) (c = cols: right of the last). */
  h: Edge[];
  v: Edge[];
}

/** How far a tab sticks out of its cell, as a share of the cell size (so a piece's image needs this much margin round the cell). */
export const TAB_REACH = 0.34;

function flat(): Edge {
  return { dir: 0, at: 0.5, neck: 0.07, head: 0.1, height: 0.2 };
}

function tab(rng: Rng): Edge {
  return {
    dir: rng.below(2) === 0 ? 1 : -1,
    at: 0.5 + (rng.unit() - 0.5) * 0.14,
    neck: 0.065 + rng.unit() * 0.02,
    head: 0.09 + rng.unit() * 0.02,
    height: 0.185 + rng.unit() * 0.03,
  };
}

/** The cell size, the grid and the tab shapes for a picture of this size and about this many pieces. */
export function layoutJigsaw(rng: Rng, width: number, height: number, target: number): JigsawLayout {
  // the grid whose cell count is nearest the target, with square cells as big as fit in the picture
  const want = Math.max(4, target);
  let cols = Math.max(2, Math.round(Math.sqrt((want * width) / height)));
  let rows = Math.max(2, Math.round(want / cols));
  let size = Math.min(width / cols, height / rows);
  if (size < 6) {
    size = 6;
    cols = Math.max(2, Math.floor(width / size));
    rows = Math.max(2, Math.floor(height / size));
  }
  const h: Edge[] = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c < cols; c++) h.push(r === 0 || r === rows ? flat() : tab(rng));
  const v: Edge[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) v.push(c === 0 || c === cols ? flat() : tab(rng));
  return { cols, rows, size, cropX: Math.floor((width - cols * size) / 2), cropY: Math.floor((height - rows * size) / 2), h, v };
}

/** A cubic Bezier segment: two control points and the end point, as [x1, y1, x2, y2, x, y]. */
export type Seg = [number, number, number, number, number, number];

/**
 * The edge as cubic segments from (0, 0) to (1, 0), in edge lengths, the tab pointing towards +y (multiply y by `dir` for the real direction): a straight run, a
 * neck that widens into a round head, and the way back.
 */
export function edgeSegments(e: Edge): Seg[] {
  const line = (x0: number, x1: number): Seg => [x0 + (x1 - x0) / 3, 0, x0 + (2 * (x1 - x0)) / 3, 0, x1, 0];
  if (e.dir === 0) return [line(0, 1)];
  const { at, neck, head, height } = e;
  const hc = height; // the head's centre height
  const k = 0.5523 * head;
  const a = at - neck;
  const b = at + neck;
  const s = e.dir;
  return [
    line(0, a),
    [a, 0.04 * s, at - head * 1.05, (hc - 0.07) * s, at - head, hc * s],
    [at - head, (hc + k) * s, at - k, (hc + head) * s, at, (hc + head) * s],
    [at + k, (hc + head) * s, at + head, (hc + k) * s, at + head, hc * s],
    [at + head * 1.05, (hc - 0.07) * s, b, 0.04 * s, b, 0],
    line(b, 1),
  ];
}

/** The same edge walked from (1, 0) back to (0, 0). */
export function reverseSegments(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const [x1, y1, x2, y2] = segs[i];
    const start: [number, number] = i === 0 ? [0, 0] : [segs[i - 1][4], segs[i - 1][5]];
    out.push([x2, y2, x1, y1, start[0], start[1]]);
  }
  return out;
}

export interface Group {
  id: number;
  members: number[];
  /** Offset from the solved position, in picture pixels. */
  dx: number;
  dy: number;
  /** Part of the finished picture: fixed at offset (0, 0). */
  anchored: boolean;
}

export class JigsawGame {
  readonly cols: number;
  readonly rows: number;
  readonly size: number;
  readonly count: number;
  readonly groupOf: Int32Array;
  readonly groups = new Map<number, Group>();
  /** Loose groups, back to front. */
  readonly z: number[] = [];
  private nextId = 0;

  /** `start(i)` gives the offset of piece i's group when the puzzle begins; the four corners ignore it and start anchored. */
  constructor(layout: JigsawLayout, start: (piece: number) => { dx: number; dy: number }) {
    this.cols = layout.cols;
    this.rows = layout.rows;
    this.size = layout.size;
    this.count = layout.cols * layout.rows;
    this.groupOf = new Int32Array(this.count);
    const corners = new Set([0, this.cols - 1, (this.rows - 1) * this.cols, this.count - 1]);
    for (let i = 0; i < this.count; i++) {
      const anchored = corners.has(i);
      const o = anchored ? { dx: 0, dy: 0 } : start(i);
      const g: Group = { id: this.nextId++, members: [i], dx: o.dx, dy: o.dy, anchored };
      this.groups.set(g.id, g);
      this.groupOf[i] = g.id;
      if (!anchored) this.z.push(g.id);
    }
    // corners that touch (a 2 x n picture) are one piece of the finished picture from the start
    for (const g of [...this.groups.values()]) if (g.anchored && this.groups.has(g.id)) this.connect(g.id, 1);
  }

  get anchoredCount(): number {
    let n = 0;
    for (const g of this.groups.values()) if (g.anchored) n += g.members.length;
    return n;
  }

  get solved(): boolean {
    return this.anchoredCount === this.count;
  }

  /** The topmost loose group whose cell covers picture point (px, py) (relative to the solved picture's top-left corner), or -1. */
  groupAt(px: number, py: number): number {
    for (let i = this.z.length - 1; i >= 0; i--) {
      const g = this.groups.get(this.z[i])!;
      const c = Math.floor((px - g.dx) / this.size);
      const r = Math.floor((py - g.dy) / this.size);
      if (c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.groupOf[r * this.cols + c] === g.id) return g.id;
    }
    return -1;
  }

  bringToFront(id: number): void {
    const i = this.z.indexOf(id);
    if (i >= 0) {
      this.z.splice(i, 1);
      this.z.push(id);
    }
  }

  moveTo(id: number, dx: number, dy: number): void {
    const g = this.groups.get(id);
    if (g && !g.anchored) {
      g.dx = dx;
      g.dy = dy;
    }
  }

  /**
   * Joins group `id` to every neighbouring group it lies right against (within `tol` picture pixels of the offset that would make them fit), over and over until
   * nothing more joins. Returns the id of the group that now holds it (the group may have been absorbed) and how many joins happened.
   */
  connect(id: number, tol: number): { id: number; joins: number } {
    let joins = 0;
    let cur = id;
    for (let again = true; again; ) {
      again = false;
      const g = this.groups.get(cur);
      if (!g) break;
      for (const m of g.members) {
        const c = m % this.cols;
        const r = Math.floor(m / this.cols);
        for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]]) {
          if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
          const other = this.groups.get(this.groupOf[nr * this.cols + nc]);
          if (!other || other.id === g.id) continue;
          if (Math.abs(g.dx - other.dx) <= tol && Math.abs(g.dy - other.dy) <= tol) {
            cur = this.merge(g, other).id;
            joins++;
            again = true;
            break;
          }
        }
        if (again) break;
      }
    }
    return { id: cur, joins };
  }

  private dropFromLoose(id: number): void {
    const i = this.z.indexOf(id);
    if (i >= 0) this.z.splice(i, 1);
  }

  /** Joins two groups into the bigger one's id. The result sits where the anchored one is, or else where `b` is (the one that was not being moved). */
  private merge(a: Group, b: Group): Group {
    const [big, small] = a.members.length >= b.members.length ? [a, b] : [b, a];
    const anchored = a.anchored || b.anchored;
    const at = anchored ? { dx: 0, dy: 0 } : { dx: b.dx, dy: b.dy };
    for (const m of small.members) this.groupOf[m] = big.id;
    big.members.push(...small.members);
    big.dx = at.dx;
    big.dy = at.dy;
    big.anchored = anchored;
    this.groups.delete(small.id);
    this.dropFromLoose(small.id);
    if (anchored) this.dropFromLoose(big.id);                // anchored groups are not in the loose list
    return big;
  }
}
