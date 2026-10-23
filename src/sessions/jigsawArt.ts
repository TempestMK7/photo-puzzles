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
