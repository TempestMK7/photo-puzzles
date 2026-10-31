import { rotVec, type Group, type JigsawGame, type JigsawLayout, type JigsawState } from '../core/jigsaw';
import { applyOp, buildJigsaw, SCATTER_K, TOL_MAX_K, TOL_MIN_K, type JigsawOp } from '../core/jigsawSetup';
import type { RoomEvent, RoomState } from '../core/jigsawRoom';
import { haptic, type Haptic } from '../haptics';
import type { HandMessage } from '../online/protocol';
import { beginFrame, type View } from '../render';
import { buildAtlas, buildMasks, snapshot, type Atlas } from './jigsawArt';
import { glAvailable, PieceRenderer } from './jigsawGl';
import { hapticToggles, LIFT_CSS, LIFT_MS } from './feedback';
import type { Pt, PuzzleSession, SessionInit, ToggleDef } from './types';

const PAN_TAP = 3;
const HOVER_MS = 500;           // how long pieces have to be held together to snap, when joining is on hover

interface Pose {
  dx: number;
  dy: number;
  rot: number;
}

interface Drag {
  gid: number;
  px: number;
  py: number;
  qx: number;
  qy: number;
  moved: boolean;
  lift: number;
  t0: number;
  k: number;
}

const SNAP_DRAG = 0;
const SNAP_HOVER = 1;
// (2: snap only when let go)

/**
 * Jigsaw: pieces with tabs and blanks lie scattered round the frame of the picture. Drag them (left button); a piece put next to a piece it belongs beside joins it, and
 * joined pieces move as one; anything that joins a corner piece becomes part of the finished picture. The mouse wheel (and the control at the bottom right) zooms, the right
 * button (or the left one, on bare ground) pans. With turning on the pieces start turned in quarter turns: a click selects a piece, and the right button (or R) turns the
 * piece being dragged or the selected one; pieces only join when turned the same way (the picture only takes upright pieces). The "joining" option says when a piece that lies
 * right against one it fits joins it: as soon as it does, once it has been held there for a moment (or when it is let go there), or only when it is let go.
 */
export class JigsawSession implements PuzzleSession {
  readonly toggles: ToggleDef[] = [{ key: 'light', label: 'Light', title: 'Light or dark background' }, ...hapticToggles()];
  readonly rotatable: boolean;
  /** The canvas the pieces are drawn on when they are drawn on the graphics card: it lies over the board's. */
  get overlay(): HTMLCanvasElement | undefined {
    return this.gl?.canvas;
  }
  private layout_: JigsawLayout;
  private game: JigsawGame;
  private atlas: Atlas | null = null;
  /** Set when the pieces are cut from a video and the browser can draw them on the graphics card. */
  private gl: PieceRenderer | null = null;
  private worldW: number;
  private worldH: number;
  private frameX: number;
  private frameY: number;
  private cam = { zoom: 1, cx: 0, cy: 0 };
  private canvasW = 0;
  private canvasH = 0;
  private fitZoom = 1;
  private inited = false;
  private readonly turning: boolean;
  private readonly snap: number;
  /**
   * The dragged group, the solved-picture point it is held by, where the pointer is (relative to the frame), whether it has been moved or turned, and - for a finger - how far
   * (in world units) the piece is held above the finger once it has risen (`k`: how far it has got, 0 to 1, from the moment `t0` it was picked up).
   */
  private drag: Drag | null = null;
  private pan: { anchor: Pt; moved: boolean; deselect: boolean } | null = null;
  private rightClick = false;                 // the right button is down and has not moved the camera: letting go turns the selected piece
  private sel = -1;                           // a piece of the selected group
  private others: { by: string; name: string; piece: number }[] | null = null;       // what `chosen` found out, until the room says it changed
  private hover = 0;                          // 0, or the timer of a join that is waiting for its half second
  private fixedRes = false;
  private adapt = { t0: 0, decoded0: 0, renders: 0 };
  private pendingCam: { ratio: number; cx: number; cy: number } | null = null;     // the camera of a saved game, until the canvas has a size
  private flash = new Set<number>();
  private flashStart = 0;
  /** The pieces other players hold: where each really is on the board (`truth`), where its holder's hand put it last (`target`), and where it is drawn (`cur`, which follows the target). */
  private hands = new Map<string, { gid: number; truth: Pose; target: Pose; cur: Pose }>();
  private lastDraw = 0;

  constructor(private readonly init: SessionInit) {
    this.turning = init.opts.turning === 1;
    this.snap = init.opts.snap ?? SNAP_DRAG;
    this.rotatable = this.turning;
    const board = buildJigsaw({ seed: init.seed, width: init.width, height: init.height, opts: init.opts });
    this.layout_ = board.layout;
    this.game = board.game;
    this.worldW = board.worldW;
    this.worldH = board.worldH;
    this.frameX = board.frameX;
    this.frameY = board.frameY;
    const l = this.layout_;
    if (init.video && glAvailable()) {
      try {
        this.gl = new PieceRenderer(buildMasks(l), l, init.video);
      } catch {
        this.gl = null;                                           // no way to draw video pieces here: they are cut from the picture the video is stopped at
      }
    }
    if (!this.gl) this.atlas = buildAtlas(snapshot(init), l);
    if (this.gl) {
      try {
        const fixed = Number(window.localStorage.getItem('photo-puzzles/gl-res'));      // for trying a resolution out: 0.25 - 1
        if (fixed >= 0.25 && fixed <= 1) {
          this.gl.res = fixed;
          this.fixedRes = true;
        }
      } catch {
        // storage is not available: the resolution adapts by itself
      }
    }
    if (init.restore) {
      const saved = init.restore as { game: JigsawState; sel: number; cam: { ratio: number; cx: number; cy: number } };
      this.game.restore(saved.game);
      if (Number.isInteger(saved.sel) && saved.sel >= 0 && saved.sel < this.game.count) this.sel = saved.sel;
      if (saved.cam && [saved.cam.ratio, saved.cam.cx, saved.cam.cy].every(Number.isFinite)) this.pendingCam = saved.cam;
    }
  }

  serialize(): unknown {
    return { game: this.game.snapshot(), sel: this.sel, cam: this.inited ? { ratio: this.cam.zoom / this.fitZoom, cx: this.cam.cx, cy: this.cam.cy } : this.pendingCam };
  }

  // ---------------------------------------------------------------------------------------------------------------- camera

  layout(): { width: number; height: number } {
    return { width: this.worldW, height: this.worldH };
  }

  private get minZoom(): number {
    return Math.min(this.canvasW / this.worldW, this.canvasH / this.worldH) * 0.95;
  }

  private get maxZoom(): number {
    return Math.max(this.fitZoom * 2, 280 / this.layout_.size);
  }

  /** The view that shows the whole area the pieces start in. */
  private fit(): void {
    const l = this.layout_;
    const w = l.cols * l.size * (1 + 2 * SCATTER_K);
    const h = l.rows * l.size * (1 + 2 * SCATTER_K);
    this.fitZoom = Math.max(1e-4, Math.min(this.canvasW / w, this.canvasH / h) * 0.96);
    this.cam = { zoom: this.fitZoom, cx: this.worldW / 2, cy: this.worldH / 2 };
  }

  view(cw: number, ch: number): View {
    if (cw !== this.canvasW || ch !== this.canvasH) {
      const first = !this.inited;
      this.canvasW = cw;
      this.canvasH = ch;
      if (first) {
        this.fit();
        if (this.pendingCam) {                                    // the camera of a saved game: as far in as it was, looking where it was
          this.cam = { zoom: Math.min(this.maxZoom, Math.max(this.minZoom, this.fitZoom * this.pendingCam.ratio)), cx: this.pendingCam.cx, cy: this.pendingCam.cy };
          this.clampCentre();
          this.pendingCam = null;
        }
        this.inited = true;
      } else this.cam.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.cam.zoom));
    }
    return { scale: this.cam.zoom, ox: cw / 2 - this.cam.cx * this.cam.zoom, oy: ch / 2 - this.cam.cy * this.cam.zoom };
  }

  private clampCentre(): void {
    this.cam.cx = Math.min(this.worldW, Math.max(0, this.cam.cx));
    this.cam.cy = Math.min(this.worldH, Math.max(0, this.cam.cy));
  }

  /** Zoom by a factor, keeping the world point `at` where it is on the screen. */
  private zoomAt(at: Pt, factor: number): void {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.cam.zoom * factor));
    const k = this.cam.zoom / z;
    this.cam.cx = at.x + (this.cam.cx - at.x) * k;
    this.cam.cy = at.y + (this.cam.cy - at.y) * k;
    this.cam.zoom = z;
    this.clampCentre();
    this.init.requestDraw();
  }

  wheel(at: Pt, deltaY: number): void {
    this.zoomAt(at, Math.exp(-deltaY * 0.0015));
  }

  /** Two fingers moved: what was under `from` (canvas pixels) now lies under `to`, and the picture is `factor` times bigger. */
  pinch(from: Pt, to: Pt, factor: number): void {
    const z = Math.min(this.maxZoom, Math.max(this.minZoom, this.cam.zoom * factor));
    const wx = this.cam.cx + (from.x - this.canvasW / 2) / this.cam.zoom;
    const wy = this.cam.cy + (from.y - this.canvasH / 2) / this.cam.zoom;
    this.cam.zoom = z;
    this.cam.cx = wx + (this.canvasW / 2 - to.x) / z;
    this.cam.cy = wy + (this.canvasH / 2 - to.y) / z;
    this.clampCentre();
    this.init.requestDraw();
  }

  zoomBy(factor: number): void {
    this.zoomAt({ x: this.cam.cx, y: this.cam.cy }, factor);
  }

  zoomFit(): void {
    this.fit();
    this.init.requestDraw();
  }

  zoomLabel(): string {
    return `${Math.round((this.cam.zoom / this.fitZoom) * 100)}%`;
  }

  // ---------------------------------------------------------------------------------------------------------------- drawing

  draw(ctx: CanvasRenderingContext2D, view: View, now: number): boolean {
    beginFrame(ctx, view);
    const l = this.layout_;
    const light = this.init.flag('light');                        // pieces that are hard to see on one background show on the other
    ctx.fillStyle = light ? '#ece2d2' : '#241711';
    ctx.fillRect(0, 0, this.worldW, this.worldH);
    ctx.strokeStyle = light ? '#b59a7e' : '#6b4a36';
    ctx.lineWidth = 3 / view.scale;
    ctx.strokeRect(0, 0, this.worldW, this.worldH);
    // where the picture goes
    const pw = l.cols * l.size;
    const ph = l.rows * l.size;
    ctx.fillStyle = light ? '#ddd0bb' : '#2d1e15';
    ctx.fillRect(this.frameX, this.frameY, pw, ph);
    ctx.strokeStyle = light ? 'rgba(120,70,10,0.45)' : 'rgba(255,216,74,0.3)';
    ctx.lineWidth = 2 / view.scale;
    ctx.setLineDash([8 / view.scale, 6 / view.scale]);
    ctx.strokeRect(this.frameX, this.frameY, pw, ph);
    ctx.setLineDash([]);
    // a moment's glow where pieces have just joined the picture
    let running = this.stepHands(now);
    const flashK = this.flashLeft(now);
    if (flashK > 0) running = true;
    const d = this.drag;
    if (d && d.k < 1) {                                           // a piece picked up by a finger rises above it
      d.k = Math.min(1, (now - d.t0) / LIFT_MS);
      this.placeDragged();
      running = true;
    }
    if (this.gl) this.drawGl(view, flashK > 0 ? { members: [...this.flash], k: flashK } : null);
    else {
      this.draw2d(ctx, view);
      if (flashK > 0) {
        ctx.fillStyle = `rgba(255,255,255,${0.35 * flashK})`;
        for (const m of this.flash) ctx.fillRect(this.frameX + (m % l.cols) * l.size, this.frameY + Math.floor(m / l.cols) * l.size, l.size, l.size);
      }
    }
    this.lastDraw = now;
    return running;
  }

  /**
   * A slow graphics card cannot show the pieces at the board's full resolution at the video's frame rate: whenever the pieces were drawn for clearly fewer pictures
   * than the video decoded in the last two seconds, the piece canvas gets a quarter fewer pixels in each direction (down to half).
   */
  private adaptResolution(): void {
    const v = this.init.video!;
    if (this.fixedRes || v.paused) {
      this.adapt.t0 = 0;
      return;
    }
    const now = performance.now();
    const decoded = v.getVideoPlaybackQuality().totalVideoFrames;
    if (!this.adapt.t0) {
      this.adapt = { t0: now, decoded0: decoded, renders: 0 };
      return;
    }
    this.adapt.renders++;
    if (now - this.adapt.t0 < 2000) return;
    const shown = this.adapt.renders / Math.max(1, decoded - this.adapt.decoded0);
    if (decoded - this.adapt.decoded0 >= 30 && shown < 0.85 && this.gl!.res > 0.5) this.gl!.res = Math.max(0.5, this.gl!.res * 0.75);
    this.adapt.t0 = 0;
  }

  /** How much of the join glow is left (0: none), forgetting the pieces once it is over. */
  private flashLeft(now: number): number {
    if (!this.flash.size) return 0;
    const k = 1 - (now - this.flashStart) / 500;
    if (k <= 0) this.flash.clear();
    return Math.max(0, k);
  }

  /** A new picture of the video: only the pieces are drawn again, on their own canvas; the board under them is as it was. */
  videoFrame(now: number): void {
    if (!this.gl || !this.inited) return;
    const k = this.flashLeft(now);
    this.drawGl(this.view(this.canvasW, this.canvasH), k > 0 ? { members: [...this.flash], k } : null);
  }

  /** The pieces cut from a still picture: tiles of the atlas, one drawImage each. */
  private draw2d(ctx: CanvasRenderingContext2D, view: View): void {
    const l = this.layout_;
    const g = this.game;
    ctx.imageSmoothingQuality = view.scale < 0.6 ? 'low' : 'high';
    const { canvas: lit, plain, pad, tile, pitch } = this.atlas!;
    const x0 = -view.ox / view.scale;
    const y0 = -view.oy / view.scale;
    const x1 = (this.canvasW - view.ox) / view.scale;
    const y1 = (this.canvasH - view.oy) / view.scale;
    const half = tile * 0.75;
    const drawGroup = (atlas: HTMLCanvasElement, grp: { members: number[]; rot: number; dx: number; dy: number }): void => {
      for (const m of grp.members) {
        const c = m % l.cols;
        const r = Math.floor(m / l.cols);
        const [rx, ry] = rotVec(grp.rot, (c + 0.5) * l.size, (r + 0.5) * l.size);
        const cx = this.frameX + grp.dx + rx;
        const cy = this.frameY + grp.dy + ry;
        if (cx - half > x1 || cy - half > y1 || cx + half < x0 || cy + half < y0) continue;
        const o = l.size / 2 + pad;
        if (grp.rot === 0) ctx.drawImage(atlas, c * pitch + 1, r * pitch + 1, tile, tile, cx - o, cy - o, tile, tile);
        else {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((grp.rot * Math.PI) / 2);
          ctx.drawImage(atlas, c * pitch + 1, r * pitch + 1, tile, tile, -o, -o, tile, tile);
          ctx.restore();
        }
      }
    };
    for (const grp of g.groups.values()) if (grp.anchored) drawGroup(plain, grp);
    const selId = this.selectedGroup();
    const theirs = new Map<number, string>();                     // a glow of the colour of the player who holds it
    for (const [by, hand] of this.hands) theirs.set(hand.gid, this.init.online?.colorOf(by) ?? '#fff');
    for (const r of this.chosen()) if (!theirs.has(g.groupOf[r.piece])) theirs.set(g.groupOf[r.piece], this.init.online!.colorOf(r.by));         // a piece another player has chosen
    for (const id of g.z) {
      const grp = g.groups.get(id)!;
      const held = theirs.get(id);
      if (id === selId || held) {                                 // a glow round the selected group: drawn under it, and over again by the pieces themselves
        // a piece in another player's hand shows that player's colour, whatever this player has selected, and strongly (a pale halo disappears round a small piece)
        ctx.shadowColor = held ?? (this.init.flag('light') ? '#e67300' : '#ffd84a');
        ctx.shadowBlur = held ? 22 : 16;
        for (let pass = held ? 3 : 1; pass > 0; pass--) drawGroup(lit, grp);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
      }
      drawGroup(lit, grp);
    }
  }

  /** The pieces cut from a video: drawn on the graphics card into a canvas of their own that lies over the board (copying it onto the board's canvas every frame would cost far too much on a slow GPU). */
  private drawGl(view: View, flash: { members: number[]; k: number } | null): void {
    this.adaptResolution();
    const g = this.game;
    const selId = this.selectedGroup();
    const loose: Group[] = [];
    for (const id of g.z) if (id !== selId) loose.push(g.groups.get(id)!);
    const anchored: Group[] = [];
    for (const grp of g.groups.values()) if (grp.anchored) anchored.push(grp);
    // the groups that other players hold or have chosen glow in their colours
    const glows = new Map<number, [number, number, number]>();
    for (const [by, hand] of this.hands) glows.set(hand.gid, rgbOf(this.init.online?.colorOf(by) ?? '#ffffff'));
    for (const r of this.chosen()) if (!glows.has(g.groupOf[r.piece])) glows.set(g.groupOf[r.piece], rgbOf(this.init.online!.colorOf(r.by)));
    const lit: { group: Group; rgb: [number, number, number] }[] = [];
    for (const [gid, rgb] of glows) {
      const group = g.groups.get(gid);
      if (group && !group.anchored && gid !== selId) lit.push({ group, rgb });
    }
    this.gl!.render(
      { width: this.canvasW, height: this.canvasH, scale: view.scale, ox: view.ox, oy: view.oy, frameX: this.frameX, frameY: this.frameY, light: this.init.flag('light') },
      anchored,
      loose,
      selId >= 0 ? g.groups.get(selId)! : null,
      flash,
      lit,
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  private world(p: Pt): Pt {
    return { x: Math.min(this.worldW, Math.max(0, p.x)), y: Math.min(this.worldH, Math.max(0, p.y)) };
  }

  /** How close a piece has to be to its neighbour to join it: generous on screen, in any zoom. */
  private tolerance(): number {
    const s = this.layout_.size;
    return Math.min(TOL_MAX_K * s, Math.max(TOL_MIN_K * s, 10 / this.cam.zoom));
  }

  /** The selected group, or -1 (none selected, or it has become part of the picture). */
  private selectedGroup(): number {
    if (this.sel < 0) return -1;
    const id = this.game.groupOf[this.sel];
    return this.game.groups.get(id)!.anchored ? -1 : id;
  }

  pointerDown(p: Pt, touch = false): void {
    const gid = this.game.groupAt(p.x - this.frameX, p.y - this.frameY);
    if (gid < 0) {
      this.pan = { anchor: p, moved: false, deselect: true };
      return;
    }
    const blocked = this.init.online?.blockedBy();
    if (blocked) {                                                // another player has a piece in hand: this one can be looked at, but not picked up
      this.init.online!.notify(`${blocked} is moving a piece`);
      this.pan = { anchor: p, moved: false, deselect: false };
      return;
    }
    const chosenBy = this.chosenBy(gid);
    if (chosenBy) {                                               // another player has chosen this piece: it is theirs for a while
      this.init.online!.notify(`${chosenBy} has chosen that piece`);
      this.pan = { anchor: p, moved: false, deselect: false };
      return;
    }
    const grp = this.game.groups.get(gid)!;
    this.commit({ t: 'grab', piece: grp.members[0] });
    this.init.online?.holding(grp.members[0]);
    this.sel = grp.members[0];
    const q = this.world(p);
    const [px, py] = this.game.toSolved(grp, q.x - this.frameX, q.y - this.frameY);
    const dpr = window.devicePixelRatio || 1;
    this.drag = { gid, px, py, qx: q.x - this.frameX, qy: q.y - this.frameY, moved: false, lift: touch && this.init.flag('offset') ? (LIFT_CSS * dpr) / this.cam.zoom : 0, t0: performance.now(), k: touch && this.init.flag('offset') ? 0 : 1 };
    this.buzz('grab');
    this.init.requestDraw();
  }

  /** Gives touch feedback (on a device that can, if the player has not turned it off). */
  private buzz(kind: Haptic): void {
    if (this.init.flag('haptics')) haptic(kind);
  }

  /** Where the dragged group is held: at the pointer, or, for a finger, a little above it. It may go up past the top of the screen (a piece for the top edge of the board needs that), but not off the table. */
  private hold(d: Drag): { x: number; y: number } {
    let y = d.qy - d.lift * (d.k * d.k * (3 - 2 * d.k));
    if (d.lift) y = Math.max(y, -this.frameY);
    return { x: d.qx, y };
  }

  pointerMove(p: Pt): void {
    if (this.pan) {
      this.panTo(p);
      return;
    }
    const d = this.drag;
    if (!d) return;
    const q = this.world(p);
    d.qx = q.x - this.frameX;
    d.qy = q.y - this.frameY;
    this.placeDragged();
    d.moved = true;
    this.sendHand();
    this.snapCheck();
    this.init.requestDraw();
  }

  /** Puts the dragged group where the pointer holds it, whatever its turn. */
  private placeDragged(): void {
    const d = this.drag!;
    const grp = this.game.groups.get(d.gid)!;
    const [rx, ry] = rotVec(grp.rot, d.px, d.py);
    const h = this.hold(d);
    this.game.moveTo(d.gid, h.x - rx, h.y - ry);
  }

  holding(): boolean {
    return !!this.drag;
  }

  pointerUp(): void {
    const d = this.drag;
    this.cancelHover();
    if (d && d.moved && this.snap !== SNAP_DRAG) this.settle(d.gid);        // let go with pieces together: they join, whatever was left of the wait
    if (d && d.moved && this.drag === d) this.buzz('drop');                 // set down without joining anything
    if (d && this.drag === d) this.release(d.gid);
    if (this.pan?.deselect && !this.pan.moved) this.deselect();     // a click on bare ground
    this.drag = null;
    this.pan = null;
    this.init.requestDraw();
  }

  pointerCancel(): void {
    this.cancelHover();
    if (this.drag) this.release(this.drag.gid);
    this.drag = null;
    this.pan = null;
    this.rightClick = false;
  }

  rightDown(p: Pt): void {
    this.rightClick = true;
    if (this.game.groupAt(p.x - this.frameX, p.y - this.frameY) >= 0) return;       // on a piece: it does not move the camera
    this.pan = { anchor: p, moved: false, deselect: false };
  }

  rightMove(p: Pt): void {
    if (this.pan) this.panTo(p);
  }

  rightUp(): void {
    if (this.rightClick && !this.pan?.moved) this.secondary();     // a right click, not a right drag: turn the selected piece
    this.rightClick = false;
    this.pan = null;
  }

  private panTo(p: Pt): void {
    const pan = this.pan!;
    if (!pan.moved && Math.hypot(p.x - pan.anchor.x, p.y - pan.anchor.y) * this.cam.zoom < PAN_TAP) return;
    pan.moved = true;
    this.cam.cx += pan.anchor.x - p.x;                            // the world point that was under the pointer stays under it
    this.cam.cy += pan.anchor.y - p.y;
    this.clampCentre();
    this.init.requestDraw();
  }

  /** Turn the piece in hand, or the selected one, a quarter turn clockwise (right click, R, the Rotate button). */
  secondary(): void {
    if (!this.turning) return;
    const g = this.game;
    const d = this.drag;
    if (d && g.groups.has(d.gid)) {
      const h = this.hold(d);
      g.rotate(d.gid, h.x, h.y);                                  // about the point it is held by, so the piece stays in hand
      const grp = g.groups.get(d.gid)!;
      [d.px, d.py] = g.toSolved(grp, h.x, h.y);
      this.buzz('turn');
      d.moved = true;
      this.sendHand();
      this.snapCheck();
    } else {
      const id = this.selectedGroup();
      if (id < 0) return;
      const blocked = this.init.online?.blockedBy();
      if (blocked) {
        this.init.online!.notify(`${blocked} is moving a piece`);
        return;
      }
      const chosenBy = this.chosenBy(id);
      if (chosenBy) {
        this.init.online!.notify(`${chosenBy} has chosen that piece`);
        return;
      }
      this.buzz('turn');
      this.apply({ t: 'rotate', piece: this.game.groups.get(id)!.members[0], tol: this.snap === SNAP_DRAG ? this.tolerance() : null });
    }
    this.init.requestDraw();
  }

  /** After the dragged group has moved or turned: join it now, start waiting to join it, or leave it for when it is let go. */
  private snapCheck(): void {
    const d = this.drag;
    if (!d) return;
    if (this.snap === SNAP_DRAG) this.settle(d.gid);
    else if (this.snap === SNAP_HOVER) {
      if (!this.game.canJoin(d.gid, this.tolerance())) this.cancelHover();
      else if (!this.hover) {
        this.hover = window.setTimeout(() => {
          this.hover = 0;
          const cur = this.drag;
          if (cur && this.game.canJoin(cur.gid, this.tolerance())) this.settle(cur.gid);
          this.init.requestDraw();
          this.init.progress?.();
        }, HOVER_MS);
      }
    }
  }

  private cancelHover(): void {
    if (this.hover) window.clearTimeout(this.hover);
    this.hover = 0;
  }

  /**
   * Every change to the board that other players would have to see goes through here, as an operation (see `JigsawOp`): picking a group up, putting it down, turning it.
   * Moving a piece while it is in hand is not one: that only shows on this screen until it is put down.
   */
  private commit(op: JigsawOp): { id: number; joins: number } {
    const res = applyOp(this.game, op);
    this.init.online?.send(op);
    return res;
  }

  /** Where the piece in hand is, for the other players to see. */
  private sendHand(): void {
    const d = this.drag;
    const g = d && this.game.groups.get(d.gid);
    if (g) this.init.online?.hand({ piece: g.members[0], dx: g.dx, dy: g.dy, rot: g.rot });
  }

  /** The group is put down where it lies now, joining what it lies right against when `tol` says so. */
  private dropOp(gid: number, tol: number | null): JigsawOp {
    const grp = this.game.groups.get(gid)!;
    return { t: 'drop', piece: grp.members[0], dx: grp.dx, dy: grp.dy, rot: grp.rot, tol };
  }

  /** Lets go of a group that was in hand, where it is. */
  private release(gid: number): void {
    if (this.game.groups.has(gid)) this.commit(this.dropOp(gid, null));
    this.init.online?.holding(null);
  }

  /** Joins the group to whatever it now lies right against (turned the same way); if it was being dragged, the drag ends there. */
  private settle(gid: number): void {
    const tol = this.tolerance();
    if (!this.game.groups.has(gid) || !this.game.canJoin(gid, tol)) return;
    this.apply(this.dropOp(gid, tol));
  }

  /** Commits an operation that may join groups, and gives the feedback for it: the glow, the buzz, the end of the drag. */
  private apply(op: JigsawOp): void {
    const g = this.game;
    const gid = g.groupOf[op.piece];
    if (!g.groups.has(gid)) return;
    const before = new Set(g.groups.get(gid)!.members);
    const wasAnchored = g.anchoredCount;
    const res = this.commit(op);
    if (res.joins === 0) return;
    this.cancelHover();
    if (this.drag?.gid === gid) {
      this.drag = null;
      this.init.online?.holding(null);
    }
    if (g.anchoredCount > wasAnchored) {
      this.flash = before;
      this.flashStart = performance.now();
      if (this.sel >= 0 && g.groups.get(g.groupOf[this.sel])!.anchored) this.sel = -1;
    }
    this.buzz(g.solved ? 'solved' : g.anchoredCount > wasAnchored ? 'placed' : 'join');
  }

  // ---------------------------------------------------------------------------------------------------------------- other players

  /** The name of the player who has chosen this group (clicked on it, or picked it up last), if it is not this player: it is theirs for a while. */
  private chosenBy(gid: number): string | null {
    for (const r of this.chosen()) if (this.game.groupOf[r.piece] === gid) return r.name;
    return null;
  }

  /** The pieces that other players have chosen: asked of the room when it says they changed (not for every picture drawn). */
  private chosen(): { by: string; name: string; piece: number }[] {
    return (this.others ??= this.init.online?.reserved() ?? []);
  }

  /** Lets go of the chosen piece: the others may take it now. */
  private deselect(): void {
    if (this.sel >= 0) this.init.online?.send({ t: 'unselect' });
    this.sel = -1;
  }

  /** The pieces that other players have chosen changed (or one ran out): the glows are drawn again. */
  reservations(): void {
    this.others = null;
    this.init.requestDraw();
  }

  /** Another player's operation (the room checked it and put it in order): applied as it is, with the glow when it finished part of the picture. */
  applyEvent(ev: RoomEvent): void {
    const op = ev.op;
    if (!op) return;                                              // a piece let go without moving: nothing changed on the board
    const g = this.game;
    const gid = g.groupOf[op.piece];
    if (this.drag?.gid === gid) {                                 // this player was holding it, but the room says it is another's: what they did here no longer counts
      this.drag = null;
      this.cancelHover();
      this.init.online?.holding(null);
    }
    const before = new Set(g.groups.get(gid)?.members ?? []);
    const wasAnchored = g.anchoredCount;
    applyOp(g, op);
    if (g.anchoredCount > wasAnchored) {
      this.flash = before;
      this.flashStart = performance.now();
      if (this.sel >= 0 && g.groups.get(g.groupOf[this.sel])!.anchored) this.sel = -1;
    }
    this.init.requestDraw();
    this.init.progress?.();
  }

  /** Takes the room's board in place of this one. */
  resync(state: RoomState): void {
    this.hands.clear();
    if (this.drag) {
      this.drag = null;
      this.cancelHover();
      this.init.online?.holding(null);
    }
    try {
      this.game.restore(state.game);
    } catch {
      return;                                                     // (the room's board is this puzzle's: this does not happen)
    }
    if (this.sel >= 0 && this.game.groups.get(this.game.groupOf[this.sel])!.anchored) this.sel = -1;
    this.init.requestDraw();
    this.init.progress?.();
  }

  groupCount(): number {
    return this.game.groups.size;
  }

  /** Where another player's piece in hand is now; `null` puts it back where the board has it. */
  hand(by: string, pose: HandMessage | null): void {
    const had = this.hands.get(by);
    if (had && (!pose || this.game.groupOf[pose.piece] !== had.gid)) {
      this.game.setPose(had.gid, had.truth.dx, had.truth.dy, had.truth.rot);
      this.hands.delete(by);
    }
    if (!pose) {
      this.init.requestDraw();
      return;
    }
    const gid = this.game.groupOf[pose.piece];
    const grp = this.game.groups.get(gid);
    if (!grp || grp.anchored) return;
    const target = { dx: pose.dx, dy: pose.dy, rot: pose.rot };
    const mine = this.hands.get(by);
    if (mine) mine.target = target;
    else {
      const truth = { dx: grp.dx, dy: grp.dy, rot: grp.rot };
      this.hands.set(by, { gid, truth, target, cur: { ...truth } });
    }
    this.init.requestDraw();
  }

  /** Moves the pieces other players hold towards where their hands put them (smoothly: the hands are heard a few times a second). True while something is still moving. */
  private stepHands(now: number): boolean {
    if (!this.hands.size) return false;
    const k = 1 - Math.exp(-Math.min(100, now - (this.lastDraw || now)) / 60);
    let moving = false;
    for (const h of this.hands.values()) {
      const gx = h.target.dx - h.cur.dx;
      const gy = h.target.dy - h.cur.dy;
      if (Math.abs(gx) + Math.abs(gy) > 0.3) moving = true;
      h.cur = { dx: h.cur.dx + gx * k, dy: h.cur.dy + gy * k, rot: h.target.rot };
      this.game.setPose(h.gid, h.cur.dx, h.cur.dy, h.cur.rot);
    }
    return moving;
  }

  dispose(): void {
    this.cancelHover();
    this.gl?.dispose();
  }

  status(): string {
    return `${this.game.anchoredCount} / ${this.game.count} placed`;
  }

  get solved(): boolean {
    return this.game.solved;
  }

  settingsChanged(): void {}
}

/** `#rrggbb` as three numbers from 0 to 1 (white for anything else). */
function rgbOf(css: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
}
