import { Rng } from './rng';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cuts a width x height picture into `pieces` rectangles that tile it exactly.
 * Regular: a grid as close to the picture's shape as the piece count allows.
 * Irregular: the biggest rectangle is split in two again and again, at a random place near the middle, so pieces differ in size and shape.
 */
export function focusLayout(rng: Rng, width: number, height: number, pieces: number, irregular: boolean): Rect[] {
  pieces = Math.max(1, Math.floor(pieces));
  if (!irregular) return gridLayout(width, height, pieces);
  // (a picture cannot be cut into far more than (12 x 12) rectangles of this size: more pieces than that, as in 200, need smaller ones; up to 60 the cut is what it always was,
  // so that a puzzle made earlier is the same puzzle)
  const base = Math.floor(Math.min(width, height) / 12);
  const minSide = Math.max(8, pieces <= 60 ? base : Math.floor((base * Math.sqrt(60)) / Math.sqrt(pieces)));
  const rects: Rect[] = [{ x: 0, y: 0, w: width, h: height }];
  const stuck: boolean[] = [false];
  while (rects.length < pieces) {
    let pick = -1;
    for (let i = 0; i < rects.length; i++) {
      if (stuck[i]) continue;
      if (pick < 0 || rects[i].w * rects[i].h > rects[pick].w * rects[pick].h) pick = i;
    }
    if (pick < 0) break; // nothing can be split any more
    const r = rects[pick];
    const canV = r.w >= 2 * minSide;
    const canH = r.h >= 2 * minSide;
    if (!canV && !canH) {
      stuck[pick] = true;
      continue;
    }
    let vertical: boolean; // a vertical cut puts the two halves side by side
    if (canV && canH) vertical = r.w * 10 >= r.h * 12 ? true : r.h * 10 >= r.w * 12 ? false : rng.below(2) === 0;
    else vertical = canV;
    const len = vertical ? r.w : r.h;
    const cut = Math.min(len - minSide, Math.max(minSide, Math.round(len * (0.3 + 0.4 * rng.unit()))));
    const a: Rect = { ...r };
    const b: Rect = { ...r };
    if (vertical) {
      a.w = cut;
      b.x = r.x + cut;
      b.w = r.w - cut;
    } else {
      a.h = cut;
      b.y = r.y + cut;
      b.h = r.h - cut;
    }
    rects[pick] = a;
    rects.push(b);
    stuck.push(false);
  }
  return rects;
}

function gridLayout(width: number, height: number, pieces: number): Rect[] {
  let cols = Math.max(1, Math.round(Math.sqrt((pieces * width) / Math.max(1, height))));
  cols = Math.min(cols, pieces);
  const rows = Math.max(1, Math.round(pieces / cols));
  const rects: Rect[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.floor(((c + 1) * width) / cols);
      const y0 = Math.floor((r * height) / rows);
      const y1 = Math.floor(((r + 1) * height) / rows);
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  return rects;
}
