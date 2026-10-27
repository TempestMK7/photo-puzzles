import { JigsawGame, layoutJigsaw, rotVec, type Group, type JigsawLayout, type JigsawState } from '../core/jigsaw';
import { Rng } from '../core/rng';
import { haptic, type Haptic } from '../haptics';
import { beginFrame, type View } from '../render';
import { buildAtlas, buildMasks, snapshot, type Atlas } from './jigsawArt';
import { glAvailable, PieceRenderer } from './jigsawGl';
import { hapticToggles, LIFT_CSS, LIFT_MS } from './feedback';
import type { Pt, PuzzleSession, SessionInit, ToggleDef } from './types';

const WORLD_K = 4;             // the usable area is this many puzzles wide and high
const SCATTER_K = 0.75;        // pieces start this far round the puzzle (in puzzle widths / heights), not all over the world
const PAN_TAP = 3;
const HOVER_MS = 500;           // how long pieces have to be held together to snap, when joining is on hover

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
  readonly toggles: ToggleDef[] = hapticToggles();
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
  private hover = 0;                          // 0, or the timer of a join that is waiting for its half second
  private fixedRes = false;
  private adapt = { t0: 0, decoded0: 0, renders: 0 };
  private pendingCam: { ratio: number; cx: number; cy: number } | null = null;     // the camera of a saved game, until the canvas has a size
  private flash = new Set<number>();
  private flashStart = 0;

  constructor(private readonly init: SessionInit) {
    const rng = new Rng(init.seed);
    this.turning = init.opts.turning === 1;
    this.snap = init.opts.snap ?? SNAP_DRAG;
    this.rotatable = this.turning;
    this.layout_ = layoutJigsaw(rng, init.width, init.height, init.opts.pieces);
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
    const puzzleW = l.cols * l.size;
    const puzzleH = l.rows * l.size;
    this.worldW = puzzleW * WORLD_K;
    this.worldH = puzzleH * WORLD_K;
    this.frameX = (this.worldW - puzzleW) / 2;
    this.frameY = (this.worldH - puzzleH) / 2;
    const mx = puzzleW * SCATTER_K;
    const my = puzzleH * SCATTER_K;
    // every loose piece starts somewhere round the frame, not on it
    this.game = new JigsawGame(l, (i) => {
      const c = i % l.cols;
      const r = Math.floor(i / l.cols);
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = this.frameX - mx + rng.unit() * (puzzleW + 2 * mx - l.size);
        y = this.frameY - my + rng.unit() * (puzzleH + 2 * my - l.size);
        const onFrame = x + l.size > this.frameX && x < this.frameX + puzzleW && y + l.size > this.frameY && y < this.frameY + puzzleH;
        if (!onFrame) break;
      }
      const rot = this.turning ? rng.below(4) : 0;
      // the piece's cell centre, turned, lies at the chosen spot
      const [cx, cy] = rotVec(rot, (c + 0.5) * l.size, (r + 0.5) * l.size);
      return { rot, dx: x + l.size / 2 - this.frameX - cx, dy: y + l.size / 2 - this.frameY - cy };
    });
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
    ctx.fillStyle = '#241711';
    ctx.fillRect(0, 0, this.worldW, this.worldH);
    ctx.strokeStyle = '#6b4a36';
    ctx.lineWidth = 3 / view.scale;
    ctx.strokeRect(0, 0, this.worldW, this.worldH);
    // where the picture goes
    const pw = l.cols * l.size;
    const ph = l.rows * l.size;
    ctx.fillStyle = '#2d1e15';
    ctx.fillRect(this.frameX, this.frameY, pw, ph);
    ctx.strokeStyle = 'rgba(255,216,74,0.3)';
    ctx.lineWidth = 2 / view.scale;
    ctx.setLineDash([8 / view.scale, 6 / view.scale]);
    ctx.strokeRect(this.frameX, this.frameY, pw, ph);
    ctx.setLineDash([]);
    // a moment's glow where pieces have just joined the picture
    let running = false;
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
    for (const id of g.z) {
      const grp = g.groups.get(id)!;
      if (id === selId) {                                         // a glow round the selected group: drawn under it, and over again by the pieces themselves
        ctx.shadowColor = '#ffd84a';
        ctx.shadowBlur = 16;
        drawGroup(lit, grp);
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
    this.gl!.render(
      { width: this.canvasW, height: this.canvasH, scale: view.scale, ox: view.ox, oy: view.oy, frameX: this.frameX, frameY: this.frameY },
      anchored,
      loose,
      selId >= 0 ? g.groups.get(selId)! : null,
      flash,
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- input

  private world(p: Pt): Pt {
    return { x: Math.min(this.worldW, Math.max(0, p.x)), y: Math.min(this.worldH, Math.max(0, p.y)) };
  }

  /** How close a piece has to be to its neighbour to join it: generous on screen, in any zoom. */
  private tolerance(): number {
    const s = this.layout_.size;
    return Math.min(0.5 * s, Math.max(0.2 * s, 10 / this.cam.zoom));
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
    const grp = this.game.groups.get(gid)!;
    this.game.bringToFront(gid);
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

  /** Where the dragged group is held: at the pointer, or, for a finger, a little above it (but never off the top of the screen). */
  private hold(d: Drag): { x: number; y: number } {
    let y = d.qy - d.lift * (d.k * d.k * (3 - 2 * d.k));
    if (d.lift) {
      const dpr = window.devicePixelRatio || 1;
      y = Math.max(y, this.cam.cy - this.frameY - (this.canvasH / 2 - 24 * dpr) / this.cam.zoom, -this.frameY);
    }
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
    if (this.pan?.deselect && !this.pan.moved) this.sel = -1;      // a click on bare ground
    this.drag = null;
    this.pan = null;
    this.init.requestDraw();
  }

  pointerCancel(): void {
    this.cancelHover();
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
      this.snapCheck();
    } else {
      const id = this.selectedGroup();
      if (id < 0) return;
      const [cx, cy] = g.centre(id);
      g.rotate(id, cx, cy);
      this.buzz('turn');
      if (this.snap === SNAP_DRAG) this.settle(id);
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

  /** Joins the group to whatever it now lies right against (turned the same way); if it was being dragged, the drag ends there. */
  private settle(gid: number): void {
    const g = this.game;
    if (!g.groups.has(gid)) return;
    const before = new Set(g.groups.get(gid)!.members);
    const wasAnchored = g.anchoredCount;
    const res = g.connect(gid, this.tolerance());
    if (res.joins === 0) return;
    this.cancelHover();
    if (this.drag?.gid === gid) this.drag = null;
    if (g.anchoredCount > wasAnchored) {
      this.flash = before;
      this.flashStart = performance.now();
      if (this.sel >= 0 && g.groups.get(g.groupOf[this.sel])!.anchored) this.sel = -1;
    }
    this.buzz(g.solved ? 'solved' : g.anchoredCount > wasAnchored ? 'placed' : 'join');
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
