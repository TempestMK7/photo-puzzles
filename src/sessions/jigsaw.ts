import type { HelpKind } from '../core/help';
import { rotVec, TRAY_MAX, type Group, type JigsawGame, type JigsawLayout, type JigsawState } from '../core/jigsaw';
import { applyOp, buildJigsaw, SCATTER_K, TOL_MAX_K, TOL_MIN_K, type JigsawOp, type PieceOp } from '../core/jigsawSetup';
import { clampInTray, insideBox, traySize, trayView, type TrayView } from '../core/trays';
import type { RoomEvent, RoomState } from '../core/jigsawRoom';
import { haptic, type Haptic } from '../haptics';
import type { HandMessage } from '../online/protocol';
import { beginFrame, type View } from '../render';
import { buildAtlas, buildMasks, buildSprite, snapshot, type Atlas, type Sprite } from './jigsawArt';
import { glAvailable, PieceRenderer, type GlGroup } from './jigsawGl';
import { GroupRipple } from './ripple';
import { playEffect } from '../sounds';
import { LIFT_CSS, LIFT_MS } from './feedback';
import type { Pt, PuzzleSession, SessionInit } from './types';

const PAN_TAP = 3;
const HOVER_MS = 500;           // how long pieces have to be held together to snap, when joining is on hover

interface Pose {
  dx: number;
  dy: number;
  rot: number;
  /** The tray the group lies in (-1: the table), and so which space the pose is in. */
  tray: number;
}

/** The bar of trays at the left of the page, the header of an open tray, and the margin inside it: in CSS pixels (the page lays out the same). */
export const TRAY_BAR_CSS = 46;
export const TRAY_HEADER_CSS = 34;
const TRAY_PAD_CSS = 6;

interface Drag {
  gid: number;
  px: number;
  py: number;
  qx: number;
  qy: number;
  /** Where the pointer is on the canvas, in canvas pixels (to tell whether it is over the open tray). */
  cx: number;
  cy: number;
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
  private openTrayId = -1;                     // the tray that is open on this screen (a screen's own business: the others' are not told)
  private trayCache: { key: string; view: TrayView } | null = null;
  private others: { by: string; name: string; piece: number }[] | null = null;       // what `chosen` found out, until the room says it changed
  private hover = 0;                          // 0, or the timer of a join that is waiting for its half second
  private fixedRes = false;
  private adapt = { t0: 0, decoded0: 0, renders: 0 };
  private pendingCam: { ratio: number; cx: number; cy: number } | null = null;     // the camera of a saved game, until the canvas has a size
  /** The pieces in the picture, drawn once into one image (so that no seam shows between them), and which of them are in it. */
  private placedLayer: HTMLCanvasElement | null = null;
  private placedMask: Uint8Array;
  private placedSeen = -1;
  /** Joined groups that are not in the picture, each drawn as one image (see `buildSprite`), by group id; `null` when the group is too big for one. */
  private sprites = new Map<number, { count: number; first: number; sprite: Sprite | null }>();
  private wave = new GroupRipple();
  private waveGroup: GlGroup = { members: [], rot: 0, dx: 0, dy: 0 };
  private waveOut: { group: GlGroup; ks: number[] } = { group: this.waveGroup, ks: [] };
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
    this.placedMask = new Uint8Array(board.layout.cols * board.layout.rows);
    this.worldW = board.worldW;
    this.worldH = board.worldH;
    this.frameX = board.frameX;
    this.frameY = board.frameY;
    const l = this.layout_;
    if (init.video && glAvailable()) {
      try {
        this.gl = new PieceRenderer(buildMasks(l), l, init.video);
        this.gl.joinOf = (m) => this.joinedSides(m);
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
    let running = this.stepHands(now);
    const waving = this.wave.step(now);                           // the ripple over pieces that have just locked together
    if (waving) running = true;
    const d = this.drag;
    if (d && d.k < 1) {                                           // a piece picked up by a finger rises above it
      d.k = Math.min(1, (now - d.t0) / LIFT_MS);
      this.placeDragged();
      running = true;
    }
    if (this.gl) {
      this.drawGl(view, waving ? this.waveFlash() : null);
      const tv = this.tv();
      if (tv) {                                                   // (the open tray's panel is drawn here, under the graphics card's canvas, which draws its pieces)
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.paintTrayPanel(ctx, tv, light);
        ctx.restore();
      }
    } else {
      this.draw2d(ctx, view);
      if (waving) this.drawWave2d(ctx);
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

  /** The ripple as the graphics card draws it: the locked pieces where their group lies now, each as bright as the ripple makes it (nothing for a group in a tray, whose pose is another space's). */
  private waveFlash(): { group: GlGroup; ks: number[] } | null {
    const grp = this.game.groups.get(this.wave.gid);
    if (!grp || grp.tray >= 0) return null;
    this.waveGroup.members = this.wave.members;
    this.waveGroup.rot = grp.rot;
    this.waveGroup.dx = grp.dx;
    this.waveGroup.dy = grp.dy;
    this.waveOut.ks = this.wave.ks;
    return this.waveOut;
  }

  /** The ripple over still pictures: a white square over each piece it has reached (a quarter turn leaves a square as it is). */
  private drawWave2d(ctx: CanvasRenderingContext2D): void {
    const f = this.waveFlash();
    if (!f) return;
    const l = this.layout_;
    ctx.fillStyle = '#ffffff';
    f.group.members.forEach((m, j) => {
      if (f.ks[j] <= 0) return;
      const [rx, ry] = rotVec(f.group.rot, ((m % l.cols) + 0.5) * l.size, (Math.floor(m / l.cols) + 0.5) * l.size);
      ctx.globalAlpha = 0.4 * f.ks[j];
      ctx.fillRect(this.frameX + f.group.dx + rx - l.size / 2, this.frameY + f.group.dy + ry - l.size / 2, l.size, l.size);
    });
    ctx.globalAlpha = 1;
  }

  /** A new picture of the video: only the pieces are drawn again, on their own canvas; the board under them is as it was. */
  videoFrame(now: number): void {
    if (!this.gl || !this.inited) return;
    this.drawGl(this.view(this.canvasW, this.canvasH), this.wave.step(now) ? this.waveFlash() : null);
  }

  /** Which sides of piece m lie against another piece of its group (bit 0 top, 1 right, 2 bottom, 3 left). */
  private joinedSides(m: number): number {
    const { groupOf } = this.game;
    const { cols, rows } = this.layout_;
    const gid = groupOf[m];
    const c = m % cols;
    let bits = 0;
    if (m >= cols && groupOf[m - cols] === gid) bits |= 1;
    if (c < cols - 1 && groupOf[m + 1] === gid) bits |= 2;
    if (m + cols < cols * rows && groupOf[m + cols] === gid) bits |= 4;
    if (c > 0 && groupOf[m - 1] === gid) bits |= 8;
    return bits;
  }

  /** Forgets the pictures made of pieces (the board was replaced): they are made again when next drawn. */
  private forgetPictures(): void {
    this.placedSeen = -1;
    this.placedMask.fill(0);
    this.placedLayer?.getContext('2d')?.clearRect(0, 0, this.placedLayer.width, this.placedLayer.height);
    this.sprites.clear();
  }

  /**
   * The pieces that are part of the picture: they are laid into one image as they are placed (never taken out again), and that image is what is drawn - one drawImage of the part
   * on the screen, however many pieces there are, and no seam between them, which drawing each piece on its own leaves at a size that is not the pieces' own.
   */
  private drawPlaced(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
    const g = this.game;
    const l = this.layout_;
    const a = this.atlas!;
    if (!this.placedLayer) {
      this.placedLayer = document.createElement('canvas');
      this.placedLayer.width = Math.ceil(l.cols * l.size);
      this.placedLayer.height = Math.ceil(l.rows * l.size);
    }
    const layer = this.placedLayer;
    if (g.anchoredCount !== this.placedSeen) {
      this.placedSeen = g.anchoredCount;
      const lc = layer.getContext('2d')!;
      lc.imageSmoothingQuality = 'high';
      const o = l.size / 2 + a.pad;
      for (const grp of g.groups.values()) {
        if (!grp.anchored) continue;
        for (const m of grp.members) {
          if (this.placedMask[m]) continue;
          this.placedMask[m] = 1;
          const c = m % l.cols;
          const r = Math.floor(m / l.cols);
          lc.drawImage(a.plain, c * a.pitch + 1, r * a.pitch + 1, a.tile, a.tile, (c + 0.5) * l.size - o, (r + 0.5) * l.size - o, a.tile, a.tile);
        }
      }
    }
    const sx = Math.max(0, Math.floor(x0 - this.frameX));
    const sy = Math.max(0, Math.floor(y0 - this.frameY));
    const sw = Math.min(layer.width, Math.ceil(x1 - this.frameX)) - sx;
    const sh = Math.min(layer.height, Math.ceil(y1 - this.frameY)) - sy;
    if (sw > 0 && sh > 0) ctx.drawImage(layer, sx, sy, sw, sh, this.frameX + sx, this.frameY + sy, sw, sh);
  }

  /** Draws a group of joined pieces as the one picture it is (made when it first has to be drawn, and again when pieces join it); false if it is too big for that. */
  private drawSprite(ctx: CanvasRenderingContext2D, grp: Group, fx: number, fy: number): boolean {
    const g = this.game;
    let entry = this.sprites.get(grp.id);
    if (!entry || entry.count !== grp.members.length || entry.first !== grp.members[0]) {
      if (this.sprites.size > g.groups.size) for (const id of [...this.sprites.keys()]) if (!g.groups.has(id)) this.sprites.delete(id);
      const gid = g.groupOf[grp.members[0]];
      const total = this.layout_.cols * this.layout_.rows;
      entry = { count: grp.members.length, first: grp.members[0], sprite: buildSprite(this.atlas!, this.layout_, grp.members, (m) => m >= 0 && m < total && g.groupOf[m] === gid) };
      this.sprites.set(grp.id, entry);
    }
    const sp = entry.sprite;
    if (!sp) return false;
    ctx.save();
    ctx.translate(fx + grp.dx, fy + grp.dy);
    ctx.rotate((grp.rot * Math.PI) / 2);
    ctx.drawImage(sp.canvas, sp.x, sp.y);
    ctx.restore();
    return true;
  }

  /** The pieces cut from a still picture: tiles of the atlas, one drawImage each. */
  private draw2d(ctx: CanvasRenderingContext2D, view: View): void {
    const l = this.layout_;
    const g = this.game;
    ctx.imageSmoothingQuality = view.scale < 0.6 ? 'low' : 'high';
    const { canvas: lit, pad, tile, pitch } = this.atlas!;
    const x0 = -view.ox / view.scale;
    const y0 = -view.oy / view.scale;
    const x1 = (this.canvasW - view.ox) / view.scale;
    const y1 = (this.canvasH - view.oy) / view.scale;
    const half = tile * 0.75;
    const drawGroup = (atlas: HTMLCanvasElement, grp: Group): void => {
      if (grp.members.length > 1 && this.drawSprite(ctx, grp, this.frameX, this.frameY)) return;      // joined pieces are one picture, with an outline only round them
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
    this.drawPlaced(ctx, x0, y0, x1, y1);
    const selId = this.selectedGroup();
    const theirs = this.glowing();
    const drawLoose = (id: number, group: (atlas: HTMLCanvasElement, grp: Group) => void): void => {
      const grp = g.groups.get(id)!;
      const held = theirs.get(id);
      if (id === selId || held) {                                 // a glow round the selected group: drawn under it, and over again by the pieces themselves
        // a piece in another player's hand shows that player's colour, whatever this player has selected, and strongly (a pale halo disappears round a small piece)
        ctx.shadowColor = held ?? (this.init.flag('light') ? '#e67300' : '#ffd84a');
        ctx.shadowBlur = held ? 22 : 16;
        for (let pass = held ? 3 : 1; pass > 0; pass--) group(lit, grp);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
      }
      group(lit, grp);
    };
    for (const id of g.z) if (g.groups.get(id)!.tray < 0) drawLoose(id, drawGroup);
    // the open tray lies over the board: its panel, and the pieces in it (the same tiles, in the tray's own space and scale)
    const tv = this.tv();
    if (tv) {
      const light = this.init.flag('light');
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.paintTrayPanel(ctx, tv, light);
      ctx.beginPath();
      ctx.rect(tv.panel.x, tv.panel.y + tv.header.h, tv.panel.w, tv.panel.h - tv.header.h);
      ctx.clip();
      ctx.setTransform(tv.scale, 0, 0, tv.scale, tv.ox, tv.oy);
      ctx.imageSmoothingQuality = tv.scale < 0.6 ? 'low' : 'high';
      const inTray = (atlas: HTMLCanvasElement, grp: Group): void => {
        if (grp.members.length > 1 && this.drawSprite(ctx, grp, 0, 0)) return;
        for (const m of grp.members) {
          const c = m % l.cols;
          const r = Math.floor(m / l.cols);
          const [rx, ry] = rotVec(grp.rot, (c + 0.5) * l.size, (r + 0.5) * l.size);
          const cx = grp.dx + rx;
          const cy = grp.dy + ry;
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
      for (const id of g.z) if (g.groups.get(id)!.tray === this.openTrayId) drawLoose(id, inTray);
      ctx.restore();
    }
  }

  /** The groups that other players hold or have chosen, with the colour each glows in (the pieces in their hands first: they win). */
  private glowing(): Map<number, string> {
    const g = this.game;
    const theirs = new Map<number, string>();                     // a glow of the colour of the player who holds it
    for (const [by, hand] of this.hands) theirs.set(hand.gid, this.init.online?.colorOf(by) ?? '#fff');
    for (const r of this.chosen()) if (!theirs.has(g.groupOf[r.piece])) theirs.set(g.groupOf[r.piece], this.init.online!.colorOf(r.by));         // a piece another player has chosen
    return theirs;
  }

  /** The tray's panel on the board's canvas: its header strip and the tray itself, in the colours of the board. */
  private paintTrayPanel(ctx: CanvasRenderingContext2D, tv: TrayView, light: boolean): void {
    const { panel, header, area } = tv;
    ctx.fillStyle = light ? '#e4d7c2' : '#1b110b';
    ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
    ctx.fillStyle = light ? '#d6c6ad' : '#2d1e15';
    ctx.fillRect(header.x, header.y, header.w, header.h);
    ctx.fillStyle = light ? '#efe6d6' : '#241711';
    ctx.fillRect(area.x, area.y, area.w, area.h);
    ctx.strokeStyle = light ? 'rgba(120,70,10,0.5)' : 'rgba(255,216,74,0.35)';
    ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.5);
    ctx.strokeRect(panel.x, panel.y, panel.w, panel.h);
    ctx.setLineDash([6, 5]);
    ctx.strokeRect(area.x, area.y, area.w, area.h);
    ctx.setLineDash([]);
  }

  /** The pieces cut from a video: drawn on the graphics card into a canvas of their own that lies over the board (copying it onto the board's canvas every frame would cost far too much on a slow GPU). */
  private drawGl(view: View, flash: { group: GlGroup; ks: number[] } | null): void {
    this.adaptResolution();
    const g = this.game;
    const selId = this.selectedGroup();
    const selGroup = selId >= 0 ? g.groups.get(selId)! : null;
    const loose: Group[] = [];
    for (const id of g.z) if (id !== selId && g.groups.get(id)!.tray < 0) loose.push(g.groups.get(id)!);
    const anchored: Group[] = [];
    for (const grp of g.groups.values()) if (grp.anchored) anchored.push(grp);
    // the groups that other players hold or have chosen glow in their colours
    const glows = new Map<number, [number, number, number]>();
    for (const [by, hand] of this.hands) glows.set(hand.gid, rgbOf(this.init.online?.colorOf(by) ?? '#ffffff'));
    for (const r of this.chosen()) if (!glows.has(g.groupOf[r.piece])) glows.set(g.groupOf[r.piece], rgbOf(this.init.online!.colorOf(r.by)));
    const lit: { group: Group; rgb: [number, number, number] }[] = [];
    const litInTray: { group: Group; rgb: [number, number, number] }[] = [];
    for (const [gid, rgb] of glows) {
      const group = g.groups.get(gid);
      if (!group || group.anchored || gid === selId) continue;
      if (group.tray < 0) lit.push({ group, rgb });
      else if (group.tray === this.openTrayId) litInTray.push({ group, rgb });
    }
    // the open tray: its panel (drawn on the board's canvas, under this one), and the pieces in it
    const tv = this.tv();
    const inTray: Group[] = [];
    if (tv) for (const id of g.z) if (g.groups.get(id)!.tray === this.openTrayId && id !== selId) inTray.push(g.groups.get(id)!);
    this.gl!.render(
      { width: this.canvasW, height: this.canvasH, scale: view.scale, ox: view.ox, oy: view.oy, frameX: this.frameX, frameY: this.frameY, light: this.init.flag('light') },
      anchored,
      loose,
      selGroup && selGroup.tray < 0 ? selGroup : null,
      flash,
      lit,
      tv ? { box: tv.panel, header: tv.header.h, scale: tv.scale, ox: tv.ox, oy: tv.oy, groups: inTray, selected: selGroup && selGroup.tray === this.openTrayId ? selGroup : null, glows: litInTray } : null,
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
    const tv = this.tv();
    if (tv) {
      const c = this.toCanvas(p);
      if (insideBox(tv.panel, c.x, c.y)) {                         // on the open tray: its pieces are picked up from there, and bare tray does not move the board under it
        this.trayDown(tv, c, p);
        return;
      }
    }
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
    const here = this.toCanvas(p);
    this.drag = { gid, px, py, qx: q.x - this.frameX, qy: q.y - this.frameY, cx: here.x, cy: here.y, moved: false, lift: touch && this.init.flag('offset') ? (LIFT_CSS * dpr) / this.cam.zoom : 0, t0: performance.now(), k: touch && this.init.flag('offset') ? 0 : 1 };
    this.buzz('grab');
    this.init.requestDraw();
  }

  /** Gives touch feedback (on a device that can, if the player has not turned it off), and the sound that goes with the moment: a piece lifted, set down loose, or put in its place. */
  private buzz(kind: Haptic): void {
    if (this.init.flag('haptics')) haptic(kind);
    if (kind === 'grab') playEffect('pickup');
    else if (kind === 'drop') playEffect('drop');
    else if (kind === 'placed') playEffect('placed');                // (the end of the puzzle has its own sound)
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
    const here = this.toCanvas(p);
    d.cx = here.x;
    d.cy = here.y;
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
    const tv = this.tv();
    if (tv && insideBox(tv.panel, d.cx, d.cy)) {                 // over the open tray: it lies in the tray, held at the pointer, with its middle kept inside
      const t = this.trayPt(tv, d.cx, d.cy);
      const ts = traySize(this.layout_.cols, this.layout_.size);
      const c = clampInTray(grp, this.layout_.cols, this.layout_.size, t.x - rx, t.y - ry, grp.rot, ts.w, ts.h);
      this.game.setLocation(d.gid, this.openTrayId, c.dx, c.dy, grp.rot);
      return;
    }
    if (grp.tray >= 0) grp.tray = -1;                            // taken out of the tray: on the table again
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
      const tv = this.tv();
      const h = g.groups.get(d.gid)!.tray >= 0 && tv ? this.trayPt(tv, d.cx, d.cy) : this.hold(d);
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
  private commit(op: PieceOp): { id: number; joins: number } {
    const res = applyOp(this.game, op);
    this.init.online?.send(op);
    if (op.t === 'drop') this.init.traysChanged?.();             // (what lies in a tray is counted in the list)
    return res;
  }

  /** Where the piece in hand is, for the other players to see. */
  private sendHand(): void {
    const d = this.drag;
    const g = d && this.game.groups.get(d.gid);
    if (g) this.init.online?.hand({ piece: g.members[0], dx: g.dx, dy: g.dy, rot: g.rot, ...(g.tray >= 0 ? { tray: g.tray } : {}) });
  }

  /** The group is put down where it lies now, joining what it lies right against when `tol` says so. */
  private dropOp(gid: number, tol: number | null): Extract<PieceOp, { t: 'drop' }> {
    const grp = this.game.groups.get(gid)!;
    return { t: 'drop', piece: grp.members[0], dx: grp.dx, dy: grp.dy, rot: grp.rot, tol, ...(grp.tray >= 0 ? { tray: grp.tray } : {}) };
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

  /**
   * Pieces have locked together or into the picture: the ripple runs from where `from` were put down. Pieces that join each other are lit all over the group they are in now. Pieces
   * that are placed in the picture only light up the ones near them: those within two pieces of the middle of the ones just placed, and the more pieces were placed at once, the
   * wider it reaches (20% more for each piece placed after the first).
   */
  private startWave(gid: number, from: ReadonlySet<number>, now: number, placed: boolean): void {
    const grp = this.game.groups.get(gid);
    if (!grp || !from.size) return;
    const { cols, size } = this.layout_;
    let members = grp.members;
    if (placed) {
      const centre = (m: number): Pt => ({ x: ((m % cols) + 0.5) * size, y: (Math.floor(m / cols) + 0.5) * size });
      let ox = 0;
      let oy = 0;
      for (const m of from) {
        ox += centre(m).x / from.size;
        oy += centre(m).y / from.size;
      }
      const reach = 2 * size * (1 + 0.2 * (from.size - 1));
      members = members.filter((m) => Math.hypot(centre(m).x - ox, centre(m).y - oy) <= reach);
    }
    this.wave.start(gid, members, [...from], cols, size, now);
  }

  /** The group under a board point, on the table or in the open tray (-1: none). */
  private groupUnder(p: Pt): number {
    const tv = this.tv();
    if (tv) {
      const c = this.toCanvas(p);
      if (insideBox(tv.panel, c.x, c.y)) {
        const t = this.trayPt(tv, c.x, c.y);
        return this.game.groupAtTray(this.openTrayId, t.x, t.y);
      }
    }
    return this.game.groupAt(p.x - this.frameX, p.y - this.frameY);
  }

  /** What a hint or a bomb at this point is, as an operation, or nothing if it would place nothing (or the piece is another player's for now). */
  private helpOp(kind: HelpKind, p: Pt): Extract<PieceOp, { t: 'hint' | 'bomb' }> | null {
    if (this.game.solved) return null;
    if (kind === 'hint') {
      const gid = this.groupUnder(p);
      if (gid < 0 || this.chosenBy(gid)) return null;
      return { t: 'hint', piece: this.game.groups.get(gid)!.members[0] };
    }
    const tv = this.tv();
    if (tv && insideBox(tv.panel, this.toCanvas(p).x, this.toCanvas(p).y)) return null;           // (a bomb is dropped on the board)
    const at = { x: p.x - this.frameX, y: p.y - this.frameY };
    return this.game.bombHits(at.x, at.y).length ? { t: 'bomb', x: at.x, y: at.y } : null;
  }

  canHelp(kind: HelpKind, p: Pt): boolean {
    return this.helpOp(kind, p) !== null;
  }

  help(kind: HelpKind, p: Pt): void {
    const op = this.helpOp(kind, p);
    if (op && this.helped(op)) this.init.online?.send(op);
  }

  /**
   * A hint or a bomb, this player's or another's that the room has told of: the pieces it put in the picture light up (a ripple for each group of them), and a piece that was in hand and is
   * in the picture now is let go of. False if nothing was placed.
   */
  private helped(op: Extract<PieceOp, { t: 'hint' | 'bomb' }>, mine = true): boolean {
    const g = this.game;
    const was = Array.from({ length: g.count }, (_, i) => g.groups.get(g.groupOf[i])!.anchored);
    applyOp(g, op);
    const placed = was.flatMap((w, i) => (!w && g.groups.get(g.groupOf[i])!.anchored ? [i] : []));
    if (!placed.length) return false;
    if (this.drag && g.groups.get(this.drag.gid)?.anchored !== false) {          // the piece in hand is in the picture (or part of a group that is): it is let go of
      this.drag = null;
      this.cancelHover();
      this.init.online?.holding(null);
    }
    const byGroup = new Map<number, Set<number>>();
    for (const i of placed) byGroup.set(g.groupOf[i], (byGroup.get(g.groupOf[i]) ?? new Set<number>()).add(i));
    const now = performance.now();
    for (const [gid, from] of byGroup) this.startWave(gid, from, now, true);
    if (this.sel >= 0 && g.groups.get(g.groupOf[this.sel])!.anchored) this.sel = -1;
    if (mine) {
      this.buzz(g.solved ? 'solved' : 'placed');
      if (!g.solved) playEffect('placed');
    }
    this.init.traysChanged?.();
    this.init.requestDraw();
    this.init.progress?.();
    return true;
  }

  /** Commits an operation that may join groups, and gives the feedback for it: the ripple, the buzz, the end of the drag. */
  private apply(op: Exclude<PieceOp, { t: 'bomb' }>): void {
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
    this.startWave(g.groupOf[op.piece], before, performance.now(), g.anchoredCount > wasAnchored);
    if (g.anchoredCount > wasAnchored && this.sel >= 0 && g.groups.get(g.groupOf[this.sel])!.anchored) this.sel = -1;
    this.buzz(g.solved ? 'solved' : g.anchoredCount > wasAnchored ? 'placed' : 'join');
  }


  // ---------------------------------------------------------------------------------------------------------------- sorting trays

  /** The open tray on this canvas (nothing while none is open): where its panel lies, and how its space is fitted into it. Worked out again only when something it depends on changed. */
  private tv(): TrayView | null {
    if (this.openTrayId < 0 || !this.game.trays.includes(this.openTrayId) || !this.canvasW) return null;
    const dpr = window.devicePixelRatio || 1;
    const key = `${this.canvasW}x${this.canvasH}@${dpr}:${this.layout_.cols}:${this.layout_.size}`;
    if (this.trayCache?.key !== key) {
      const ts = traySize(this.layout_.cols, this.layout_.size);
      this.trayCache = { key, view: trayView(this.canvasW, this.canvasH, ts.w, ts.h, TRAY_BAR_CSS * dpr, TRAY_HEADER_CSS * dpr, TRAY_PAD_CSS * dpr) };
    }
    return this.trayCache.view;
  }

  /** A board point (what the pointer events carry) as canvas pixels. */
  private toCanvas(p: Pt): Pt {
    return { x: (p.x - this.cam.cx) * this.cam.zoom + this.canvasW / 2, y: (p.y - this.cam.cy) * this.cam.zoom + this.canvasH / 2 };
  }

  /** A canvas pixel as a point of the open tray's space. */
  private trayPt(tv: TrayView, cx: number, cy: number): Pt {
    return { x: (cx - tv.ox) / tv.scale, y: (cy - tv.oy) / tv.scale };
  }

  /** A press on the open tray: the group under it is picked up (as one on the board is), bare tray does nothing. */
  private trayDown(tv: TrayView, c: Pt, p: Pt): void {
    this.pan = null;
    const t = this.trayPt(tv, c.x, c.y);
    const gid = this.game.groupAtTray(this.openTrayId, t.x, t.y);
    if (gid < 0) return;
    const blocked = this.init.online?.blockedBy();
    if (blocked) {
      this.init.online!.notify(`${blocked} is moving a piece`);
      return;
    }
    const chosenBy = this.chosenBy(gid);
    if (chosenBy) {
      this.init.online!.notify(`${chosenBy} has chosen that piece`);
      return;
    }
    const grp = this.game.groups.get(gid)!;
    this.commit({ t: 'grab', piece: grp.members[0] });
    this.init.online?.holding(grp.members[0]);
    this.sel = grp.members[0];
    const [px, py] = this.game.toSolved(grp, t.x, t.y);
    const q = this.world(p);
    this.drag = { gid, px, py, qx: q.x - this.frameX, qy: q.y - this.frameY, cx: c.x, cy: c.y, moved: false, lift: 0, t0: performance.now(), k: 1 };
    this.buzz('grab');
    this.init.requestDraw();
  }

  /** The trays have changed (one was made or taken away, or the board was replaced): a tray that is not there any more is not open, and the page's list is made again. */
  private trayListChanged(): void {
    if (this.openTrayId >= 0 && !this.game.trays.includes(this.openTrayId)) this.openTrayId = -1;
    this.trayCache = null;
    this.init.traysChanged?.();
    this.init.requestDraw();
  }

  trays(): { id: number; pieces: number; open: boolean }[] {
    return this.game.trays.map((id) => ({ id, pieces: this.game.piecesIn(id), open: id === this.openTrayId }));
  }

  /** Opens a tray on this screen (the one that was open closes), or closes it (-1, or the one that is open). Nobody else's screen is changed. */
  openTray(id: number): void {
    this.openTrayId = id >= 0 && this.game.trays.includes(id) && id !== this.openTrayId ? id : -1;
    this.trayCache = null;
    this.init.traysChanged?.();
    this.init.requestDraw();
  }

  /** Adds a tray. With others it is the room that says which id it gets, and every screen (this one too) gets it from the room's word. */
  addTray(): void {
    if (this.game.trays.length >= TRAY_MAX) return;
    if (this.init.online) this.init.online.send({ t: 'trayAdd' });
    else {
      applyOp(this.game, { t: 'trayAdd' });
      this.trayListChanged();
    }
  }

  /** Takes an empty tray away (the page offers it only for an empty one). */
  removeTray(id: number): void {
    if (!this.game.trays.includes(id) || this.game.piecesIn(id) > 0) return;
    if (this.init.online) this.init.online.send({ t: 'trayRemove', tray: id });
    else {
      applyOp(this.game, { t: 'trayRemove', tray: id });
      this.trayListChanged();
    }
  }

  /** Where the open tray lies, in CSS pixels, for the page to put its title and buttons over the header. */
  trayPanel(): { x: number; y: number; w: number; h: number; header: number; id: number; pieces: number } | null {
    const tv = this.tv();
    if (!tv) return null;
    const dpr = window.devicePixelRatio || 1;
    return { x: tv.panel.x / dpr, y: tv.panel.y / dpr, w: tv.panel.w / dpr, h: tv.panel.h / dpr, header: tv.header.h / dpr, id: this.openTrayId, pieces: this.game.piecesIn(this.openTrayId) };
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
    const op = ev.op as JigsawOp | undefined;
    if (!op) return;                                              // a piece let go without moving: nothing changed on the board
    if (op.t === 'trayAdd' || op.t === 'trayRemove') {          // a tray was made or taken away (by anyone: the room told us, in its own order)
      applyOp(this.game, op);
      this.trayListChanged();
      return;
    }
    if (op.t === 'hint' || op.t === 'bomb') {
      this.helped(op, false);
      return;
    }
    const g = this.game;
    const gid = g.groupOf[op.piece];
    if (this.drag?.gid === gid) {                                 // this player was holding it, but the room says it is another's: what they did here no longer counts
      this.drag = null;
      this.cancelHover();
      this.init.online?.holding(null);
    }
    const before = new Set(g.groups.get(gid)?.members ?? []);
    const wasAnchored = g.anchoredCount;
    const wasGroups = g.groups.size;
    applyOp(g, op);
    if (g.groups.size < wasGroups) this.startWave(g.groupOf[op.piece], before, performance.now(), g.anchoredCount > wasAnchored);
    if (g.anchoredCount > wasAnchored && this.sel >= 0 && g.groups.get(g.groupOf[this.sel])!.anchored) this.sel = -1;
    this.init.traysChanged?.();
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
      this.game.restore(state.game as JigsawState);
    } catch {
      return;                                                     // (the room's board is this puzzle's: this does not happen)
    }
    this.forgetPictures();
    this.trayListChanged();
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
      this.game.setLocation(had.gid, had.truth.tray, had.truth.dx, had.truth.dy, had.truth.rot);
      this.hands.delete(by);
      this.init.traysChanged?.();
    }
    if (!pose) {
      this.init.requestDraw();
      return;
    }
    const gid = this.game.groupOf[pose.piece];
    const grp = this.game.groups.get(gid);
    if (!grp || grp.anchored) return;
    const target = { dx: pose.dx, dy: pose.dy, rot: pose.rot, tray: pose.tray !== undefined && this.game.trays.includes(pose.tray) ? pose.tray : -1 };
    const mine = this.hands.get(by);
    if (mine) mine.target = target;
    else {
      const truth = { dx: grp.dx, dy: grp.dy, rot: grp.rot, tray: grp.tray };
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
      // (a piece that goes into a tray, or comes out of one, jumps: the two spaces are not on the same scale)
      h.cur = h.target.tray !== h.cur.tray ? { ...h.target } : { dx: h.cur.dx + gx * k, dy: h.cur.dy + gy * k, rot: h.target.rot, tray: h.target.tray };
      this.game.setLocation(h.gid, h.cur.tray, h.cur.dx, h.cur.dy, h.cur.rot);
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
