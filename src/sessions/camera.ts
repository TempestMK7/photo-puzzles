import type { View } from '../render';
import type { Pt } from './types';

const MARGIN = 12;             // CSS pixels of room around the board when all of it shows
const TAP = 5;                 // CSS pixels a press may move and still be a tap

/**
 * The camera of a board that is shown whole until the player zooms in (Tile Swap, Sliding Tiles, Rotascope, Strips): the wheel, two fingers or the buttons zoom, and a drag on
 * the bare board (the right button anywhere) moves it. Showing the whole board is the nearest the camera goes, so a player who never zooms sees what they always saw.
 * Points are board units unless a name says canvas pixels.
 */
export class Camera {
  private zoom = 1;
  private cx: number;
  private cy: number;
  private fit = 1;
  private inited = false;
  private canvasW = 1;
  private canvasH = 1;
  private cur: View = { scale: 1, ox: 0, oy: 0 };
  private drag: { anchor: Pt; moved: boolean } | null = null;

  /** `maxPixels`: how many device pixels a board unit may grow to (a unit is a picture pixel in some puzzles and bigger in others). */
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly maxPixels: number,
    private readonly requestDraw: () => void,
  ) {
    this.cx = width / 2;
    this.cy = height / 2;
  }

  private get dpr(): number {
    return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  }

  private maxZoom(): number {
    return Math.max(this.fit * 2, this.maxPixels * this.dpr);
  }

  /** The view for a canvas of this size (canvas pixels). */
  view(cw: number, ch: number): View {
    this.canvasW = cw;
    this.canvasH = ch;
    const m = MARGIN * this.dpr;
    const fit = Math.max(1e-4, Math.min((cw - 2 * m) / this.width, (ch - 2 * m) / this.height));
    if (!this.inited) {
      this.fit = fit;
      this.zoom = fit;
      this.inited = true;
    } else if (fit !== this.fit) {                                   // the canvas changed shape: as far in as before, relative to showing everything
      this.zoom *= fit / this.fit;
      this.fit = fit;
    }
    this.zoom = Math.min(this.maxZoom(), Math.max(this.fit, this.zoom));
    this.clampCentre();
    this.cur = { scale: this.zoom, ox: cw / 2 - this.cx * this.zoom, oy: ch / 2 - this.cy * this.zoom };
    return this.cur;
  }

  /** Keeps the board in view: the camera may go as far as a margin past the board's edge, and a board that is smaller than the view in one direction stays in the middle of it. */
  private clampCentre(): void {
    const z = this.zoom;
    const m = (MARGIN * this.dpr) / z;
    const fit = (c: number, size: number, shown: number): number => {
      const half = shown / (2 * z);
      const lo = half - m;
      const hi = size - half + m;
      return lo > hi ? size / 2 : Math.min(hi, Math.max(lo, c));
    };
    this.cx = fit(this.cx, this.width, this.canvasW);
    this.cy = fit(this.cy, this.height, this.canvasH);
  }

  /** Where a board point is on the canvas (canvas pixels), and the other way round, in the view of the last `view()`. */
  screen(p: Pt): Pt {
    return { x: p.x * this.cur.scale + this.cur.ox, y: p.y * this.cur.scale + this.cur.oy };
  }

  world(s: Pt): Pt {
    return { x: (s.x - this.cur.ox) / this.cur.scale, y: (s.y - this.cur.oy) / this.cur.scale };
  }

  /** True when the board is zoomed in: there is somewhere to move the camera to. */
  get canPan(): boolean {
    return this.zoom > this.fit * 1.001;
  }

  /** What to multiply a line width that was drawn for the whole board in view by: 1 then, less the further in the camera is, so that the line stays as many pixels wide. */
  lineK(): number {
    return this.fit / this.zoom;
  }

  /** Zoom by a factor, keeping the board point `at` where it is on the screen. */
  zoomAt(at: Pt, factor: number): void {
    const z = Math.min(this.maxZoom(), Math.max(this.fit, this.zoom * factor));
    const k = this.zoom / z;
    this.cx = at.x + (this.cx - at.x) * k;
    this.cy = at.y + (this.cy - at.y) * k;
    this.zoom = z;
    this.clampCentre();
    this.requestDraw();
  }

  wheel(at: Pt, deltaY: number): void {
    this.zoomAt(at, Math.exp(-deltaY * 0.0015));
  }

  /** Two fingers moved: what was under `from` (canvas pixels) now lies under `to`, and the board is `factor` times bigger. */
  pinch(from: Pt, to: Pt, factor: number): void {
    const mx = this.canvasW / 2;
    const my = this.canvasH / 2;
    const z = Math.min(this.maxZoom(), Math.max(this.fit, this.zoom * factor));
    const wx = this.cx + (from.x - mx) / this.zoom;
    const wy = this.cy + (from.y - my) / this.zoom;
    this.zoom = z;
    this.cx = wx + (mx - to.x) / z;
    this.cy = wy + (my - to.y) / z;
    this.clampCentre();
    this.requestDraw();
  }

  zoomBy(factor: number): void {
    this.zoomAt({ x: this.cx, y: this.cy }, factor);
  }

  zoomFit(): void {
    this.zoom = this.fit;
    this.cx = this.width / 2;
    this.cy = this.height / 2;
    this.requestDraw();
  }

  zoomLabel(): string {
    return `${Math.round((this.zoom / this.fit) * 100)}%`;
  }

  /** Moves the camera by canvas pixels (the board goes the other way). */
  panBy(dx: number, dy: number): void {
    this.cx += dx / this.zoom;
    this.cy += dy / this.zoom;
    this.clampCentre();
    this.requestDraw();
  }

  /** A press at board point `p` that may turn into a move of the camera (only when there is somewhere to move it to). */
  startPan(p: Pt): void {
    this.drag = this.canPan ? { anchor: p, moved: false } : null;
  }

  get panning(): boolean {
    return !!this.drag;
  }

  /** The pointer is now at board point `p`: once it has gone further than a tap, the board point that was pressed stays under it. True while the camera is being moved. */
  panTo(p: Pt): boolean {
    const d = this.drag;
    if (!d) return false;
    if (!d.moved && Math.hypot(p.x - d.anchor.x, p.y - d.anchor.y) * this.zoom < TAP * this.dpr) return false;
    d.moved = true;
    this.cx += d.anchor.x - p.x;
    this.cy += d.anchor.y - p.y;
    this.clampCentre();
    this.requestDraw();
    return true;
  }

  /** The press is over (or cancelled). True if it moved the camera, which makes it no tap. */
  endPan(): boolean {
    const moved = !!this.drag?.moved;
    this.drag = null;
    return moved;
  }
}
