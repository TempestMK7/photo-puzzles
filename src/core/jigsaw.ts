import type { Rng } from './rng';

/**
 * Jigsaw. The picture is cut into square cells (so the number of pieces is only approximately what was asked for); every cell becomes a piece with a tab or a blank
 * on each side that has a neighbour. Pieces lie in groups: a group is one or more pieces that have been joined, which move as one. A group is either loose, or anchored
 * (part of the finished picture, fixed in place). The four corner pieces start anchored; a loose group that is put next to a piece it belongs beside joins that
 * piece's group, and a group that joins an anchored one becomes anchored itself.
 *
 * A group lies on the table turned by `rot` quarter turns (clockwise) and moved by (dx, dy): a point p of the solved picture (relative to its top-left corner) is at
 * R(rot) p + (dx, dy). A group with rot 0 and offset (0, 0) is where it belongs. Only groups turned the same way can fit together.
 */

/** A vector turned `rot` quarter turns clockwise (y points down). */
export function rotVec(rot: number, x: number, y: number): [number, number] {
  switch (((rot % 4) + 4) % 4) {
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    case 3:
      return [y, -x];
    default:
      return [x, y];
  }
}

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

/** Whether piece `i` lies on the border of the picture (the corners do too). */
export function isEdgePiece(cols: number, rows: number, i: number): boolean {
  const c = i % cols;
  const r = Math.floor(i / cols);
  return c === 0 || r === 0 || c === cols - 1 || r === rows - 1;
}

/**
 * The pieces, besides the corners, that begin in their place: `percent` of all the pieces, picked at random. With `edgesApart` the edge pieces are left out of the
 * pick (they start somewhere else), so there can be fewer than that when the inside is too small for them.
 */
export function pickPlaced(layout: JigsawLayout, rng: Rng, percent: number, edgesApart: boolean): Set<number> {
  const { cols, rows } = layout;
  const corners = new Set([0, cols - 1, (rows - 1) * cols, cols * rows - 1]);
  const pool: number[] = [];
  for (let i = 0; i < cols * rows; i++) if (!corners.has(i) && !(edgesApart && isEdgePiece(cols, rows, i))) pool.push(i);
  const most = edgesApart ? pool.length : pool.length - 1;         // never the whole picture
  const want = Math.max(0, Math.min(most, Math.round((cols * rows * Math.min(100, Math.max(0, percent))) / 100)));
  const out = new Set<number>();
  for (let k = 0; k < want; k++) {                                // the first `want` of a shuffle
    const j = k + rng.below(pool.length - k);
    [pool[k], pool[j]] = [pool[j], pool[k]];
    out.add(pool[k]);
  }
  return out;
}

export interface Group {
  id: number;
  members: number[];
  /** Quarter turns clockwise (0-3) and offset, in picture pixels: see above. */
  rot: number;
  dx: number;
  dy: number;
  /** Part of the finished picture: fixed at offset (0, 0). */
  anchored: boolean;
}

export interface JigsawState {
  groups: { members: number[]; rot: number; dx: number; dy: number; anchored: boolean }[];
  /** Loose groups back to front, as indexes into `groups`. */
  z: number[];
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

  /**
   * `start(i)` gives the turn (none, if left out) and offset of piece i's group when the puzzle begins. The four corners and the pieces in `placed` ignore it and start
   * anchored; those that touch are one group from the start.
   */
  constructor(layout: JigsawLayout, start: (piece: number) => { dx: number; dy: number; rot?: number }, placed: ReadonlySet<number> = new Set()) {
    this.cols = layout.cols;
    this.rows = layout.rows;
    this.size = layout.size;
    this.count = layout.cols * layout.rows;
    this.groupOf = new Int32Array(this.count);
    const corners = new Set([0, this.cols - 1, (this.rows - 1) * this.cols, this.count - 1]);
    const home = (i: number) => corners.has(i) || placed.has(i);
    const done = new Uint8Array(this.count);
    for (let i = 0; i < this.count; i++) {
      if (done[i]) continue;
      const g: Group = { id: this.nextId++, members: [], rot: 0, dx: 0, dy: 0, anchored: home(i) };
      if (g.anchored) {
        const open = [i];                                         // everything anchored that touches piece i
        done[i] = 1;
        while (open.length) {
          const p = open.pop()!;
          g.members.push(p);
          this.groupOf[p] = g.id;
          const c = p % this.cols;
          const r = Math.floor(p / this.cols);
          for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]]) {
            if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
            const q = nr * this.cols + nc;
            if (!done[q] && home(q)) {
              done[q] = 1;
              open.push(q);
            }
          }
        }
        g.members.sort((a, b) => a - b);
      } else {
        const o = start(i);
        g.members.push(i);
        g.rot = o.rot ?? 0;
        g.dx = o.dx;
        g.dy = o.dy;
        this.groupOf[i] = g.id;
        this.z.push(g.id);
        done[i] = 1;
      }
      this.groups.set(g.id, g);
    }
  }

  /** Everything that changes while the puzzle is played, as plain data (the pieces and their shapes follow from the seed). */
  snapshot(): JigsawState {
    const groups = [...this.groups.values()];
    const index = new Map(groups.map((g, i) => [g.id, i]));
    return {
      groups: groups.map((g) => ({ members: [...g.members], rot: g.rot, dx: g.dx, dy: g.dy, anchored: g.anchored })),
      z: this.z.map((id) => index.get(id)!),
    };
  }

  /** Puts a snapshot back; throws if it does not belong to this puzzle (every piece must lie in exactly one group, the corners in anchored ones). */
  restore(s: JigsawState): void {
    const seen = new Uint8Array(this.count);
    for (const g of s.groups ?? []) {
      if (!Array.isArray(g.members) || !g.members.length || !Number.isInteger(g.rot) || g.rot < 0 || g.rot > 3 || !Number.isFinite(g.dx) || !Number.isFinite(g.dy)) throw new Error('not this puzzle');
      for (const m of g.members) {
        if (!Number.isInteger(m) || m < 0 || m >= this.count || seen[m]) throw new Error('not this puzzle');
        seen[m] = 1;
      }
    }
    if (seen.includes(0)) throw new Error('not this puzzle');
    const corners = [0, this.cols - 1, (this.rows - 1) * this.cols, this.count - 1];
    this.groups.clear();
    this.z.length = 0;
    this.nextId = 0;
    const ids: number[] = [];
    for (const g of s.groups) {
      const grp: Group = { id: this.nextId++, members: [...g.members], rot: g.anchored ? 0 : g.rot, dx: g.anchored ? 0 : g.dx, dy: g.anchored ? 0 : g.dy, anchored: !!g.anchored };
      this.groups.set(grp.id, grp);
      ids.push(grp.id);
      for (const m of grp.members) this.groupOf[m] = grp.id;
    }
    for (const c of corners) if (!this.groups.get(this.groupOf[c])!.anchored) throw new Error('not this puzzle');
    const listed = new Set<number>();
    for (const i of s.z) {
      const id = ids[i];
      if (id === undefined || this.groups.get(id)!.anchored || listed.has(id)) throw new Error('not this puzzle');
      listed.add(id);
      this.z.push(id);
    }
    for (const g of this.groups.values()) if (!g.anchored && !listed.has(g.id)) this.z.push(g.id);
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
      const [sx, sy] = rotVec(4 - g.rot, px - g.dx, py - g.dy);       // back into the solved picture
      const c = Math.floor(sx / this.size);
      const r = Math.floor(sy / this.size);
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

  /** Puts a loose group where it is said to be (turned `rot` quarter turns, offset (dx, dy)); no joining. */
  setPose(id: number, dx: number, dy: number, rot: number): void {
    const g = this.groups.get(id);
    if (g && !g.anchored) {
      g.dx = dx;
      g.dy = dy;
      g.rot = ((Math.round(rot) % 4) + 4) % 4;
    }
  }

  /** The solved-picture point that lies at table point (px, py) when the group is where it is. */
  toSolved(g: Group, px: number, py: number): [number, number] {
    return rotVec(4 - g.rot, px - g.dx, py - g.dy);
  }

  /** Turns a loose group a quarter turn clockwise about the table point (px, py), which stays where it is. */
  rotate(id: number, px: number, py: number): void {
    const g = this.groups.get(id);
    if (!g || g.anchored) return;
    const [sx, sy] = this.toSolved(g, px, py);
    g.rot = (g.rot + 1) % 4;
    const [rx, ry] = rotVec(g.rot, sx, sy);
    g.dx = px - rx;
    g.dy = py - ry;
  }

  /** The middle of the group, as a table point. */
  centre(id: number): [number, number] {
    const g = this.groups.get(id)!;
    let sx = 0;
    let sy = 0;
    for (const m of g.members) {
      sx += ((m % this.cols) + 0.5) * this.size;
      sy += (Math.floor(m / this.cols) + 0.5) * this.size;
    }
    const [rx, ry] = rotVec(g.rot, sx / g.members.length, sy / g.members.length);
    return [g.dx + rx, g.dy + ry];
  }

  /** Whether some other group lies right against group `id`, turned the same way (it would join if `connect` were called). */
  canJoin(id: number, tol: number): boolean {
    const g = this.groups.get(id);
    return !!g && this.neighbour(g, tol) !== null;
  }

  private neighbour(g: Group, tol: number): Group | null {
    for (const m of g.members) {
      const c = m % this.cols;
      const r = Math.floor(m / this.cols);
      for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]]) {
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
        const other = this.groups.get(this.groupOf[nr * this.cols + nc]);
        if (!other || other.id === g.id || other.rot !== g.rot) continue;
        if (Math.abs(g.dx - other.dx) <= tol && Math.abs(g.dy - other.dy) <= tol) return other;
      }
    }
    return null;
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
      const other = this.neighbour(g, tol);
      if (other) {
        cur = this.merge(g, other).id;
        joins++;
        again = true;
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
    const at = anchored ? { dx: 0, dy: 0, rot: 0 } : { dx: b.dx, dy: b.dy, rot: b.rot };
    for (const m of small.members) this.groupOf[m] = big.id;
    big.members.push(...small.members);
    big.rot = at.rot;
    big.dx = at.dx;
    big.dy = at.dy;
    big.anchored = anchored;
    this.groups.delete(small.id);
    this.dropFromLoose(small.id);
    if (anchored) this.dropFromLoose(big.id);                // anchored groups are not in the loose list
    return big;
  }
}
