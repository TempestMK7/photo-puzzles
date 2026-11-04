import { orientationOf, type Mp4Orientation } from '../mp4';

/**
 * A video that was filmed with the phone upright has its picture stored sideways, with a note in the file that says how far to turn it. A browser turns it by that when it draws the video
 * (`drawImage`, the video element), but on some phones (a Samsung Galaxy S23's WebView, for one) the picture that `texImage2D` is given is the stored one, not turned. The players' own device is
 * not known to us, so each video is asked: the same frame is drawn both ways in a small throwaway context and the quarter turn that makes the texture look like what `drawImage` made is the one
 * the shaders then use (`upright`).
 */

/** Where the point `p` of the upright picture is in the texture, when the texture is `k` quarter turns off (k = 1: the picture's top is at the texture's left). */
export const UPRIGHT_GLSL = `
vec2 upright(vec2 p, int k) {
  if (k == 1) return vec2(p.y, 1.0 - p.x);
  if (k == 2) return vec2(1.0 - p.x, 1.0 - p.y);
  if (k == 3) return vec2(1.0 - p.y, p.x);
  return p;
}`;

const SIDE = 16;

/** The quarter turn whose picture differs least from the reference (mean squared differences, one for each of 0..3), or 0 when no turn is clearly better than none. */
export function pickTurn(errors: number[]): number {
  let best = 0;
  for (let k = 1; k < 4; k++) if (errors[k] < errors[best]) best = k;
  return errors[0] <= 40 || errors[0] <= errors[best] * 2 ? 0 : best;
}

const luma = (px: Uint8ClampedArray | Uint8Array, i: number): number => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];

/** How far the browser's texture of this video's current frame is from upright, in quarter turns (0..3), or null when that cannot be told yet (no frame, or a frame without anything in it to tell by). */
export function detectTurn(video: HTMLVideoElement): number | null {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const flat = document.createElement('canvas');
  flat.width = flat.height = SIDE;
  const g2 = flat.getContext('2d', { willReadFrequently: true });
  const gc = document.createElement('canvas');
  gc.width = gc.height = SIDE;
  const gl = gc.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!g2 || !gl) return null;
  try {
    g2.drawImage(video, 0, 0, SIDE, SIDE);
    const ref = g2.getImageData(0, 0, SIDE, SIDE).data;
    let mean = 0;
    for (let i = 0; i < SIDE * SIDE; i++) mean += luma(ref, i * 4);
    mean /= SIDE * SIDE;
    let variance = 0;
    for (let i = 0; i < SIDE * SIDE; i++) variance += (luma(ref, i * 4) - mean) ** 2;
    if (variance / (SIDE * SIDE) < 60) return null;                         // (a black or flat frame: the turn cannot be seen in it)

    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nvoid main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es\nprecision highp float;\nuniform sampler2D t;\nuniform int k;\nout vec4 o;${UPRIGHT_GLSL}\nvoid main() { vec2 p = vec2(gl_FragCoord.x, ${SIDE}.0 - gl_FragCoord.y) / ${SIDE}.0; o = texture(t, upright(p, k)); }`));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program');
    gl.useProgram(prog);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.viewport(0, 0, SIDE, SIDE);
    const px = new Uint8Array(SIDE * SIDE * 4);
    const errors: number[] = [];
    for (let k = 0; k < 4; k++) {
      gl.uniform1i(gl.getUniformLocation(prog, 'k'), k);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, SIDE, SIDE, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let err = 0;
      for (let y = 0; y < SIDE; y++) {
        for (let x = 0; x < SIDE; x++) {
          // (readPixels starts at the bottom row)
          err += (luma(px, ((SIDE - 1 - y) * SIDE + x) * 4) - luma(ref, (y * SIDE + x) * 4)) ** 2;
        }
      }
      errors.push(err / (SIDE * SIDE));
    }
    return pickTurn(errors);
  } catch {
    return null;
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const CACHE = 'photo-puzzles/videoturn/v1';

/** What a device does for a video of this codec that is stored this far turned, as the WebView of this version (an update can change it, and so can the decoder a codec gets) turns the texture. */
export const turnKey = (userAgent: string, o: Mp4Orientation): string => `${/Chrome\/(\d+)/.exec(userAgent)?.[1] ?? '?'}|${o.codec}|${o.rotation}`;

function cached(storage: Storage | null): Record<string, number> {
  try {
    const raw = JSON.parse(storage?.getItem(CACHE) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v === 0 || v === 1 || v === 2 || v === 3)) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * How far the texture of one video is turned, for a renderer to pass to its shader (`value`). A video whose file says it is not turned needs no look (nearly all of them). One that says it
 * is turned is looked at once for each codec and amount of turn on this device and WebView version, and the answer is kept in local storage for the next. A file that says nothing
 * (not an MP4, or no header that could be read) is looked at while it plays, each time. Call `frame()` after each new picture of the video is given to the graphics card.
 */
export class VideoTurn {
  value = 0;
  private done = false;
  private tries = 0;
  private readonly o: Mp4Orientation | undefined;
  private readonly key: string | null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage,
  ) {
    this.o = orientationOf(video);
    this.key = this.o && this.o.rotation !== 0 ? turnKey(navigator.userAgent, this.o) : null;
    if (this.o?.rotation === 0) this.done = true;
    else if (this.key) {
      const k = cached(storage)[this.key];
      if (k !== undefined) {
        this.value = k;
        this.done = true;
      }
    }
  }

  frame(): void {
    if (this.done || this.tries >= 12) return;
    this.tries++;                                                       // (a black or flat picture says nothing: the next ones are tried, a few times)
    const k = detectTurn(this.video);
    if (k === null) return;
    this.value = k;
    this.done = true;
    if (!this.key) return;
    try {
      this.storage?.setItem(CACHE, JSON.stringify({ ...cached(this.storage), [this.key]: k }));
    } catch {
      // private mode or full: it is looked at again next time
    }
  }
}
