import type { View } from '../render';

/**
 * A layer drawn on the graphics card for puzzles made from a video. Getting a picture of a playing video into a 2D canvas costs 25-40 ms on a slow device however small the
 * piece, whereas giving it to the graphics card as a texture costs about a millisecond; so such a puzzle builds its pieces as triangles (board position + where in the
 * picture they take their colour from) and this layer draws them on a canvas of its own that lies over the board's, as the video jigsaw does.
 *
 * A frame is: `begin`, then any number of `quad` / `tri` / `seg` / `rect` calls (in drawing order), then `end`.
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

// a vertex colour with a negative alpha means "the video's colour, times the red channel" (1 = as it is, less = dimmed); otherwise a flat colour
const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_video;
in vec2 v_uv;
in vec4 v_col;
out vec4 o;
void main() {
  if (v_col.a < 0.0) o = vec4(texture(u_video, v_uv).rgb * v_col.r, 1.0);
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
  private uRes: WebGLUniformLocation | null = null;
  private uXf: WebGLUniformLocation | null = null;
  private hasFrame = false;
  private lastTime = -1;
  private data = new Float32Array(FLOATS * 6 * 256);
  private n = 0;                        // floats used
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
    this.hasFrame = false;
    this.lastTime = -1;
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
  tri(x0: number, y0: number, u0: number, v0: number, x1: number, y1: number, u1: number, v1: number, x2: number, y2: number, u2: number, v2: number, dim = 1): void {
    this.room(FLOATS * 3);
    this.vertex(x0, y0, u0, v0, dim, 0, 0, -1);
    this.vertex(x1, y1, u1, v1, dim, 0, 0, -1);
    this.vertex(x2, y2, u2, v2, dim, 0, 0, -1);
  }

  /** A rectangle of the picture. */
  quad(x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, dim = 1): void {
    this.tri(x, y, u0, v0, x + w, y, u1, v0, x, y + h, u0, v1, dim);
    this.tri(x + w, y, u1, v0, x + w, y + h, u1, v1, x, y + h, u0, v1, dim);
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform2f(this.uRes, this.width, this.height);
    gl.uniform3f(this.uXf, this.view.scale, this.view.ox, this.view.oy);
    gl.drawArrays(gl.TRIANGLES, 0, this.n / FLOATS);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
