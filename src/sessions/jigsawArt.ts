import { edgeSegments, reverseSegments, TAB_REACH, type JigsawLayout } from '../core/jigsaw';
import type { SessionInit } from './types';

/** The pieces, cut out of the picture once and laid side by side on one canvas (the "atlas"), so that drawing a piece is a single drawImage. */
export interface Atlas {
  canvas: HTMLCanvasElement;
  plain: HTMLCanvasElement;
  pad: number;
  tile: number;
  pitch: number;
}

/** Walks piece (c, r)'s outline with its cell's top-left corner at (ox, oy). */
export function tracePiece(ctx: CanvasRenderingContext2D, l: JigsawLayout, c: number, r: number, ox: number, oy: number): void {
  const s = l.size;
  const top = edgeSegments(l.h[r * l.cols + c]);
  const right = edgeSegments(l.v[r * (l.cols + 1) + c + 1]);
  const bottom = reverseSegments(edgeSegments(l.h[(r + 1) * l.cols + c]));
  const left = reverseSegments(edgeSegments(l.v[r * (l.cols + 1) + c]));
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  const run = (segs: ReturnType<typeof edgeSegments>, map: (u: number, v: number) => [number, number]): void => {
    for (const q of segs) {
      const [x1, y1] = map(q[0], q[1]);
      const [x2, y2] = map(q[2], q[3]);
      const [x, y] = map(q[4], q[5]);
      ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
    }
  };
  run(top, (u, v) => [ox + u * s, oy + v * s]);
  run(right, (u, v) => [ox + s + v * s, oy + u * s]);
  run(bottom, (u, v) => [ox + u * s, oy + s + v * s]);
  run(left, (u, v) => [ox + v * s, oy + u * s]);
  ctx.closePath();
}

export function buildAtlas(img: HTMLCanvasElement, l: JigsawLayout): Atlas {
  const pad = Math.ceil(l.size * TAB_REACH) + 1;
  const tile = Math.ceil(l.size) + 2 * pad;
  const pitch = tile + 2;
  const make = (): CanvasRenderingContext2D => {
    const canvas = document.createElement('canvas');
    canvas.width = l.cols * pitch;
    canvas.height = l.rows * pitch;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    return g;
  };
  const lit = make();          // loose pieces: with their outline
  const plain = make();        // pieces in the picture: no outline, and a hair wider than the cell so no gap shows between neighbours
  const pattern = lit.createPattern(img, 'no-repeat')!;
  const edge = Math.max(1, l.size * 0.03);
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const tx = c * pitch + 1;
      const ty = r * pitch + 1;
      const ox = tx + pad;
      const oy = ty + pad;
      pattern.setTransform(new DOMMatrix().translate(tx - (l.cropX + c * l.size - pad), ty - (l.cropY + r * l.size - pad)));
      for (const g of [lit, plain]) {
        g.fillStyle = pattern;
        g.strokeStyle = pattern;
        tracePiece(g, l, c, r, ox, oy);
        g.fill();
        g.lineWidth = g === plain ? 1.5 : 0.6;
        g.stroke();
      }
      lit.save();
      tracePiece(lit, l, c, r, ox, oy);
      lit.clip();
      lit.strokeStyle = 'rgba(255,255,255,0.28)';                      // a light line just inside the edge ...
      lit.lineWidth = edge * 2;
      tracePiece(lit, l, c, r, ox, oy);
      lit.stroke();
      lit.restore();
      lit.strokeStyle = 'rgba(0,0,0,0.55)';                            // ... and a dark one on it
      lit.lineWidth = edge;
      tracePiece(lit, l, c, r, ox, oy);
      lit.stroke();
    }
  }
  return { canvas: lit.canvas, plain: plain.canvas, pad, tile, pitch };
}

/** A still copy of what the pieces are cut from (a video is frozen at its current picture). */
export function snapshot(init: SessionInit): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = init.width;
  c.height = init.height;
  c.getContext('2d')!.drawImage(init.source, 0, 0, init.width, init.height);
  return c;
}

/** The size of one piece's tile on the atlas: the cell, the margin tabs stick out into, and the gap between tiles. */
export function atlasGeometry(l: JigsawLayout): { pad: number; tile: number; pitch: number } {
  const pad = Math.ceil(l.size * TAB_REACH) + 1;
  const tile = Math.ceil(l.size) + 2 * pad;
  return { pad, tile, pitch: tile + 2 };
}

/**
 * The shapes of the pieces without a picture, for drawing pieces from a picture that changes (a video) on the graphics card: `cover` has each piece's shape in its
 * alpha channel, `overlay` the lines drawn along its edge. Laid out like the atlas.
 */
export interface Masks {
  cover: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  pad: number;
  tile: number;
  pitch: number;
}

export function buildMasks(l: JigsawLayout): Masks {
  const { pad, tile, pitch } = atlasGeometry(l);
  const make = (): CanvasRenderingContext2D => {
    const canvas = document.createElement('canvas');
    canvas.width = l.cols * pitch;
    canvas.height = l.rows * pitch;
    return canvas.getContext('2d')!;
  };
  const cover = make();
  const overlay = make();
  const edge = Math.max(1, l.size * 0.03);
  cover.fillStyle = '#fff';
  cover.strokeStyle = '#fff';
  cover.lineWidth = 1.2;                                            // a hair wider than the cell, so no gap shows between neighbours
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const ox = c * pitch + 1 + pad;
      const oy = r * pitch + 1 + pad;
      tracePiece(cover, l, c, r, ox, oy);
      cover.fill();
      cover.stroke();
      overlay.save();
      tracePiece(overlay, l, c, r, ox, oy);
      overlay.clip();
      overlay.strokeStyle = 'rgba(255,255,255,0.28)';
      overlay.lineWidth = edge * 2;
      tracePiece(overlay, l, c, r, ox, oy);
      overlay.stroke();
      overlay.restore();
      overlay.strokeStyle = 'rgba(0,0,0,0.55)';
      overlay.lineWidth = edge;
      tracePiece(overlay, l, c, r, ox, oy);
      overlay.stroke();
    }
  }
  return { cover: cover.canvas, overlay: overlay.canvas, pad, tile, pitch };
}

/** The four sides of a piece, in the order `traceEdge` takes them. */
export type Side = 0 | 1 | 2 | 3;

/** Walks one side of piece (c, r) (0 top, 1 right, 2 bottom, 3 left, clockwise), with its cell's top-left corner at (ox, oy): the same curve as `tracePiece` makes for it, without closing the path. */
export function traceEdge(ctx: CanvasRenderingContext2D, l: JigsawLayout, c: number, r: number, side: Side, ox: number, oy: number): void {
  const s = l.size;
  const segs =
    side === 0 ? edgeSegments(l.h[r * l.cols + c])
    : side === 1 ? edgeSegments(l.v[r * (l.cols + 1) + c + 1])
    : side === 2 ? reverseSegments(edgeSegments(l.h[(r + 1) * l.cols + c]))
    : reverseSegments(edgeSegments(l.v[r * (l.cols + 1) + c]));
  const map = (u: number, v: number): [number, number] =>
    side === 0 ? [ox + u * s, oy + v * s] : side === 1 ? [ox + s + v * s, oy + u * s] : side === 2 ? [ox + u * s, oy + s + v * s] : [ox + v * s, oy + u * s];
  ctx.moveTo(side === 1 || side === 2 ? ox + s : ox, side === 2 || side === 3 ? oy + s : oy);
  for (const q of segs) {
    const [x1, y1] = map(q[0], q[1]);
    const [x2, y2] = map(q[2], q[3]);
    const [x, y] = map(q[4], q[5]);
    ctx.bezierCurveTo(x1, y1, x2, y2, x, y);
  }
}

/** A group of joined pieces drawn once, as one picture: no seams between its pieces and no outline between them, only round the group. `x`, `y` is its corner in the frame's own coordinates. */
export interface Sprite {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

/** The biggest sprite worth keeping, in pixels: a bigger group is drawn piece by piece. */
const MAX_SPRITE_PX = 24e6;

/**
 * Draws a group's pieces (from the atlas of pieces without outline) and then the outline along the sides that no other piece of the group lies against. `joined(m)` says whether
 * piece m is in the group.
 */
export function buildSprite(atlas: Atlas, l: JigsawLayout, members: readonly number[], joined: (m: number) => boolean): Sprite | null {
  const s = l.size;
  let c0 = Infinity;
  let c1 = -1;
  let r0 = Infinity;
  let r1 = -1;
  for (const m of members) {
    const c = m % l.cols;
    const r = Math.floor(m / l.cols);
    c0 = Math.min(c0, c);
    c1 = Math.max(c1, c);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
  }
  const x = Math.floor(c0 * s - atlas.pad);
  const y = Math.floor(r0 * s - atlas.pad);
  const w = Math.ceil((c1 + 1) * s + atlas.pad) - x;
  const h = Math.ceil((r1 + 1) * s + atlas.pad) - y;
  if (w * h > MAX_SPRITE_PX) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const o = s / 2 + atlas.pad;
  for (const m of members) {
    const c = m % l.cols;
    const r = Math.floor(m / l.cols);
    ctx.drawImage(atlas.plain, c * atlas.pitch + 1, r * atlas.pitch + 1, atlas.tile, atlas.tile, (c + 0.5) * s - o - x, (r + 0.5) * s - o - y, atlas.tile, atlas.tile);
  }
  const edge = Math.max(1, s * 0.03);
  const outer: { c: number; r: number; sides: Side[] }[] = [];
  for (const m of members) {
    const c = m % l.cols;
    const r = Math.floor(m / l.cols);
    const sides: Side[] = [];
    if (r === 0 || !joined(m - l.cols)) sides.push(0);
    if (c === l.cols - 1 || !joined(m + 1)) sides.push(1);
    if (r === l.rows - 1 || !joined(m + l.cols)) sides.push(2);
    if (c === 0 || !joined(m - 1)) sides.push(3);
    if (sides.length) outer.push({ c, r, sides });
  }
  for (const [colour, width, inside] of [['rgba(255,255,255,0.28)', edge * 2, true], ['rgba(0,0,0,0.55)', edge, false]] as const) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    for (const p of outer) {
      const ox = p.c * s - x;
      const oy = p.r * s - y;
      ctx.save();
      if (inside) {                                                 // the light line lies just inside the edge: only the piece's own side of it
        tracePiece(ctx, l, p.c, p.r, ox, oy);
        ctx.clip();
      }
      ctx.beginPath();
      for (const side of p.sides) traceEdge(ctx, l, p.c, p.r, side, ox, oy);
      ctx.stroke();
      ctx.restore();
    }
  }
  return { canvas, x, y };
}
