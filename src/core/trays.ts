import { rotVec, type Group } from './jigsaw';

/**
 * Sorting trays. A tray is a space of its own, measured in the same picture pixels as the table, with its top-left corner at (0, 0) and a fixed size that depends only on the puzzle
 * (`traySize`): so a piece that one player puts at a place in a tray lies at the same place of the tray for every other player, whatever their screens are like. The size of the
 * tray *on a screen* is another matter: the screen gives a quarter of itself (half the width and half the height) when it is wider than it is tall, and half of itself (all the
 * width, half the height) when it is taller, and the tray's space is fitted into that, as large as it goes, with bars at the sides (or above and below) where it does not fill it.
 * Nothing but the picture of the tray changes with the screen; what is stored never does.
 */

/** The tray's width over its height: the same for every puzzle and every screen. */
export const TRAY_ASPECT = 3 / 2;

/** How many pieces fit side by side along a tray's width: enough that a tray holds a good part of a puzzle, however big or small it is. */
export function trayCells(cols: number): number {
  return Math.max(8, Math.ceil(cols * 0.6));
}

/** The size of every tray of a puzzle, in picture pixels. */
export function traySize(cols: number, size: number): { w: number; h: number } {
  const w = trayCells(cols) * size;
  return { w, h: w / TRAY_ASPECT };
}

/** A rectangle in canvas pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where an open tray lies on a canvas. */
export interface TrayView {
  /** The whole panel (the header and the tray): what a piece has to be over to be put in the tray. */
  panel: Box;
  /** The header strip at the top of the panel (its title, and its buttons, which are drawn by the page). */
  header: Box;
  /** The tray's space fitted into what is left: pixel = origin + scale * (a point of the tray's space). */
  scale: number;
  ox: number;
  oy: number;
  /** The tray's whole space, on the canvas: where it ends there are bars. */
  area: Box;
}

/**
 * The tray on a canvas of this size. `bar` is the width taken by the bar of trays at the left, `header` the height of the panel's header, `pad` the margin inside the panel (all
 * in canvas pixels), and (tw, th) the tray's size (see `traySize`).
 */
export function trayView(canvasW: number, canvasH: number, tw: number, th: number, bar: number, header: number, pad: number): TrayView {
  const free = Math.max(1, canvasW - bar);
  const w = canvasW >= canvasH ? free / 2 : free;
  const h = canvasH / 2;
  const panel: Box = { x: bar, y: canvasH - h, w, h };
  const head: Box = { x: panel.x, y: panel.y, w: panel.w, h: Math.min(header, h / 2) };
  const room: Box = { x: panel.x + pad, y: panel.y + head.h + pad, w: Math.max(1, panel.w - 2 * pad), h: Math.max(1, panel.h - head.h - 2 * pad) };
  const scale = Math.min(room.w / tw, room.h / th);
  const area: Box = { x: room.x + (room.w - tw * scale) / 2, y: room.y + (room.h - th * scale) / 2, w: tw * scale, h: th * scale };
  return { panel, header: head, scale, ox: area.x, oy: area.y, area };
}

export const insideBox = (b: Box, x: number, y: number): boolean => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;

/** The middle of a group at a pose, in the space the pose is in (the table's, or a tray's). */
export function centreAt(g: Pick<Group, 'members'>, cols: number, size: number, dx: number, dy: number, rot: number): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const m of g.members) {
    sx += ((m % cols) + 0.5) * size;
    sy += (Math.floor(m / cols) + 0.5) * size;
  }
  const [rx, ry] = rotVec(rot, sx / g.members.length, sy / g.members.length);
  return [dx + rx, dy + ry];
}

/** The pose that puts the group's middle where it is wanted, or as near as the tray lets it be (the middle stays inside the tray). */
export function clampInTray(g: Pick<Group, 'members'>, cols: number, size: number, dx: number, dy: number, rot: number, tw: number, th: number): { dx: number; dy: number } {
  const [cx, cy] = centreAt(g, cols, size, dx, dy, rot);
  return { dx: dx + Math.min(tw, Math.max(0, cx)) - cx, dy: dy + Math.min(th, Math.max(0, cy)) - cy };
}
