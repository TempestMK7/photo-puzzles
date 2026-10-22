import type { FocusGame } from './core/focus';
import type { Rect } from './core/layout';

export interface Anim {
  from: Rect;
  to: Rect;
  start: number; // performance.now() when it began
}

export const SWAP_MS = 260;

export interface View {
  scale: number; // canvas pixels per picture pixel
  ox: number;
  oy: number;
}

/** The scale and offset that centre a width x height picture in a canvas of cw x ch pixels. */
export function fitView(width: number, height: number, cw: number, ch: number, margin = 12): View {
  const scale = Math.min((cw - 2 * margin) / width, (ch - 2 * margin) / height);
  return { scale, ox: (cw - width * scale) / 2, oy: (ch - height * scale) / 2 };
}

const ease = (t: number) => t * t * (3 - 2 * t);

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  const k = ease(Math.min(1, Math.max(0, t)));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k };
}

/** Clears the canvas and sets the transform that maps board units to canvas pixels. */
export function beginFrame(ctx: CanvasRenderingContext2D, view: View): void {
  const { canvas } = ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1210';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
}

/** Draws the puzzle. Returns true while an animation is still running (the caller keeps asking for frames). */
export function draw(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  game: FocusGame,
  view: View,
  anims: Map<number, Anim>,
  hover: number,
  now: number,
  grid = true,
): boolean {
  const { canvas } = ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1210';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);

  let running = false;
  const rectOf = (i: number): Rect => {
    const a = anims.get(i);
    if (!a) return game.slotRect(i);
    const t = (now - a.start) / SWAP_MS;
    if (t >= 1) {
      anims.delete(i);
      return game.slotRect(i);
    }
    running = true;
    return lerpRect(a.from, a.to, t);
  };

  // pieces that are moving are drawn last, on top
  const order = [...Array(game.count).keys()].sort((a, b) => Number(anims.has(a)) - Number(anims.has(b)));
  const line = 1 / view.scale;
  for (const i of order) {
    const home = game.homes[i];
    const r = rectOf(i);
    ctx.drawImage(img, home.x, home.y, home.w, home.h, r.x, r.y, r.w, r.h);
    if (!game.solved && grid) {
      ctx.lineWidth = line * 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }
  if (!game.solved) {
    if (hover >= 0 && hover !== game.selected) outline(ctx, rectOf(hover), '#ffffff', line * 3);
    if (game.selected >= 0) outline(ctx, rectOf(game.selected), '#ffd84a', line * 5);
  }
  return running;
}

function outline(ctx: CanvasRenderingContext2D, r: Rect, colour: string, width: number): void {
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.strokeRect(r.x + width / 2, r.y + width / 2, r.w - width, r.h - width);
}
