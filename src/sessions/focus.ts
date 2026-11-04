import { applyBoardOp, boardCheck, type Board, type BoardOp } from '../core/boardRoom';
import { FocusGame, type FocusState } from '../core/focus';
import type { HelpKind } from '../core/help';
import type { RoomEvent, RoomState } from '../core/jigsawRoom';
import type { Rect } from '../core/layout';
import { beginFrame, draw, rectNow, SWAP_MS, type Anim, type View } from '../render';
import { Ripples } from './ripple';
import { playEffect } from '../sounds';
import { bombCut, buzz, Cascade, CASCADE_MS, dropBomb, nearestFirst, othersBell, rippleColor } from './feedback';
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
  private ripples = new Ripples(() => this.init.flag('animate'));
  /** The pieces of a bomb, put in their homes one after the other once it has landed. */
  private cascade = new Cascade(bombCut(this.ripples.bombs));
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
    this.cascade.cancel();
    this.layer?.dispose();
  }

  serialize(): unknown {
    this.cascade.flush();                                            // (what a bomb has still to place is placed before the board is kept)
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
    this.cascade.flush();
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
      this.showSwap(before, wasPlaced, { sound: true });
      this.init.online?.send({ t: 'swap', a: chosen, b: piece });
    } else if (result === 'select') {
      buzz(this.init, 'grab');
      playEffect('select');
    }
    else if (result === 'deselect') buzz(this.init, 'drop');
    this.init.requestDraw();
  }

  /**
   * Shows a swap (or a hint) that has just been made: the pieces glide to their places (animations on), and one that has found its place gets a ripple, in the colour of the player `by`
   * who put it there, once it arrives; when both do, the two ripples are 0.2 s apart. The swap makes its sound as it begins and the bell rings as each ripple does (`sound`: only for this
   * player's own moves). `late`: it is being shown after the fact (see `Cascade`): the pieces are just where they belong, with no light and no sound.
   */
  private showSwap(before: Rect[], wasPlaced: boolean[], opts: { by?: string; sound?: boolean; late?: boolean } = {}): void {
    if (opts.late) return;
    const game = this.game;
    const now = performance.now();
    const glide = this.init.flag('animate') ? SWAP_MS : 0;
    const fresh = game.homes.flatMap((_, i) => (game.placed(i) && !wasPlaced[i] ? [i] : []));
    const color = rippleColor(this.init, opts.by);
    fresh.forEach((piece, k) => this.ripples.add([game.homes[piece]], now, k * CASCADE_MS + glide, color));
    if (glide) {
      for (let i = 0; i < game.count; i++) {
        const to: Rect = game.slotRect(i);
        if (to !== before[i]) this.anims.set(i, { from: before[i], to, start: now });
      }
    }
    if (!opts.sound) {
      if (opts.by !== undefined) fresh.forEach((_, k) => othersBell(k * CASCADE_MS + glide));         // (another player's: the bell at half the volume, and nothing else)
      return;
    }                                                                                            // (the last piece rings the bell too, before the end of the puzzle begins)
    playEffect('pickup');
    fresh.forEach((_, k) => playEffect('placed', k * CASCADE_MS + glide));
  }

  /**
   * Applies a hint or a bomb to the board, shown as a swap is. A bomb falls and explodes where it lands, and the pieces it places then glide home one after the other, the nearest first.
   * `by` is the player who used it, if it is another's (only this player's own are heard).
   */
  private run(op: BoardOp, by?: string): boolean {
    this.cascade.flush();
    const game = this.game;
    if (op.t === 'hint') return this.placeOne(op.piece, by, false, true);
    if (op.t !== 'bomb') return false;
    const homeOf = (i: number) => ({ x: game.homes[i].x + game.homes[i].w / 2, y: game.homes[i].y + game.homes[i].h / 2 });
    const hits = nearestFirst(game.bombHits(op.x, op.y), op.x, op.y, homeOf);
    if (!hits.length) return false;
    const unit = Math.sqrt((this.init.width * this.init.height) / game.count);               // (a piece of the average size: the pieces are of different sizes)
    const plan = { x: op.x, y: op.y, unit, area: hits.map((i) => game.homes[i]), lo: 0.4, hi: 0.9 };
    if (by === undefined) buzz(this.init, 'join');
    dropBomb(this.cascade, this.ripples.bombs, this.init, plan, hits, (piece, late) => void this.placeOne(piece, by, late, false));
    this.init.requestDraw();
    return true;
  }

  /** One piece is put in its home by a hint or a bomb (it glides there, with its ripple and, this player's own, its sounds), unless it is being done late. */
  private placeOne(piece: number, by: string | undefined, late: boolean, buzzNow: boolean): boolean {
    const game = this.game;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const wasPlaced = game.slotOf.map((_, i) => game.placed(i));
    if (!applyBoardOp(this.board, { t: 'hint', piece }).ok) return false;               // (it is home already)
    if (buzzNow && by === undefined && !late) buzz(this.init, game.solved ? 'solved' : 'join');
    this.showSwap(before, wasPlaced, { by, sound: by === undefined && !late, late });
    this.init.requestDraw();
    this.init.progress?.();
    return true;
  }

  canHelp(kind: HelpKind, p: Pt): boolean {
    const game = this.game;
    if (game.solved) return false;
    if (kind === 'bomb') {
      const at = game.bombCentre(p.x, p.y);
      return game.bombHits(at.x, at.y).length > 0;
    }
    const piece = game.pieceAt(p.x, p.y);
    return piece >= 0 && !game.placed(piece);
  }

  help(kind: HelpKind, p: Pt): void {
    if (!this.canHelp(kind, p)) return;
    // a bomb is centred on the piece (the place in the picture) that the pointer was over, so that a few pixels either way make no difference
    const op: BoardOp = kind === 'hint' ? { t: 'hint', piece: this.game.pieceAt(p.x, p.y) } : { t: 'bomb', ...this.game.bombCentre(p.x, p.y) };
    if (this.run(op)) this.init.online?.send(op);
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

  moves(): number {
    return this.game.swaps;
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
    this.cascade.flush();
    if (op.t === 'hint' || op.t === 'bomb') {
      this.run(op, ev.by);
      return;
    }
    const game = this.game;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const wasPlaced = game.slotOf.map((_, i) => game.placed(i));
    if (!applyBoardOp(this.board, op).ok) return;
    if (game.selected >= 0 && game.placed(game.selected)) game.selected = -1;          // the piece this player had chosen found its place
    this.showSwap(before, wasPlaced, { by: ev.by });
    this.init.requestDraw();
    this.init.progress?.();
  }

  /** Takes the room's board in place of this one (the piece this player had chosen stays chosen, if it can still be). */
  resync(state: RoomState): void {
    this.cascade.cancel();
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

  /** A bomb's pieces are still being put in place one after the other (the board is not yet what the room's is). */
  busy(): boolean {
    return this.cascade.busy;
  }
}
