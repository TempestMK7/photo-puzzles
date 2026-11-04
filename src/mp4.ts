/** What an MP4 or MOV file says about how its video is to be shown: the turn in the video track's matrix, and the track's codec (`hvc1`, `avc1`, `vp09`, `av01`...). */
export interface Mp4Orientation {
  /** Degrees clockwise that the picture is stored off from upright, in steps of 90 (0, 90, 180, 270); the matrix' own sign convention. */
  rotation: number;
  codec: string;
}

const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32 = (b: Uint8Array, o: number): number => (u32(b, o) | 0);
const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

type Box = [string, number, number];

/** The boxes between `from` and `to` of `b`: [type, payload start, payload end]. A box that does not fit ends the list. */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32(b, p);
    let head = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12);
      head = 16;
    } else if (size === 0) size = to - p;
    if (size < head || p + size > to) break;
    out.push([fourcc(b, p + 4), p + head, p + size]);
    p += size;
  }
  return out;
}

/** The box at the end of a path of box types below `box` (`path(b, mdia, 'minf', 'stbl')`), if there is one. */
const path = (b: Uint8Array, box: Box | undefined, ...types: string[]): Box | undefined => types.reduce<Box | undefined>((at, type) => at && boxes(b, at[1], at[2]).find((x) => x[0] === type), box);

/** The orientation from the bytes of a `moov` box (its payload), or null if there is no video track in it or its matrix is not a plain turn. */
export function parseMoov(b: Uint8Array): Mp4Orientation | null {
  for (const trak of boxes(b, 0, b.length).filter((x) => x[0] === 'trak')) {
    const hdlr = path(b, trak, 'mdia', 'hdlr');
    if (!hdlr || fourcc(b, hdlr[1] + 8) !== 'vide') continue;
    const tkhd = path(b, trak, 'tkhd');
    if (!tkhd) return null;
    const m = tkhd[1] + (b[tkhd[1]] === 1 ? 52 : 40);                 // the matrix: after the times, the track's id, the length, the layer, the group and the volume
    if (m + 36 > tkhd[2]) return null;
    const [a, bb, c, d] = [i32(b, m), i32(b, m + 4), i32(b, m + 12), i32(b, m + 16)].map((x) => x / 65536);
    const rotation = ((Math.round((Math.atan2(bb, a) * 180) / Math.PI / 90) * 90) % 360 + 360) % 360;
    const turned = Math.abs(a * d - bb * c - 1) < 0.01 && Math.abs(Math.hypot(a, bb) - 1) < 0.01;        // (a mirror, or a scale, is not a turn)
    const stsd = path(b, trak, 'mdia', 'minf', 'stbl', 'stsd');
    return turned ? { rotation, codec: stsd && stsd[1] + 16 <= stsd[2] ? fourcc(b, stsd[1] + 12) : '' } : null;
  }
  return null;
}

/** Reads the orientation from a file's header (the `moov` box, wherever in the file it is: a phone's recording has it at the end). Null if the file is not an MP4 or MOV, or says nothing. */
export async function readMp4Orientation(file: Blob): Promise<Mp4Orientation | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (head.length < 16 || fourcc(head, 4) !== 'ftyp') return null;
    let p = 0;
    while (p + 16 <= file.size) {
      const h = new Uint8Array(await file.slice(p, p + 16).arrayBuffer());
      let size = u32(h, 0);
      let headLen = 8;
      if (size === 1) {
        size = u32(h, 8) * 2 ** 32 + u32(h, 12);
        headLen = 16;
      } else if (size === 0) size = file.size - p;
      if (size < headLen) return null;
      if (fourcc(h, 4) === 'moov') {
        if (size > 64 * 1024 * 1024) return null;
        return parseMoov(new Uint8Array(await file.slice(p + headLen, p + size).arrayBuffer()));
      }
      p += size;
    }
  } catch {
    // unreadable: the video is then looked at while it plays
  }
  return null;
}

/** What the file of a video says, put on its element by whoever opened it, for the renderers (`sessions/videoTurn.ts`); a video that has none is looked at while it plays. */
const noted = new WeakMap<HTMLVideoElement, Mp4Orientation>();

export function noteOrientation(video: HTMLVideoElement, o: Mp4Orientation | null): void {
  if (o) noted.set(video, o);
}

export const orientationOf = (video: HTMLVideoElement): Mp4Orientation | undefined => noted.get(video);
