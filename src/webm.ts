/**
 * A minimal WebM (Matroska) writer for one video track, so that pictures encoded by the browser (WebCodecs gives bare VP8 frames) can be put in a file a <video> element
 * plays. The file has a known length, a block timecode for every frame and cues at the start of each cluster, so it can be seeked and looped like any other video.
 */

type Bytes = Uint8Array;

function concat(parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An element id, as the bytes it is written with (ids carry their own length marker). */
function idBytes(id: number): Bytes {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Uint8Array.from(out);
}

/** A size as an 8-byte variable-length integer (always 8 bytes, so a size never has to be worked out before the data is). */
function sizeBytes(n: number): Bytes {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7; i >= 1; i--) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
}

function element(id: number, data: Bytes): Bytes {
  return concat([idBytes(id), sizeBytes(data.length), data]);
}

function uint(id: number, value: number): Bytes {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  if (!out.length) out.push(0);
  return element(id, Uint8Array.from(out));
}

function float64(id: number, value: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return element(id, out);
}

function text(id: number, s: string): Bytes {
  return element(id, new TextEncoder().encode(s));
}

// element ids
const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const CUES = 0x1c53bb6b;

interface Frame {
  /** Milliseconds from the start. */
  ms: number;
  key: boolean;
  data: Bytes;
}

export class WebmWriter {
  private frames: Frame[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    /** The Matroska codec id of the frames: "V_VP8" or "V_VP9". */
    private readonly codec = 'V_VP8',
  ) {}

  /** Adds an encoded frame; the first one must be a key frame, and every cluster begins at one (the writer starts a new cluster at a key frame two seconds on). */
  add(data: Bytes, timestampUs: number, key: boolean): void {
    this.frames.push({ ms: Math.round(timestampUs / 1000), key, data: new Uint8Array(data) });
  }

  get count(): number {
    return this.frames.length;
  }

  /** The finished file; `durationMs` is the length of the video (the last frame ends there). */
  finish(durationMs: number): Blob {
    const ebml = element(
      EBML,
      concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'webm'), uint(0x4287, 2), uint(0x4285, 2)]),
    );
    const info = element(INFO, concat([uint(0x2ad7b1, 1000000), float64(0x4489, durationMs), text(0x4d80, 'puzzlevidio'), text(0x5741, 'puzzlevidio')]));
    const tracks = element(
      TRACKS,
      element(0xae, concat([uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), uint(0x9c, 0), text(0x86, this.codec), element(0xe0, concat([uint(0xb0, this.width), uint(0xba, this.height)]))])),
    );

    // clusters: a new one at each key frame that is two seconds or more after the start of the last
    const clusters: { start: number; blocks: Bytes[] }[] = [];
    for (const f of this.frames) {
      let c = clusters[clusters.length - 1];
      if (!c || (f.key && f.ms - c.start >= 2000)) {
        c = { start: f.ms, blocks: [] };
        clusters.push(c);
      }
      const rel = f.ms - c.start;
      const head = Uint8Array.from([0x81, (rel >> 8) & 0xff, rel & 0xff, f.key ? 0x80 : 0x00]);
      c.blocks.push(element(0xa3, concat([head, f.data])));
    }
    const clusterBytes = clusters.map((c) => element(CLUSTER, concat([uint(0xe7, c.start), ...c.blocks])));

    // cues: where each cluster begins, from the start of the segment's data
    let at = info.length + tracks.length;
    const cuePoints: Bytes[] = [];
    clusters.forEach((c, i) => {
      cuePoints.push(element(0xbb, concat([uint(0xb3, c.start), element(0xb7, concat([uint(0xf7, 1), uint(0xf1, at)]))])));
      at += clusterBytes[i].length;
    });
    const cues = element(CUES, concat(cuePoints));
    return new Blob([ebml as BlobPart, element(SEGMENT, concat([info, tracks, ...clusterBytes, cues])) as BlobPart], { type: 'video/webm' });
  }
}
