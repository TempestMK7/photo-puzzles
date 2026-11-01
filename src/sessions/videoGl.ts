import type { View } from '../render';

/**
 * A layer drawn on the graphics card for puzzles made from a video. Getting a picture of a playing video into a 2D canvas costs 25-40 ms on a slow device however small the
 * piece, whereas giving it to the graphics card as a texture costs about a millisecond; so such a puzzle builds its pieces as triangles (board position + where in the
 * picture they take their colour from) and this layer draws them on a canvas of its own that lies over the board's, as the video jigsaw does.
 *
 * A frame is: `begin`, then any number of `quad` / `tri` / `turned` / `fill` / `frame` / `seg` calls (in drawing order), then `end`. Besides the video it can show one picture of its own
 * (`setImage`, a canvas that does not change: the empty board of Overlap), for the pieces that show that and not the video.
 *
 * The layer lies over the board's canvas, so a session draws on the board's canvas what lies under the pieces (the background, the empty board, the trays), here the pieces and what has to be
 * drawn over them, in the same order as on a 2D canvas, and on a `FrontLayer` what lies over all of it (the ripples).
 */

let support: boolean | null = null;

/** Can this browser draw such a layer (WebGL 2)? */
export function videoGlAvailable(): boolean {
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
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in vec4 a_col;
uniform vec2 u_res;
uniform vec3 u_xf;
out vec2 v_uv;
out vec4 v_col;
void main() {
  vec2 px = a_pos * u_xf.x + u_xf.yz;
  gl_Position = vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = a_uv;
  v_col = a_col;
}`;

// a vertex colour with an alpha of -1 means "the video's colour, times the red channel" (1 = as it is, less = dimmed), with -2 "the layer's own picture's"; otherwise a flat colour
const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_video;
uniform sampler2D u_img;
in vec2 v_uv;
in vec4 v_col;
out vec4 o;
void main() {
  if (v_col.a < -1.5) o = vec4(texture(u_img, v_uv).rgb * v_col.r, 1.0);
  else if (v_col.a < 0.0) o = vec4(texture(u_video, v_uv).rgb * v_col.r, 1.0);
  else o = vec4(v_col.rgb * v_col.a, v_col.a);
}`;

const FLOATS = 8;                       // per vertex: x, y, u, v, r, g, b, a

export class VideoLayer {
  readonly canvas = document.createElement('canvas');
  private gl!: WebGL2RenderingContext;
  private lost = false;
  private prog!: WebGLProgram;
  private buf!: WebGLBuffer;
  private vao!: WebGLVertexArrayObject;
  private tex!: WebGLTexture;
  private imgTex!: WebGLTexture;
  private image: HTMLCanvasElement | null = null;
  private uImg: WebGLUniformLocation | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private uXf: WebGLUniformLocation | null = null;
  private hasFrame = false;
  private lastTime = -1;
  private data = new Float32Array(FLOATS * 6 * 256);
  private n = 0;                        // floats used
  private cut = -1;                     // floats used when clipBefore was called, or -1
  private cutLeft = 0;
  private view: View = { scale: 1, ox: 0, oy: 0 };
  private width = 1;
  private height = 1;
  /** The video's size: the picture coordinates u, v are shares of it. */
  readonly vw: number;
  readonly vh: number;

  constructor(private readonly video: HTMLVideoElement) {
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

  private setup(): void {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no WebGL 2');
    this.gl = gl;
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(this.prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(this.prog);
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.prog) ?? 'program');
    this.uRes = gl.getUniformLocation(this.prog, 'u_res');
    this.uXf = gl.getUniformLocation(this.prog, 'u_xf');
    this.uImg = gl.getUniformLocation(this.prog, 'u_img');
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.imgTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.image) this.upload();
    this.hasFrame = false;
    this.lastTime = -1;
  }

  /** The layer's own picture (the pieces that show it take their u, v as shares of its size). One too big for the graphics card is shrunk to fit. */
  setImage(canvas: HTMLCanvasElement): void {
    this.image = canvas;
    if (!this.lost) this.upload();
  }

  private upload(): void {
    const gl = this.gl;
    let src: HTMLCanvasElement = this.image!;
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 8192);
    if (src.width > max || src.height > max) {
      const k = Math.min(max / src.width, max / src.height);
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.floor(src.width * k));
      small.height = Math.max(1, Math.floor(src.height * k));
      small.getContext('2d')!.drawImage(src, 0, 0, small.width, small.height);
      src = small;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  /** Starts a frame on a canvas of this size (the board's), taking the video's newest picture. False if there is nothing to draw yet. */
  begin(width: number, height: number, view: View): boolean {
    if (this.lost) return false;
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.width = width;
    this.height = height;
    this.view = view;
    const v = this.video;
    if (v.readyState >= 2 && (!this.hasFrame || v.currentTime !== this.lastTime)) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      // texImage2D, not texSubImage2D: for a video it is the fast one on some devices (3 ms against 50)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      this.hasFrame = true;
      this.lastTime = v.currentTime;
    }
    this.n = 0;
    this.cut = -1;
    return this.hasFrame;
  }

  private room(extra: number): void {
    if (this.n + extra > this.data.length) {
      const bigger = new Float32Array(Math.max(this.data.length * 2, this.n + extra));
      bigger.set(this.data.subarray(0, this.n));
      this.data = bigger;
    }
  }

  /** One vertex: board position, picture position, colour (alpha < 0: take the picture's colour, times r). */
  private vertex(x: number, y: number, u: number, v: number, r: number, g: number, b: number, a: number): void {
    const d = this.data;
    const i = this.n;
    d[i] = x;
    d[i + 1] = y;
    d[i + 2] = u;
    d[i + 3] = v;
    d[i + 4] = r;
    d[i + 5] = g;
    d[i + 6] = b;
    d[i + 7] = a;
    this.n += FLOATS;
  }

  /** A triangle of the picture: board points (x, y) taking their colour from picture points (u, v), as shares of the video's size; `dim` 1 = as it is. */
  tri(x0: number, y0: number, u0: number, v0: number, x1: number, y1: number, u1: number, v1: number, x2: number, y2: number, u2: number, v2: number, dim = 1, own = false): void {
    const a = own ? -2 : -1;
    this.room(FLOATS * 3);
    this.vertex(x0, y0, u0, v0, dim, 0, 0, a);
    this.vertex(x1, y1, u1, v1, dim, 0, 0, a);
    this.vertex(x2, y2, u2, v2, dim, 0, 0, a);
  }

  /** A rectangle of the picture. */
  quad(x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, dim = 1, own = false): void {
    this.tri(x, y, u0, v0, x + w, y, u1, v0, x, y + h, u0, v1, dim, own);
    this.tri(x + w, y, u1, v0, x + w, y + h, u1, v1, x, y + h, u0, v1, dim, own);
  }

  /**
   * A square of the picture of side 2 x `half` centred on (cx, cy), turned `turn` quarter turns clockwise with what it shows (a piece that lies turned). `own`: the layer's own
   * picture instead of the video.
   */
  turned(cx: number, cy: number, half: number, turn: number, u0: number, v0: number, u1: number, v1: number, own = false): void {
    const t = ((turn % 4) + 4) % 4;
    const c = [1, 0, -1, 0][t];
    const s = [0, 1, 0, -1][t];
    const px = (x: number, y: number): number => cx + x * c - y * s;
    const py = (x: number, y: number): number => cy + x * s + y * c;
    const h = half;
    this.tri(px(-h, -h), py(-h, -h), u0, v0, px(h, -h), py(h, -h), u1, v0, px(-h, h), py(-h, h), u0, v1, 1, own);
    this.tri(px(h, -h), py(h, -h), u1, v0, px(h, h), py(h, h), u1, v1, px(-h, h), py(-h, h), u0, v1, 1, own);
  }

  /** A flat rectangle (a colour with an opacity is laid over what is under it). */
  fill(x: number, y: number, w: number, h: number, c: readonly [number, number, number, number]): void {
    const col = c as [number, number, number, number];
    this.flatTri(x, y, x + w, y, x, y + h, col);
    this.flatTri(x + w, y, x + w, y + h, x, y + h, col);
  }

  /** The outline of a rectangle as a pen of width `t` (board units) drawn along its edge would leave it, in four pieces that do not overlap, so that a see-through colour is the same all round. */
  frame(x: number, y: number, w: number, h: number, t: number, c: readonly [number, number, number, number]): void {
    const o = t / 2;
    this.fill(x - o, y - o, w + t, t, c);
    this.fill(x - o, y + h - o, w + t, t, c);
    this.fill(x - o, y + o, t, h - t, c);
    this.fill(x + w - o, y + o, t, h - t, c);
  }

  /** A flat triangle. */
  flatTri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, rgba: [number, number, number, number]): void {
    this.room(FLOATS * 3);
    this.vertex(x0, y0, 0, 0, rgba[0], rgba[1], rgba[2], rgba[3]);
    this.vertex(x1, y1, 0, 0, rgba[0], rgba[1], rgba[2], rgba[3]);
    this.vertex(x2, y2, 0, 0, rgba[0], rgba[1], rgba[2], rgba[3]);
  }

  /** A straight line of a width, in canvas pixels (so it is as thin on a big board as on a small one), in a flat colour. */
  seg(x0: number, y0: number, x1: number, y1: number, pixels: number, rgba: [number, number, number, number]): void {
    const half = pixels / 2 / this.view.scale;
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    dx = (dx / len) * half;
    dy = (dy / len) * half;
    const nx = -dy;
    const ny = dx;
    this.flatTri(x0 - nx - dx, y0 - ny - dy, x0 + nx - dx, y0 + ny - dy, x1 + nx + dx, y1 + ny + dy, rgba);
    this.flatTri(x0 - nx - dx, y0 - ny - dy, x1 + nx + dx, y1 + ny + dy, x1 - nx + dx, y1 - ny + dy, rgba);
  }

  /** Everything added so far is drawn only where the canvas is at least `left` pixels from its left edge (what comes after is not clipped): the board, under the panel that lies beside it. */
  clipBefore(left: number): void {
    this.cut = this.n;
    this.cutLeft = Math.max(0, Math.round(left));
  }

  /** Draws everything added since `begin`. */
  end(): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.n) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n), gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.uniform1i(this.uImg, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform2f(this.uRes, this.width, this.height);
    gl.uniform3f(this.uXf, this.view.scale, this.view.ox, this.view.oy);
    const cut = this.cut >= 0 && this.cutLeft > 0 ? Math.min(this.cut, this.n) : 0;
    if (cut > 0) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(this.cutLeft, 0, Math.max(0, this.width - this.cutLeft), this.height);
      gl.drawArrays(gl.TRIANGLES, 0, cut / FLOATS);
      gl.disable(gl.SCISSOR_TEST);
    }
    if (this.n > cut) gl.drawArrays(gl.TRIANGLES, cut / FLOATS, (this.n - cut) / FLOATS);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/**
 * A transparent 2D canvas that lies over the `VideoLayer`, for what has to be drawn over the pieces and cannot be drawn on the graphics card (the ripples). It is cleared and given
 * the board's transform at the start of a frame, like the board's own canvas.
 */
export class FrontLayer {
  readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d')!;

  /** `clipLeft`: what is drawn shows only where the canvas is at least that many pixels from its left edge. */
  begin(width: number, height: number, view: View, clipLeft = 0): CanvasRenderingContext2D {
    const { canvas, ctx } = this;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.restore();                                              // the clip of the last frame (nothing to undo before the first)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (clipLeft > 0) {
      ctx.beginPath();
      ctx.rect(clipLeft, 0, Math.max(0, width - clipLeft), height);
      ctx.clip();
    }
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    return ctx;
  }
}

/** A colour as the layer takes it: red, green and blue as 0 to 255, opacity 0 to 1. */
export function rgba(r: number, g: number, b: number, a = 1): [number, number, number, number] {
  return [r / 255, g / 255, b / 255, a];
}
