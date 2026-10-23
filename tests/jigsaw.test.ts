import { describe, expect, it } from 'vitest';
import { edgeSegments, JigsawGame, layoutJigsaw, reverseSegments, rotVec, TAB_REACH, type JigsawLayout } from '../src/core/jigsaw';
import { Rng } from '../src/core/rng';

const layout = (seed = 1, w = 1200, h = 800, target = 100): JigsawLayout => layoutJigsaw(new Rng(seed), w, h, target);
/** Every loose piece starts far from home, apart from each other. */
const scatter = (i: number) => ({ dx: 1000 + i * 37, dy: -800 - i * 23 });

describe('layoutJigsaw', () => {
  it('cuts about the number of pieces asked for, from 100 to 5000', () => {
    for (const target of [100, 300, 1000, 2500, 5000]) {
      const l = layout(2, 1600, 1066, target);
      const n = l.cols * l.rows;
      expect(n / target).toBeGreaterThan(0.95);
      expect(n / target).toBeLessThan(1.05);
      expect(l.cols * l.size).toBeLessThanOrEqual(1600);
      expect(l.rows * l.size).toBeLessThanOrEqual(1066);
    }
  });

  it('has flat borders and a tab or a blank on every inner edge, and is reproducible', () => {
    const l = layout(3);
    expect(l.h).toHaveLength((l.rows + 1) * l.cols);
    expect(l.v).toHaveLength(l.rows * (l.cols + 1));
    for (let c = 0; c < l.cols; c++) {
      expect(l.h[c].dir).toBe(0);
      expect(l.h[l.rows * l.cols + c].dir).toBe(0);
    }
    for (let r = 0; r < l.rows; r++) {
      expect(l.v[r * (l.cols + 1)].dir).toBe(0);
      expect(l.v[r * (l.cols + 1) + l.cols].dir).toBe(0);
    }
    expect(l.h.filter((_, i) => i >= l.cols && i < l.rows * l.cols).every((e) => e.dir !== 0)).toBe(true);
    expect(l.v.some((e) => e.dir === 1) && l.v.some((e) => e.dir === -1)).toBe(true);
    expect(layout(3)).toEqual(l);
  });
});

describe('edge curves', () => {
  it('run from (0, 0) to (1, 0) without a gap, and back again when reversed', () => {
    for (const e of layout(4).h) {
      const segs = edgeSegments(e);
      const last = segs[segs.length - 1];
      expect([last[4], last[5]]).toEqual([1, 0]);
      const back = reverseSegments(segs);
      expect(back).toHaveLength(segs.length);
      let at: [number, number] = [1, 0];                          // walking back, every segment starts where the one before ended
      for (const s of back) at = [s[4], s[5]];
      expect(at).toEqual([0, 0]);
      if (segs.length > 1) expect([back[0][4], back[0][5]]).toEqual([segs[segs.length - 1 - 1][4], segs[segs.length - 1 - 1][5]]);
    }
  });

  it('a tab sticks out the way dir says, and no further than the margin a piece image has', () => {
    const l = layout(5);
    for (const e of l.h) {
      if (e.dir === 0) continue;
      const ys = edgeSegments(e).flatMap((s) => [s[1], s[3], s[5]]);
      const reach = Math.max(...ys.map((y) => Math.abs(y)));
      expect(reach).toBeLessThanOrEqual(TAB_REACH);
      expect(Math.sign(ys.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0))).toBe(e.dir);
    }
  });
});

describe('JigsawGame', () => {
  it('starts with the four corners anchored and nothing else', () => {
    const l = layout(6);
    const g = new JigsawGame(l, scatter);
    const corners = [0, l.cols - 1, (l.rows - 1) * l.cols, l.cols * l.rows - 1];
    for (let i = 0; i < g.count; i++) expect(g.groups.get(g.groupOf[i])!.anchored).toBe(corners.includes(i));
    expect(g.anchoredCount).toBe(4);
    expect(g.z).toHaveLength(g.count - 4);
    expect(g.solved).toBe(false);
    expect(g.groupAt(l.size / 2, l.size / 2)).toBe(-1); // an anchored piece cannot be picked up
  });

  it('picks the loose group under a point, front-most first', () => {
    const l = layout(7);
    const g = new JigsawGame(l, () => ({ dx: 500, dy: 500 }));
    const a = g.groupOf[1];
    const b = g.groupOf[2];
    // piece 1 and 2 both sit at offset (500, 500): their cells are side by side, so a point in cell 1 is piece 1's
    expect(g.groupAt(l.size * 1.5 + 500, l.size * 0.5 + 500)).toBe(a);
    expect(g.groupAt(l.size * 2.5 + 500, l.size * 0.5 + 500)).toBe(b);
    g.moveTo(a, 5000, 5000);
    expect(g.groupAt(l.size * 1.5 + 5000, l.size * 0.5 + 5000)).toBe(a);
    expect(g.groupAt(l.size * 1.5 + 500, l.size * 0.5 + 500)).toBe(-1);
  });

  it('a loose piece put next to an anchored neighbour, nearly right, becomes part of the picture', () => {
    const l = layout(8);
    const g = new JigsawGame(l, scatter);
    const id = g.groupOf[1]; // next to corner 0
    g.moveTo(id, 3, -2);
    const r = g.connect(id, 8);
    expect(r.joins).toBeGreaterThanOrEqual(1);
    const grp = g.groups.get(g.groupOf[1])!;
    expect(grp.anchored && grp.dx === 0 && grp.dy === 0).toBe(true);
    expect(g.anchoredCount).toBe(5);
    expect(g.z).not.toContain(g.groupOf[1]);
  });

  it('a piece too far off its neighbour does not join', () => {
    const l = layout(9);
    const g = new JigsawGame(l, scatter);
    const id = g.groupOf[1];
    g.moveTo(id, 40, 0);
    expect(g.connect(id, 8).joins).toBe(0);
    expect(g.anchoredCount).toBe(4);
    expect(g.groups.get(id)!.dx).toBe(40);
  });

  it('two loose pieces that fit together join into one group that moves as one', () => {
    const l = layout(10, 1200, 800, 300);
    const g = new JigsawGame(l, scatter);
    const p = 5 + l.cols * 3;
    const q = p + 1; // right neighbour
    const gp = g.groupOf[p];
    g.moveTo(gp, 100, 100);
    g.moveTo(g.groupOf[q], 102, 99);
    const r = g.connect(g.groupOf[q], 8);
    expect(r.joins).toBe(1);
    expect(g.groupOf[p]).toBe(g.groupOf[q]);
    const grp = g.groups.get(g.groupOf[p])!;
    expect(grp.members.sort((a, b) => a - b)).toEqual([p, q]);
    expect(grp.anchored).toBe(false);
    expect(grp.dx).toBe(100); // the one that was already there stays put, the other snaps to it
    g.moveTo(grp.id, 300, 200);
    expect(g.groups.get(g.groupOf[q])!.dx).toBe(300);
    expect(g.groupAt(p % l.cols * l.size + 5 + 300, Math.floor(p / l.cols) * l.size + 5 + 200)).toBe(grp.id);
  });

  it('joining an anchored group anchors everything that is already joined to it, and cascades', () => {
    const l = layout(11, 1200, 800, 300);
    const g = new JigsawGame(l, scatter);
    const a = 1;
    const b = 2;
    const c = 3;
    g.moveTo(g.groupOf[b], 50, 50);
    g.moveTo(g.groupOf[c], 51, 49);
    g.connect(g.groupOf[c], 8); // b + c, loose
    expect(g.groupOf[b]).toBe(g.groupOf[c]);
    g.moveTo(g.groupOf[a], 0, 1);
    const r = g.connect(g.groupOf[a], 8); // a joins corner 0 ...
    expect(r.joins).toBeGreaterThanOrEqual(1);
    g.moveTo(g.groupOf[b], 4, 3);
    g.connect(g.groupOf[b], 8); // ... and the b + c group joins a
    for (const i of [a, b, c]) expect(g.groups.get(g.groupOf[i])!.anchored).toBe(true);
    expect(g.groupOf[a]).toBe(g.groupOf[0]);
  });

  it('is solved when every piece has joined the picture', () => {
    const l = layout(12, 600, 400, 100);
    const g = new JigsawGame(l, scatter);
    for (let i = 0; i < g.count; i++) {
      const id = g.groupOf[i];
      if (g.groups.get(id)!.anchored) continue;
      g.moveTo(id, 1, 1);
      g.connect(id, 8);
    }
    expect(g.solved).toBe(true);
    expect(g.groups.size).toBe(1);
    expect(g.z).toHaveLength(0);
  });
});

describe('turned pieces', () => {
  it('turns vectors clockwise, a quarter at a time', () => {
    expect(rotVec(0, 3, 1)).toEqual([3, 1]);
    expect(rotVec(1, 1, 0)).toEqual([-0, 1]);
    expect(rotVec(2, 3, 1)).toEqual([-3, -1]);
    expect(rotVec(3, 1, 0)).toEqual([0, -1]);
    expect(rotVec(5, 3, 1)).toEqual(rotVec(1, 3, 1));
  });

  it('turns a group about a point that stays where it is, and four turns bring it back', () => {
    const l = layout(13, 1200, 800, 300);
    const g = new JigsawGame(l, () => ({ dx: 400, dy: 300, rot: 2 }));
    const id = g.groupOf[7 + 2 * l.cols];
    const grp = g.groups.get(id)!;
    const px = 450;
    const py = 330;
    const [sx, sy] = g.toSolved(grp, px, py);
    g.rotate(id, px, py);
    expect(grp.rot).toBe(3);
    const [tx, ty] = g.toSolved(grp, px, py);
    expect([tx, ty]).toEqual([sx, sy]);
    const start = { ...grp };
    for (let i = 0; i < 4; i++) g.rotate(id, 10, 20);
    expect(grp.rot).toBe(start.rot);
    expect(grp.dx).toBeCloseTo(start.dx);
    expect(grp.dy).toBeCloseTo(start.dy);
  });

  it('finds a turned piece where it is drawn', () => {
    const l = layout(14, 1200, 800, 300);
    const g = new JigsawGame(l, () => ({ dx: 600, dy: 500, rot: 1 }));
    const p = 5 + 3 * l.cols;
    const id = g.groupOf[p];
    // the centre of cell p, turned a quarter about the group's offset
    const [cx, cy] = rotVec(1, ((p % l.cols) + 0.5) * l.size, (Math.floor(p / l.cols) + 0.5) * l.size);
    expect(g.groupAt(600 + cx, 500 + cy)).toBe(id);
    expect(g.groupAt(600 + cx + l.size, 500 + cy)).not.toBe(id);
    const c = g.centre(id);
    expect(c[0]).toBeCloseTo(600 + cx);
    expect(c[1]).toBeCloseTo(500 + cy);
  });

  it('pieces only join when they are turned the same way, and the board only takes pieces turned upright', () => {
    const l = layout(15, 1200, 800, 300);
    const g = new JigsawGame(l, scatter);
    const a = g.groupOf[1];
    g.moveTo(a, 1, 1);
    g.groups.get(a)!.rot = 1;
    expect(g.canJoin(a, 8)).toBe(false);
    expect(g.connect(a, 8).joins).toBe(0);
    g.groups.get(a)!.rot = 0;
    expect(g.canJoin(a, 8)).toBe(true);
    expect(g.connect(a, 8).joins).toBe(1);
    expect(g.groups.get(g.groupOf[1])!.anchored).toBe(true);
    // two loose pieces: same offset, one turned
    const p = 5 + l.cols * 3;
    const gp = g.groupOf[p];
    const gq = g.groupOf[p + 1];
    g.moveTo(gp, 100, 100);
    g.moveTo(gq, 100, 100);
    g.groups.get(gq)!.rot = 3;
    expect(g.connect(gq, 8).joins).toBe(0);
    g.rotate(gq, 100, 100);
    g.moveTo(gq, 100, 100);
    expect(g.groups.get(gq)!.rot).toBe(0);
    expect(g.connect(gq, 8).joins).toBe(1);
  });
});
