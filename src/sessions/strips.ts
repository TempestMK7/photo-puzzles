import type { HelpKind } from '../core/help';
import { applyBoardOp, boardCheck, type Board, type BoardOp } from '../core/boardRoom';
import type { RoomEvent, RoomState } from '../core/jigsawRoom';
import { boxOf, makeStrips, MARGIN, type StripsGame, type StripsState } from '../core/strips';
import { beginFrame, drawSlice, type View } from '../render';
import { playEffect } from '../sounds';
import { buzz, startLift, type Lift } from './feedback';
import { Camera } from './camera';
import { Ripples } from './ripple';
import { FrontLayer, rgba, VideoLayer, videoGlAvailable } from './videoGl';
import type { Pt, PuzzleSession, SessionInit } from './types';

const S = 30;                  // one cell, in board units
const DWELL_MS = 600;          // a dragged strip that rests on a tab goes to it
const TAP = 5;                 // CSS pixels
const EDGE = 40;               // CSS pixels: a strip held this close to the edge of the canvas takes the camera with it...
const EDGE_SPEED = 600;        // ...at up to this many CSS pixels a second
const UNIT: View = { scale: 1, ox: 0, oy: 0 };     // the strip in hand is held in canvas pixels, which this view leaves as they are
const dpr = (): number => window.devicePixelRatio || 1;

/** The strip in hand: the cell it was grabbed by, where the pointer is (canvas pixels, so that the strip stays under the pointer when the camera moves), whether it has moved (else a tap), and - for a finger - the lift that holds it above the finger. */
interface Drag {
  id: number;
  gx: number;
  gy: number;
  start: Pt;
  moved: boolean;
  at: Pt;
  touch: boolean;
  lift: Lift | null;
}

/**
 * Strips: straight strips have been cut out of the picture and lie turned and scattered over the board. Drag each one back to the hole it came from; a tap (or the
 * right button, a second finger, R) turns it a quarter turn. It locks when it lies exactly in its hole, turned the right way.
 *
 * The board has a camera (zoom with the wheel, two fingers or the buttons; drag the bare board, or use the right button, to move it); a strip held near the edge of the canvas takes the camera along.
 *
 * With friends everybody plays on the same board: a strip that is put down (or turned) is sent to the room as the pose it now has, and what the others put down arrives in the room's order
 * (see core/boardRoom.ts). A strip in hand is on its player's screen only.
 */
export class StripsSession implements PuzzleSession {
  readonly rotatable = true;
  private game: StripsGame;
  private rules: Board;
  private picCols: number;
  private picRows: number;
  private crop: { sx: number; sy: number; sw: number; sh: number };
  /** For each picture cell, the strips cut from it. */
  private owners: number[][];
  private selected = -1;
  private drag: Drag | null = null;
  private lastView: View = { scale: 1, ox: 0, oy: 0 };
  private ripples = new Ripples();
  private tab = 0;
  private overTab = -1;
  private dwell = 0;
  /** A puzzle made from a video draws its picture and strips on the graphics card (see videoGl.ts), with the ripples on a canvas over them; both lie over the board's canvas. */
  private layer: VideoLayer | null = null;
  private frontLayer: FrontLayer | null = null;
  private canvasW = 1;
  private canvasH = 1;
  private cam: Camera;
  private rightClick = false;
  private tick = 0;
  videoFrame?: (now: number) => void;

  constructor(private readonly init: SessionInit) {
    const made = makeStrips(init.seed, init.width, init.height, init.opts);
    this.picCols = made.picCols;
    this.picRows = made.picRows;
    this.game = made.game;
    this.rules = { kind: 'strips', game: made.game, picCols: made.picCols, picRows: made.picRows };
    this.cam = new Camera(made.game.cols * S, made.game.rows * S, 4, () => init.requestDraw());
    let sw = init.width;
    let sh = init.height;
    if (sw * this.picRows > sh * this.picCols) sw = (sh * this.picCols) / this.picRows;
    else sh = (sw * this.picRows) / this.picCols;
    this.crop = { sx: (init.width - sw) / 2, sy: (init.height - sh) / 2, sw, sh };
    if (init.restore) {
      const saved = init.restore as { game: StripsState; tab: number };
      this.game.restore(saved.game);
      this.tab = Number.isInteger(saved.tab) && saved.tab >= 0 && saved.tab < this.game.tabs ? saved.tab : 0;
    }
    if (!init.restore || this.game.looseCounts()[this.tab] === 0) this.tab = Math.max(0, this.game.looseCounts().findIndex((n) => n > 0));
    this.owners = Array.from({ length: this.picCols * this.picRows }, () => []);
    for (const d of this.game.defs) {
      const b = boxOf(d, 0);
      for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) this.owners[(d.hy - MARGIN + dy) * this.picCols + d.hx - MARGIN + dx].push(d.id);
    }
    if (init.video && videoGlAvailable()) {
      try {
        this.layer = new VideoLayer(init.video);
        this.frontLayer = new FrontLayer();
        this.videoFrame = () => this.drawGl();
      } catch {
        this.layer = null;                                        // no graphics card to draw with: the strips are cut from copies of the video's pictures
        this.frontLayer = null;
      }
    }
  }

  get overlay(): HTMLCanvasElement | undefined {
    return this.layer?.canvas;
  }

  get front(): HTMLCanvasElement | undefined {
    return this.frontLayer?.canvas;
  }

  dispose(): void {
    this.layer?.dispose();
  }

  serialize(): unknown {
    return { game: this.game.snapshot(), tab: this.tab };
  }

  layout(): { width: number; height: number } {
    return { width: this.game.cols * S, height: this.game.rows * S };
  }

  private cellImage(ctx: CanvasRenderingContext2D, pc: number, pr: number, dx: number, dy: number): void {
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.picCols;
    const h = sh / this.picRows;
    drawSlice(ctx, this.init.source, sx + pc * w, sy + pr * h, w, h, dx, dy, S, S);
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    this.lastView = view;
    this.canvasW = ctx.canvas.width;
    this.canvasH = ctx.canvas.height;
    const g = this.game;
    const k = this.cam.lineK();
    let running = false;
    const dt = Math.min(0.05, Math.max(0, (now - this.tick) / 1000));
    this.tick = now;
    if (this.drag?.lift && !this.drag.lift.done(now)) {            // a strip that a finger has picked up rises above it
      running = true;
      this.placeDrag(this.drag, now);
    }
    if (this.drag?.moved && this.edgePan(this.drag, dt, now)) running = true;
    const { width, height } = this.layout();
    ctx.fillStyle = '#100a08';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#6b4a36';
    ctx.lineWidth = 3 * k;
    ctx.strokeRect(-1.5 * k, -1.5 * k, width + 3 * k, height + 3 * k);
    const gpu = !!this.layer && !!this.frontLayer;
    // the picture: its cells show unless a strip that was cut from them is still loose
    for (let r = 0; r < this.picRows; r++) {
      for (let c = 0; c < this.picCols; c++) {
        const i = r * this.picCols + c;
        const owners = this.owners[i];
        const x = (MARGIN + c) * S;
        const y = (MARGIN + r) * S;
        if (g.solved || owners.length === 0 || owners.some((id) => g.state[id].locked)) {
          if (!gpu) this.cellImage(ctx, c, r, x, y);               // (on the graphics card they are drawn by drawGl)
        } else {
          ctx.fillStyle = '#1d120d';
          ctx.fillRect(x, y, S, S);
        }
      }
    }
    if (gpu) {
      this.drawGl();
      return this.ripples.draw(this.frontLayer!.begin(this.canvasW, this.canvasH, view), now) || running;
    }
    if (this.init.flag('grid')) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = k;
      ctx.beginPath();
      for (let c = 0; c <= g.cols; c++) {
        ctx.moveTo(c * S + 0.5 * k, 0);
        ctx.lineTo(c * S + 0.5 * k, height);
      }
      for (let r = 0; r <= g.rows; r++) {
        ctx.moveTo(0, r * S + 0.5 * k);
        ctx.lineTo(width, r * S + 0.5 * k);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,216,74,0.35)';
      ctx.strokeRect(MARGIN * S + 0.5 * k, MARGIN * S + 0.5 * k, this.picCols * S, this.picRows * S);
    }
    if (!g.solved) {
      for (const id of g.z) {
        const s = g.state[id];
        if (!s.locked && s.tab === this.tab) this.drawStrip(ctx, id, id === this.selected, k);
      }
    }
    if (this.ripples.draw(ctx, now)) running = true;
    return running;
  }

  /** The picture's cells that show, the grid and the loose strips, drawn on the graphics card over what the board's canvas has drawn. */
  private drawGl(): void {
    const L = this.layer!;
    const g = this.game;
    if (!L.begin(this.canvasW, this.canvasH, this.lastView)) return;
    const k = this.cam.lineK();
    const { width, height } = this.layout();
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.picCols;
    const h = sh / this.picRows;
    const iw = this.init.width;
    const ih = this.init.height;
    for (let r = 0; r < this.picRows; r++) {
      for (let c = 0; c < this.picCols; c++) {
        const owners = this.owners[r * this.picCols + c];
        if (g.solved || owners.length === 0 || owners.some((id) => g.state[id].locked)) L.quad((MARGIN + c) * S, (MARGIN + r) * S, S, S, (sx + c * w) / iw, (sy + r * h) / ih, (sx + (c + 1) * w) / iw, (sy + (r + 1) * h) / ih);
      }
    }
    if (this.init.flag('grid')) {
      const faint = rgba(255, 255, 255, 0.14);
      for (let c = 0; c <= g.cols; c++) L.fill(c * S, 0, k, height, faint);
      for (let r = 0; r <= g.rows; r++) L.fill(0, r * S, width, k, faint);
      L.frame(MARGIN * S + 0.5 * k, MARGIN * S + 0.5 * k, this.picCols * S, this.picRows * S, k, rgba(255, 216, 74, 0.35));
    }
    if (!g.solved) {
      for (const id of g.z) {
        const s = g.state[id];
        if (!s.locked && s.tab === this.tab) this.drawStripGl(L, id, id === this.selected, k);
      }
    }
    L.end();
  }

  /** One strip on the graphics card: its cells turned the way it lies, and the same two outlines as drawStrip (a strip turned by quarter turns fills the box of cells it stands on). */
  private drawStripGl(L: VideoLayer, id: number, selected: boolean, k: number): void {
    const d = this.game.defs[id];
    const s = this.game.state[id];
    const b = boxOf(d, s.angle);
    const hw = d.horizontal ? d.len : 1;
    const hh = d.horizontal ? 1 : d.len;
    const cx = (s.x + b.w / 2) * S;
    const cy = (s.y + b.h / 2) * S;
    const cos = [1, 0, -1, 0][s.angle % 4];
    const sin = [0, 1, 0, -1][s.angle % 4];
    const { sx, sy, sw, sh } = this.crop;
    const w = sw / this.picCols;
    const h = sh / this.picRows;
    for (let k = 0; k < d.len; k++) {
      const pc = d.hx - MARGIN + (d.horizontal ? k : 0);
      const pr = d.hy - MARGIN + (d.horizontal ? 0 : k);
      const lx = -(hw * S) / 2 + (d.horizontal ? k : 0) * S + S / 2;
      const ly = -(hh * S) / 2 + (d.horizontal ? 0 : k) * S + S / 2;
      L.turned(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos, S / 2, s.angle, (sx + pc * w) / this.init.width, (sy + pr * h) / this.init.height, (sx + (pc + 1) * w) / this.init.width, (sy + (pr + 1) * h) / this.init.height);
    }
    const x = s.x * S;
    const y = s.y * S;
    L.frame(x, y, b.w * S, b.h * S, 1.5 * k, rgba(0, 0, 0, 0.55));
    L.frame(x + 0.5 * k, y + 0.5 * k, b.w * S - k, b.h * S - k, (selected ? 1.5 : 0.75) * k, selected ? rgba(255, 216, 74) : rgba(255, 255, 255, 0.85));
  }

  private drawStrip(ctx: CanvasRenderingContext2D, id: number, selected: boolean, k: number): void {
    const d = this.game.defs[id];
    const s = this.game.state[id];
    const b = boxOf(d, s.angle);
    const hw = d.horizontal ? d.len : 1;
    const hh = d.horizontal ? 1 : d.len;
    ctx.save();
    ctx.translate((s.x + b.w / 2) * S, (s.y + b.h / 2) * S);
    ctx.rotate((s.angle * Math.PI) / 2);
    for (let k = 0; k < d.len; k++) {
      const pc = d.hx - MARGIN + (d.horizontal ? k : 0);
      const pr = d.hy - MARGIN + (d.horizontal ? 0 : k);
      this.cellImage(ctx, pc, pr, -(hw * S) / 2 + (d.horizontal ? k : 0) * S, -(hh * S) / 2 + (d.horizontal ? 0 : k) * S);
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.5 * k;
    ctx.strokeRect(-(hw * S) / 2, -(hh * S) / 2, hw * S, hh * S);
    ctx.strokeStyle = selected ? '#ffd84a' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = (selected ? 1.5 : 0.75) * k;
    ctx.strokeRect(-(hw * S) / 2 + 0.5 * k, -(hh * S) / 2 + 0.5 * k, hw * S - k, hh * S - k);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  pointerDown(p: Pt, touch = false): void {
    const g = this.game;
    if (g.solved) return;
    const cx = Math.floor(p.x / S);
    const cy = Math.floor(p.y / S);
    const id = g.stripAt(cx, cy, this.tab);
    if (id < 0) {
      this.selected = -1;
      this.cam.startPan(p);                                          // a drag on the bare board moves the camera
    } else {
      g.bringToFront(id);
      this.selected = id;
      const at = this.cam.screen(p);
      this.drag = { id, gx: cx - g.state[id].x, gy: cy - g.state[id].y, start: at, moved: false, at, touch, lift: null };
      buzz(this.init, 'grab');
      playEffect('pickup');
    }
    this.init.requestDraw();
  }

  pointerMove(p: Pt): void {
    if (this.cam.panning) {
      this.cam.panTo(p);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const s = this.cam.screen(p);
    d.at = s;
    if (!d.moved && Math.hypot(s.x - d.start.x, s.y - d.start.y) > TAP * dpr()) {
      d.moved = true;
      d.lift = startLift(this.init, d.touch, UNIT, performance.now());                // a finger lifts the strip above itself from here on (a tap does not)
    }
    if (d.moved) this.placeDrag(d, performance.now());
    this.init.requestDraw();
  }

  /** Puts the dragged strip where the pointer holds it - or, for a finger, a little above it - and drops it if that is its own hole, turned right. */
  private placeDrag(d: Drag, now: number): void {
    const p = this.cam.world(d.lift ? d.lift.held(d.at, now) : d.at);
    this.game.moveTo(d.id, Math.floor(p.x / S) - d.gx, Math.floor(p.y / S) - d.gy);
    if (this.game.lockIfHome(d.id)) {                              // over its own hole, turned right: it drops by itself, the button need not be released
      this.locked(d.id);
      this.commit(d.id);
      this.drag = null;
      window.clearTimeout(this.dwell);
      this.overTab = -1;
      this.init.progress?.();                                      // (this may have happened while drawing, not on a pointer event)
    }
  }

  /** A strip held near the edge of the canvas takes the camera towards that edge (not while it is over a tab's button). True while it does. */
  private edgePan(d: Drag, dt: number, now: number): boolean {
    if (!this.cam.canPan || this.overTab >= 0) return false;
    const zone = EDGE * dpr();
    const push = (v: number, size: number): number => (v < zone ? -(1 - v / zone) : v > size - zone ? 1 - (size - v) / zone : 0);
    const vx = push(d.at.x, this.canvasW);
    const vy = push(d.at.y, this.canvasH);
    if (!vx && !vy) return false;
    const step = EDGE_SPEED * dpr() * dt;
    this.cam.panBy(vx * step, vy * step);
    this.placeDrag(d, now);
    return true;
  }

  pointerUp(): void {
    this.cam.endPan();
    const d = this.drag;
    this.drag = null;
    window.clearTimeout(this.dwell);
    if (!d) return;
    if (d.moved && this.overTab >= 0 && this.overTab !== this.tab) {                  // let go over another tab: the strip goes there
      this.game.moveToTab(d.id, this.overTab);
      this.tab = this.overTab;
      buzz(this.init, 'drop');
    } else if (!d.moved) this.turn(d.id, true);                        // a tap turns the strip
    else if (this.game.lockIfHome(d.id)) this.locked(d.id);
    else buzz(this.init, 'drop');
    if (d.moved) this.commit(d.id);                                    // (a tap has sent what it did)
    this.overTab = -1;
    this.init.requestDraw();
  }

  pointerCancel(): void {
    this.cam.endPan();
    this.rightClick = false;
    window.clearTimeout(this.dwell);
    this.overTab = -1;
    if (this.drag?.moved) this.commit(this.drag.id);                 // (where it was put stays: the room has to know)
    this.drag = null;
    this.init.requestDraw();
  }

  /** A second finger turns the strip in hand (and pinches when there is none). */
  holding(): boolean {
    return !!this.drag?.moved;
  }

  /** The right button: a drag on the board moves the camera, a click turns a strip. */
  rightDown(p: Pt): void {
    this.rightClick = true;
    this.cam.startPan(p);
  }

  rightMove(p: Pt): void {
    this.cam.panTo(p);
  }

  rightUp(): void {
    const moved = this.cam.endPan();
    if (this.rightClick && !moved) this.secondary();
    this.rightClick = false;
  }

  view(cw: number, ch: number): View {
    return this.cam.view(cw, ch);
  }

  wheel(at: Pt, deltaY: number): void {
    this.cam.wheel(at, deltaY);
  }

  pinch(from: Pt, to: Pt, factor: number): void {
    this.cam.pinch(from, to, factor);
  }

  zoomBy(factor: number): void {
    this.cam.zoomBy(factor);
  }

  zoomFit(): void {
    this.cam.zoomFit();
  }

  zoomLabel(): string {
    return this.cam.zoomLabel();
  }

  secondary(): void {
    const id = this.drag ? this.drag.id : this.selected;
    if (id >= 0 && !this.game.solved) this.turn(id);
    this.init.requestDraw();
  }

  /** Turns a strip a quarter. A tap has buzzed when it pressed, so it only buzzes again if the strip locks; the other ways of turning (right button, R, a second finger) buzz. */
  private turn(id: number, tap = false): void {
    const inHand = this.drag?.id === id;
    if (this.game.rotate(id)) {
      this.locked(id);
      this.commit(id);
      if (inHand) this.dragEnds();                                   // it is in its hole: nothing is in hand any more
    } else {
      if (!tap) buzz(this.init, 'turn');
      if (!inHand) this.commit(id);                                  // (a strip in hand is sent when it is put down)
    }
  }

  /** Tells the room where the strip lies now (and on which tab, turned how). */
  private commit(id: number): void {
    const s = this.game.state[id];
    this.init.online?.send({ t: 'place', strip: id, x: s.x, y: s.y, angle: s.angle, tab: s.tab });
  }

  /** A strip has found its hole: the ripple, and (for this player's own strip, not one that somebody else put there) the buzz and the sound. */
  private locked(id: number, mine = true): void {
    const d = this.game.defs[id];
    const b = boxOf(d, 0);
    this.ripples.add([{ x: d.hx * S, y: d.hy * S, w: b.w * S, h: b.h * S }], performance.now());
    if (this.selected === id) this.selected = -1;
    this.game.moves++;
    if (mine) {
      buzz(this.init, this.game.solved ? 'solved' : 'placed');
      if (!this.game.solved) playEffect('placed');                    // (the end of the puzzle has its own sound)
    }
    this.nextTab();
  }

  /** Applies a hint or a bomb to the board: the strips it put home get their ripple (and a strip that was in hand is not any more). */
  private run(op: BoardOp): boolean {
    const g = this.game;
    const was = g.state.map((s) => s.locked);
    if (!applyBoardOp(this.rules, op).ok) return false;
    g.state.forEach((s, id) => {
      if (!s.locked || was[id]) return;
      this.locked(id, false);
      if (this.drag?.id === id) this.dragEnds();
    });
    this.afterOthers();
    return true;
  }

  canHelp(kind: HelpKind, p: Pt): boolean {
    const g = this.game;
    const cx = Math.floor(p.x / S);
    const cy = Math.floor(p.y / S);
    if (g.solved) return false;
    if (kind === 'hint') return g.stripAt(cx, cy, this.tab) >= 0;
    return cx >= 0 && cy >= 0 && cx < g.cols && cy < g.rows && g.bombHits(cx, cy).length > 0;
  }

  help(kind: HelpKind, p: Pt): void {
    if (!this.canHelp(kind, p)) return;
    const cx = Math.floor(p.x / S);
    const cy = Math.floor(p.y / S);
    const op: BoardOp = kind === 'hint' ? { t: 'hint', piece: this.game.stripAt(cx, cy, this.tab) } : { t: 'bomb', x: cx, y: cy };
    if (!this.run(op)) return;
    this.init.online?.send(op);
    buzz(this.init, this.game.solved ? 'solved' : 'placed');
    if (!this.game.solved) playEffect('placed');
  }

  /** The tab that is showing has no loose strips left: on to the next one that still has. */
  private nextTab(): void {
    const counts = this.game.looseCounts();
    if (counts[this.tab] === 0 && !this.game.solved) {
      for (let k = 1; k <= counts.length; k++) {
        const t = (this.tab + k) % counts.length;
        if (counts[t] > 0) {
          this.tab = t;
          break;
        }
      }
    }
  }

  tabInfo(): { counts: number[]; active: number } | null {
    return this.game.tabs > 1 ? { counts: this.game.looseCounts(), active: this.tab } : null;
  }

  selectTab(tab: number): void {
    if (this.drag || tab < 0 || tab >= this.game.tabs || tab === this.tab) return;
    this.tab = tab;
    this.selected = -1;
    this.init.requestDraw();
  }

  /** A strip being dragged that rests on another tab's button for a moment goes to that tab, and the drag goes on there. */
  dragOverTab(tab: number): void {
    if (!this.drag || !this.drag.moved || tab === this.overTab) return;
    this.overTab = tab;
    window.clearTimeout(this.dwell);
    if (tab < 0 || tab === this.tab) return;
    this.dwell = window.setTimeout(() => {
      if (!this.drag || this.overTab !== tab) return;
      this.game.moveToTab(this.drag.id, tab);
      this.tab = tab;
      this.overTab = -1;
      this.init.requestDraw();
      this.init.tabsChanged?.();
    }, DWELL_MS);
  }

  status(): string {
    return `${this.game.lockedCount} / ${this.game.total} placed`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {
    this.init.requestDraw();
  }

  // ---------------------------------------------------------------------------------------------------------------- with friends

  /** Another player's operation (the room checked it and put it in order): a strip put down, which may have found its hole. */
  applyEvent(ev: RoomEvent): void {
    const op = ev.op as BoardOp | undefined;
    if (op?.t === 'hint' || op?.t === 'bomb') {
      this.run(op);
      return;
    }
    if (!op || op.t !== 'place') return;
    const res = applyBoardOp(this.rules, op);
    if (!res.ok) return;
    if (res.placed) {
      this.locked(op.strip, false);
      if (this.drag?.id === op.strip) this.dragEnds();             // this player was dragging it: it is in its hole now
    }
    this.afterOthers();
  }

  /** Takes the room's board in place of this one. */
  resync(state: RoomState): void {
    try {
      this.game.restore(state.game as StripsState);
    } catch {
      return;                                                     // (the room's board is this puzzle's: this does not happen)
    }
    if (this.drag && this.game.state[this.drag.id].locked) this.dragEnds();
    this.nextTab();
    this.afterOthers();
  }

  private dragEnds(): void {
    window.clearTimeout(this.dwell);
    this.overTab = -1;
    this.drag = null;
  }

  /** What is selected has to be a loose strip of the tab that shows. */
  private afterOthers(): void {
    const s = this.selected >= 0 ? this.game.state[this.selected] : null;
    if (s && (s.locked || s.tab !== this.tab)) this.selected = -1;
    this.init.requestDraw();
    this.init.tabsChanged?.();
    this.init.progress?.();
  }

  groupCount(): number {
    return boardCheck(this.rules);
  }
}
