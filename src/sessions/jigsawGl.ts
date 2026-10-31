import type { Masks } from './jigsawArt';

/**
 * Drawing jigsaw pieces from a picture that keeps changing (a video). Cutting thousands of shaped pieces out of every video frame with the 2D canvas would be far too
 * slow, so the graphics card does it: the video frame is a texture, the piece shapes (made once) are two more, and every piece is one instance of a quad that looks its
 * picture up in the video through its shape. A whole frame is one draw call however many pieces there are.
 */

/** What a group looks like to the renderer. */
/** The open sorting tray, for `render`: its panel on the canvas (and how much of its top is header), how its space is fitted in, and what lies in it. */
export interface GlTray {
  box: { x: number; y: number; w: number; h: number };
  header: number;
  scale: number;
  ox: number;
  oy: number;
  groups: GlGroup[];
  selected: GlGroup | null;
  glows: { group: GlGroup; rgb: [number, number, number] }[];
}

export interface GlGroup {
  members: number[];
  rot: number;
  dx: number;
  dy: number;
}

export interface GlLayout {
  cols: number;
  rows: number;
  size: number;
  cropX: number;
  cropY: number;
}

export interface GlView {
  width: number;
  height: number;
  scale: number;
  ox: number;
  oy: number;
  /** Where the picture's top-left corner lies in the world. */
  frameX: number;
  frameY: number;
  /** A light background: the selection glow is then orange (a yellow one would hardly show). */
  light?: boolean;
}

let support: boolean | null = null;

/** Can this browser draw video pieces on the graphics card (WebGL 2)? */
export function glAvailable(): boolean {
  if (support === null) {
    try {
      support = !!document.createElement('canvas').getContext('webgl2');
    } catch {
      support = false;
    }
  }
  return support;
}

const VERT = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_center;
layout(location=2) in vec2 a_rs;
layout(location=3) in vec2 a_cell;
layout(location=4) in float a_plain;
uniform vec2 u_res;
uniform vec3 u_xf;
uniform float u_tile;
uniform float u_o;
out vec2 v_tile;
out vec2 v_cell;
out float v_plain;
void main() {
  vec2 local = a_corner * u_tile - vec2(u_o);
  vec2 p = vec2(local.x * a_rs.x - local.y * a_rs.y, local.x * a_rs.y + local.y * a_rs.x);
  vec2 px = (a_center + p) * u_xf.x + u_xf.yz;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);
  v_tile = a_corner * u_tile;
  v_cell = a_cell;
  v_plain = a_plain;
}`;

const FRAG_PIECE = `#version 300 es
precision highp float;
uniform sampler2D u_video;
uniform sampler2D u_cover;
uniform sampler2D u_overlay;
uniform vec2 u_atlas;
uniform float u_pitch;
uniform vec2 u_src;
uniform float u_size;
uniform vec2 u_vid;
uniform float u_outline;
uniform float u_blur;
in vec2 v_tile;
in vec2 v_cell;
in float v_plain;
out vec4 o;
void main() {
  vec2 auv = (v_cell * u_pitch + vec2(1.0) + v_tile) / u_atlas;
  vec2 d = vec2(u_blur) / u_atlas;
  float cov = 0.25 * (texture(u_cover, auv + vec2(d.x, d.y)).a + texture(u_cover, auv + vec2(-d.x, d.y)).a
                    + texture(u_cover, auv + vec2(d.x, -d.y)).a + texture(u_cover, auv + vec2(-d.x, -d.y)).a);
  if (cov <= 0.0) discard;
  vec3 col = texture(u_video, (u_src + v_cell * u_size + v_tile) / u_vid).rgb;
  vec4 ov = texture(u_overlay, auv);
  col = mix(col, ov.rgb, ov.a * (1.0 - v_plain) * u_outline);
  o = vec4(col * cov, cov);
}`;

const FRAG_GLOW = `#version 300 es
precision highp float;
uniform sampler2D u_cover;
uniform vec2 u_atlas;
uniform float u_pitch;
uniform float u_tile;
uniform float u_r;
uniform vec3 u_glow;
in vec2 v_tile;
in vec2 v_cell;
in float v_plain;
out vec4 o;
float at(vec2 off) {
  vec2 t = v_tile + off;
  if (t.x < 0.0 || t.y < 0.0 || t.x > u_tile || t.y > u_tile) return 0.0;
  return texture(u_cover, (v_cell * u_pitch + vec2(1.0) + t) / u_atlas).a;
}
void main() {
  float a = at(vec2(0.0));
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.785398;
    vec2 dir = vec2(cos(ang), sin(ang));
    a += at(dir * u_r * 0.5) + at(dir * u_r);
  }
  a = clamp(a / 6.0, 0.0, 1.0) * 0.9;
  o = vec4(u_glow * a, a);
}`;

const COS = [1, 0, -1, 0];                // a quarter turn clockwise, y pointing down
const SIN = [0, 1, 0, -1];
const FRAG_FLASH = `#version 300 es
precision highp float;
uniform sampler2D u_cover;
uniform vec2 u_atlas;
uniform float u_pitch;
uniform float u_k;
in vec2 v_tile;
in vec2 v_cell;
in float v_plain;
out vec4 o;
void main() {
  float cov = texture(u_cover, (v_cell * u_pitch + vec2(1.0) + v_tile) / u_atlas).a * u_k;
  o = vec4(vec3(cov), cov);
}`;

const FLOATS = 7;                       // per instance: centre x, y, cos, sin, cell c, r, plain
const STRIDE = FLOATS * 4;
const GLOW_PX = 7;                      // the selection glow reaches this far, in screen pixels (less, if the piece's tile has no room)

interface Program {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

export class PieceRenderer {
  readonly canvas = document.createElement('canvas');
  private gl!: WebGL2RenderingContext;
  private lost = false;
  private piece!: Program;
  private glow!: Program;
  private flashProg!: Program;
  private cornerBuf!: WebGLBuffer;
  private instBuf!: WebGLBuffer;
  private vao!: WebGLVertexArrayObject;
  private videoTex!: WebGLTexture;
  private coverTex!: WebGLTexture;
  private overlayTex!: WebGLTexture;
  private hasFrame = false;
  private lastTime = -1;
  private mipsFresh = false;
  private mipsOn = false;
  private data = new Float32Array(0);
  /** The piece canvas has this share of the board's pixels in each direction (the browser stretches it): less work for a slow graphics card. */
  res = 1;
  private readonly vw: number;
  private readonly vh: number;

  constructor(
    private readonly masks: Masks,
    private readonly l: GlLayout,
    private readonly video: HTMLVideoElement,
  ) {
    this.vw = video.videoWidth;
    this.vh = video.videoHeight;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.setup();
      this.lost = false;
    });
    this.setup();
  }

  private compile(frag: string, names: string[]): Program {
    const gl = this.gl;
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program');
    const u: Program['u'] = {};
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return { prog, u };
  }

  private texture(source: TexImageSource | null): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return t;
  }

  /** Everything that lives on the graphics card (made again if the browser takes the context away and gives it back). */
  private setup(): void {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no WebGL 2');
    this.gl = gl;
    const shared = ['u_res', 'u_xf', 'u_tile', 'u_o', 'u_cover', 'u_atlas', 'u_pitch'];
    this.piece = this.compile(FRAG_PIECE, [...shared, 'u_video', 'u_overlay', 'u_src', 'u_size', 'u_vid', 'u_outline', 'u_blur']);
    this.glow = this.compile(FRAG_GLOW, [...shared, 'u_r', 'u_glow']);
    this.flashProg = this.compile(FRAG_FLASH, [...shared, 'u_k']);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    for (let i = 1; i <= 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.coverTex = this.texture(this.masks.cover);
    this.overlayTex = this.texture(this.masks.overlay);
    this.videoTex = this.texture(null);                           // filled by each new picture of the video
    this.hasFrame = false;
    this.lastTime = -1;
    this.mipsFresh = false;
    this.mipsOn = false;
  }

  /** Takes the video's current picture, when there is a new one. Mip levels are only made while the pieces are drawn smaller than the video. */
  private uploadVideo(needMips: boolean): void {
    const gl = this.gl;
    const v = this.video;
    if (v.readyState < 2) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    if (!this.hasFrame || v.currentTime !== this.lastTime) {
      // texImage2D, not texSubImage2D into fixed storage: on some phones and tablets the browser only has a fast way to copy a video frame for the former (3 ms against 50)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      this.lastTime = v.currentTime;
      this.hasFrame = true;
      this.mipsFresh = false;
    }
    if (needMips && !this.mipsFresh) {
      gl.generateMipmap(gl.TEXTURE_2D);
      this.mipsFresh = true;
    }
    if (needMips !== this.mipsOn) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, needMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      this.mipsOn = needMips;
    }
  }

  private room(count: number): void {
    if (this.data.length < count * FLOATS) this.data = new Float32Array(Math.max(count, this.data.length / FLOATS * 2) * FLOATS);
  }

  /**
   * Draws the pieces into the renderer's canvas (the same size as the board's) and returns it, or null if there is nothing to show yet. `loose` is back to front; the
   * `selected` group is drawn last, with a glow. `glows` are the groups that other players have in hand or have chosen: each is drawn again over the others, with a glow of its colour.
   */
  render(view: GlView, anchored: Iterable<GlGroup>, loose: Iterable<GlGroup>, selected: GlGroup | null, flash: { members: number[]; k: number } | null, glows: { group: GlGroup; rgb: [number, number, number] }[] = [], tray: GlTray | null = null): HTMLCanvasElement | null {
    if (this.lost) return null;
    const gl = this.gl;
    const { canvas, l, masks } = this;
    const w = Math.max(1, Math.round(view.width * this.res));
    const h = Math.max(1, Math.round(view.height * this.res));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const k = w / view.width;                                       // board pixels -> canvas pixels
    this.uploadVideo(view.scale * this.res < 0.75);
    if (!this.hasFrame) return null;

    // one instance for every piece on the screen
    let n = 0;
    let total = 0;
    for (const grp of anchored) total += grp.members.length;
    for (const grp of loose) total += grp.members.length;
    if (selected) total += selected.members.length;
    for (const o of glows) total += o.group.members.length;
    if (flash) total += flash.members.length;
    if (tray) {
      for (const grp of tray.groups) total += grp.members.length * 2;
      for (const o of tray.glows) total += o.group.members.length;
      if (tray.selected) total += tray.selected.members.length;
    }
    this.room(total);
    const x0 = -view.ox / view.scale;
    const y0 = -view.oy / view.scale;
    const x1 = (view.width - view.ox) / view.scale;
    const y1 = (view.height - view.oy) / view.scale;
    const half = masks.tile * 0.75;
    const data = this.data;
    const push = (grp: GlGroup, plain: number, fx = view.frameX, fy = view.frameY, cull = true): void => {
      const cs = COS[grp.rot & 3];
      const sn = SIN[grp.rot & 3];
      for (const m of grp.members) {
        const c = m % l.cols;
        const r = (m / l.cols) | 0;
        const px = (c + 0.5) * l.size;
        const py = (r + 0.5) * l.size;
        const cx = fx + grp.dx + px * cs - py * sn;
        const cy = fy + grp.dy + px * sn + py * cs;
        if (cull && (cx - half > x1 || cy - half > y1 || cx + half < x0 || cy + half < y0)) continue;
        const i = n * FLOATS;
        data[i] = cx;
        data[i + 1] = cy;
        data[i + 2] = cs;
        data[i + 3] = sn;
        data[i + 4] = c;
        data[i + 5] = r;
        data[i + 6] = plain;
        n++;
      }
    };
    for (const grp of anchored) push(grp, 1);
    for (const grp of loose) push(grp, 0);
    const nBack = n;
    const lit: { start: number; count: number; rgb: [number, number, number] }[] = [];
    for (const o of glows) {
      const start = n;
      push(o.group, 0);
      lit.push({ start, count: n - start, rgb: o.rgb });
    }
    const selStart = n;
    if (selected) push(selected, 0);
    const nSel = n - selStart;
    const flashStart = n;
    if (flash) push({ members: flash.members, rot: 0, dx: 0, dy: 0 }, 1);
    const nFlash = n - flashStart;
    // what lies in the open tray (in the tray's own space: no frame, and nothing is left out for lying off the screen)
    const trayStart = n;
    const trayLit: { start: number; count: number; rgb: [number, number, number] }[] = [];
    let nTray = 0;
    let traySelStart = 0;
    let nTraySel = 0;
    if (tray) {
      for (const grp of tray.groups) push(grp, 0, 0, 0, false);
      nTray = n - trayStart;
      for (const o of tray.glows) {
        const start = n;
        push(o.group, 0, 0, 0, false);
        trayLit.push({ start, count: n - start, rgb: o.rgb });
      }
      traySelStart = n;
      if (tray.selected) push(tray.selected, 0, 0, 0, false);
      nTraySel = n - traySelStart;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!n) return canvas;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * FLOATS), gl.DYNAMIC_DRAW);
    const atlasW = masks.cover.width;
    const atlasH = masks.cover.height;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.coverTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);

    const shared = (p: Program, sc = view.scale, ox = view.ox, oy = view.oy): void => {
      gl.useProgram(p.prog);
      gl.uniform2f(p.u.u_res, canvas.width, canvas.height);
      gl.uniform3f(p.u.u_xf, sc * k, ox * k, oy * k);
      gl.uniform1f(p.u.u_tile, masks.tile);
      gl.uniform1f(p.u.u_o, l.size / 2 + masks.pad);
      gl.uniform1i(p.u.u_cover, 1);
      gl.uniform2f(p.u.u_atlas, atlasW, atlasH);
      gl.uniform1f(p.u.u_pitch, masks.pitch);
    };
    const draw = (start: number, count: number): void => {
      if (!count) return;
      const o = start * STRIDE;                                     // the instance attributes start at this piece
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, o);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, o + 8);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE, o + 16);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, STRIDE, o + 24);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    };

    const p = this.piece;
    shared(p);
    gl.uniform1i(p.u.u_video, 0);
    gl.uniform1i(p.u.u_overlay, 2);
    gl.uniform2f(p.u.u_src, l.cropX - masks.pad, l.cropY - masks.pad);
    gl.uniform1f(p.u.u_size, l.size);
    gl.uniform2f(p.u.u_vid, this.vw, this.vh);
    gl.uniform1f(p.u.u_outline, Math.min(1, Math.max(0, (l.size * view.scale - 10) / 20)));      // lines between tiny pieces only make noise
    gl.uniform1f(p.u.u_blur, view.scale < 1 ? 0.5 / view.scale : 0);
    draw(0, nBack);
    // a group in another player's hand, or chosen by them, glows in their colour (twice as strongly: a pale halo disappears round a small piece)
    for (const o of lit) {
      const g = this.glow;
      shared(g);
      gl.uniform1f(g.u.u_r, Math.min(GLOW_PX / view.scale, masks.pad - 1));
      gl.uniform3f(g.u.u_glow, o.rgb[0], o.rgb[1], o.rgb[2]);
      draw(o.start, o.count);
      draw(o.start, o.count);
      gl.useProgram(p.prog);
      draw(o.start, o.count);
    }
    if (nSel) {
      const g = this.glow;
      shared(g);
      gl.uniform1f(g.u.u_r, Math.min(GLOW_PX / view.scale, masks.pad - 1));
      if (view.light) gl.uniform3f(g.u.u_glow, 0.9, 0.45, 0);
      else gl.uniform3f(g.u.u_glow, 1, 0.847, 0.29);
      draw(selStart, nSel);                                         // the glow of the whole group first ...
      gl.useProgram(p.prog);
      draw(selStart, nSel);                                         // ... then its pieces over it
    }
    if (nFlash && flash) {                                          // pieces that have just joined the picture light up for a moment
      const f = this.flashProg;
      shared(f);
      gl.uniform1f(f.u.u_k, 0.35 * flash.k);
      draw(flashStart, nFlash);
    }
    if (tray) {
      // the tray lies over the board: what is behind its panel is wiped out (the panel itself is drawn under this canvas), and its pieces are drawn in its own space and scale
      const b = tray.box;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(Math.round(b.x * k), Math.round(canvas.height - (b.y + b.h) * k), Math.round(b.w * k), Math.round(b.h * k));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.scissor(Math.round(b.x * k), Math.round(canvas.height - (b.y + b.h) * k), Math.round(b.w * k), Math.round((b.h - tray.header) * k));
      shared(p, tray.scale, tray.ox, tray.oy);
      gl.uniform1f(p.u.u_outline, Math.min(1, Math.max(0, (l.size * tray.scale - 10) / 20)));
      gl.uniform1f(p.u.u_blur, tray.scale < 1 ? 0.5 / tray.scale : 0);
      draw(trayStart, nTray);
      for (const o of trayLit) {
        const g = this.glow;
        shared(g, tray.scale, tray.ox, tray.oy);
        gl.uniform1f(g.u.u_r, Math.min(GLOW_PX / tray.scale, masks.pad - 1));
        gl.uniform3f(g.u.u_glow, o.rgb[0], o.rgb[1], o.rgb[2]);
        draw(o.start, o.count);
        draw(o.start, o.count);
        gl.useProgram(p.prog);
        draw(o.start, o.count);
      }
      if (nTraySel) {
        const g = this.glow;
        shared(g, tray.scale, tray.ox, tray.oy);
        gl.uniform1f(g.u.u_r, Math.min(GLOW_PX / tray.scale, masks.pad - 1));
        if (view.light) gl.uniform3f(g.u.u_glow, 0.9, 0.45, 0);
        else gl.uniform3f(g.u.u_glow, 1, 0.847, 0.29);
        draw(traySelStart, nTraySel);
        gl.useProgram(p.prog);
        draw(traySelStart, nTraySel);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    return canvas;
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
