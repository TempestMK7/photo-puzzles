import { applyBoardOp, boardCheck, type Board, type BoardOp } from '../core/boardRoom';
import { FocusGame, type FocusState } from '../core/focus';
import type { RoomEvent, RoomState } from '../core/jigsawRoom';
import type { Rect } from '../core/layout';
import { beginFrame, draw, rectNow, SWAP_MS, type Anim, type View } from '../render';
import { Ripples } from './ripple';
import { playEffect } from '../sounds';
import { buzz } from './feedback';
import { Camera } from './camera';
import { FrontLayer, rgba, VideoLayer, videoGlAvailable } from './videoGl';
import type { Pt, PuzzleSession, SessionInit } from './types';

/** Tile Swap: click two pieces to trade places and sizes. Played with friends, everybody clicks on the same board: a swap is sent to the room, and the others' swaps arrive in its order. */
export class FocusSession implements PuzzleSession {
  readonly rotatable = false;
  private game: FocusGame;
  private board: Board;
  private anims = new Map<number, Anim>();
  private hover = -1;
  private ripples = new Ripples();
  /** A puzzle made from a video draws its pieces on the graphics card (see videoGl.ts), with the ripples on a canvas over them; both lie over the board's canvas. */
  private layer: VideoLayer | null = null;
  private frontLayer: FrontLayer | null = null;
  private lastView: View = { scale: 1, ox: 0, oy: 0 };
  private canvasW = 1;
  private canvasH = 1;
  private cam: Camera;
  /** Where the press that may turn out to be a click went down (a press that moves the camera is no click). */
  private press: Pt | null = null;
  videoFrame?: (now: number) => void;

  constructor(private readonly init: SessionInit) {
    this.cam = new Camera(init.width, init.height, 2, () => init.requestDraw());
    this.game = new FocusGame(init.width, init.height, { seed: init.seed, pieces: init.opts.pieces, irregular: init.opts.irregular === 1 });
    this.board = { kind: 'focus', game: this.game };
    if (init.restore) this.game.restore(init.restore as FocusState);
    if (init.video && videoGlAvailable()) {
      try {
        this.layer = new VideoLayer(init.video);
        this.frontLayer = new FrontLayer();
        this.videoFrame = (now) => void this.drawGl(now);
      } catch {
        this.layer = null;                                        // no graphics card to draw with: the pieces are cut from copies of the video's pictures
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
    return this.game.snapshot();
  }

  layout(): { width: number; height: number } {
    return { width: this.init.width, height: this.init.height };
  }

  /** The pieces of a video puzzle with their borders and outlines, drawn on the graphics card (a piece that is moving over the others, last); true while one is moving. */
  private drawGl(now: number): boolean {
    const L = this.layer!;
    const g = this.game;
    const view = this.lastView;
    if (!L.begin(this.canvasW, this.canvasH, view)) return false;
    const { width, height } = this.init;
    const line = 1 / view.scale;
    const grid = this.init.flag('grid');
    let running = false;
    const order = [...Array(g.count).keys()].sort((a, b) => Number(this.anims.has(a)) - Number(this.anims.has(b)));
    for (const i of order) {
      const home = g.homes[i];
      const r = rectNow(g, this.anims, i, now);
      if (this.anims.has(i)) running = true;
      L.quad(r.x, r.y, r.w, r.h, home.x / width, home.y / height, (home.x + home.w) / width, (home.y + home.h) / height);
      if (!g.solved && grid) L.frame(r.x, r.y, r.w, r.h, line * 1.5, rgba(255, 255, 255, 0.85));
    }
    if (!g.solved) {
      const outline = (i: number, colour: [number, number, number, number], w: number): void => {
        const r = rectNow(g, this.anims, i, now);
        L.frame(r.x + w / 2, r.y + w / 2, r.w - w, r.h - w, w, colour);
      };
      if (this.hover >= 0 && this.hover !== g.selected) outline(this.hover, rgba(255, 255, 255), line * 3);
      if (g.selected >= 0) outline(g.selected, rgba(255, 216, 74), line * 5);
    }
    L.end();
    return running;
  }

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    if (this.layer && this.frontLayer) {
      beginFrame(ctx, view);                                       // (the background; the pieces are on the layer over it)
      this.lastView = view;
      this.canvasW = ctx.canvas.width;
      this.canvasH = ctx.canvas.height;
      const moving = this.drawGl(now);
      return this.ripples.draw(this.frontLayer.begin(this.canvasW, this.canvasH, view), now) || moving;
    }
    const moving = draw(ctx, this.init.source, this.game, view, this.anims, this.hover, now, this.init.flag('grid'));
    return this.ripples.draw(ctx, now) || moving;
  }

  pointerDown(p: Pt): void {
    this.press = p;
    this.cam.startPan(p);
  }

  /** A click on the board at `p`, once the press has ended without moving the camera. */
  private click(p: Pt): void {
    const game = this.game;
    const piece = game.pieceAt(p.x, p.y);
    if (piece < 0) return;
    const chosen = game.selected;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const wasPlaced = game.slotOf.map((_, i) => game.placed(i));
    const result = game.click(piece);
    if (result === 'swap') {
      buzz(this.init, game.solved ? 'solved' : 'join');
      const found = this.showSwap(before, wasPlaced);
      if (!game.solved) playEffect(found ? 'placed' : 'pickup');                         // (the end of the puzzle has its own sound)
      this.init.online?.send({ t: 'swap', a: chosen, b: piece });
    } else if (result === 'select') {
      buzz(this.init, 'grab');
      playEffect('select');
    }
    else if (result === 'deselect') buzz(this.init, 'drop');
    this.init.requestDraw();
  }

  /** Shows a swap that has just been made: the pieces glide to their places (animations on), and one that has found its place gets a ripple once it arrives. True if one did. */
  private showSwap(before: Rect[], wasPlaced: boolean[]): boolean {
    const game = this.game;
    const now = performance.now();
    let found = false;
    game.homes.forEach((home, i) => {
      if (game.placed(i) && !wasPlaced[i]) {
        this.ripples.add([home], now, this.init.flag('animate') ? SWAP_MS : 0);
        found = true;
      }
    });
    if (this.init.flag('animate')) {
      for (let i = 0; i < game.count; i++) {
        const to: Rect = game.slotRect(i);
        if (to !== before[i]) this.anims.set(i, { from: before[i], to, start: now });
      }
    }
    return found;
  }

  pointerMove(p: Pt): void {
    if (this.cam.panning && this.cam.panTo(p)) {
      this.press = null;
      this.hover = -1;
      return;
    }
    let piece = this.game.pieceAt(p.x, p.y);
    if (piece >= 0 && this.game.placed(piece)) piece = -1;                  // a locked piece is not offered
    if (piece !== this.hover) {
      this.hover = piece;
      this.init.requestDraw();
    }
  }

  pointerUp(): void {
    const moved = this.cam.endPan();
    const p = this.press;
    this.press = null;
    if (p && !moved) this.click(p);
  }

  pointerCancel(): void {
    this.cam.endPan();
    this.press = null;
    this.hover = -1;
  }

  secondary(): void {}

  // ---------------------------------------------------------------------------------------------------------------- camera

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

  /** The right button moves the camera (there is nothing for it to turn). */
  rightDown(p: Pt): void {
    this.cam.startPan(p);
  }

  rightMove(p: Pt): void {
    this.cam.panTo(p);
  }

  rightUp(): void {
    this.cam.endPan();
  }

  status(): string {
    const n = this.game.swaps;
    return `${n} ${n === 1 ? 'swap' : 'swaps'}`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {
    if (!this.init.flag('animate')) this.anims.clear();
    this.init.requestDraw();
  }

  // ---------------------------------------------------------------------------------------------------------------- with friends

  /** Another player's swap (the room checked it and put it in order): shown as a swap of this player's own is. */
  applyEvent(ev: RoomEvent): void {
    const op = ev.op as BoardOp | undefined;
    if (!op) return;
    const game = this.game;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const wasPlaced = game.slotOf.map((_, i) => game.placed(i));
    if (!applyBoardOp(this.board, op).ok) return;
    if (game.selected >= 0 && game.placed(game.selected)) game.selected = -1;          // the piece this player had chosen found its place
    this.showSwap(before, wasPlaced);
    this.init.requestDraw();
    this.init.progress?.();
  }

  /** Takes the room's board in place of this one (the piece this player had chosen stays chosen, if it can still be). */
  resync(state: RoomState): void {
    const game = this.game;
    const chosen = game.selected;
    try {
      game.restore(state.game as FocusState);
    } catch {
      return;
    }
    game.selected = chosen >= 0 && !game.placed(chosen) ? chosen : -1;
    this.anims.clear();
    this.init.requestDraw();
    this.init.progress?.();
  }

  groupCount(): number {
    return boardCheck(this.board);
  }
}
