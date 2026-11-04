import { describe, expect, it } from 'vitest';
import { parseMoov, readMp4Orientation } from '../src/mp4';
import { turnKey } from '../src/sessions/videoTurn';

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type: string, ...parts: number[][]): number[] => {
  const body = parts.flat();
  return [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
};
const fixed = (x: number): number[] => u32(Math.round(x * 65536) >>> 0);

/** A video track (or another kind) with a matrix of [a b; c d], version 0 or 1 of the track header, and a sample entry of `codec`. */
function trak(handler: string, [a, b, c, d]: number[], codec = 'hvc1', version = 0): number[] {
  const times = version === 1 ? new Array(32).fill(0) : new Array(20).fill(0);
  const tkhd = box('tkhd', [version, 0, 0, 0], times.slice(0, version === 1 ? 32 : 20), new Array(8).fill(0), new Array(8).fill(0), [...fixed(a), ...fixed(b), 0, 0, 0, 0, ...fixed(c), ...fixed(d), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]);
  const hdlr = box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], [...handler].map((ch) => ch.charCodeAt(0)), new Array(13).fill(0));
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box(codec, new Array(8).fill(0)));
  return box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))));
}

describe('the orientation in an MP4', () => {
  it('is the turn of the video track\'s matrix and the codec of its samples (a phone held upright)', () => {
    const moov = box('moov', trak('soun', [1, 0, 0, 1], 'mp4a'), trak('vide', [0, 1, -1, 0]));
    expect(parseMoov(new Uint8Array(moov.slice(8)))).toEqual({ rotation: 90, codec: 'hvc1' });
  });

  it('reads the other turns, and the longer header of version 1', () => {
    const of = (m: number[], v = 0) => parseMoov(new Uint8Array(box('moov', trak('vide', m, 'avc1', v)).slice(8)));
    expect(of([1, 0, 0, 1])).toEqual({ rotation: 0, codec: 'avc1' });
    expect(of([-1, 0, 0, -1])?.rotation).toBe(180);
    expect(of([0, -1, 1, 0])?.rotation).toBe(270);
    expect(of([0, -1, 1, 0], 1)).toEqual({ rotation: 270, codec: 'avc1' });
  });

  it('says nothing of a mirror, a scale, or a file with no video track', () => {
    const of = (m: number[]) => parseMoov(new Uint8Array(box('moov', trak('vide', m)).slice(8)));
    expect(of([-1, 0, 0, 1])).toBeNull();
    expect(of([2, 0, 0, 2])).toBeNull();
    expect(parseMoov(new Uint8Array(box('moov', trak('soun', [1, 0, 0, 1])).slice(8)))).toBeNull();
  });

  it('is found in a file whose moov comes after a big mdat (as a phone records it), and in none that is not an MP4', async () => {
    const ftyp = box('ftyp', [...'isom'].map((c) => c.charCodeAt(0)), u32(0));
    const file = new Blob([new Uint8Array([...ftyp, ...box('mdat', new Array(5000).fill(7)), ...box('moov', trak('vide', [0, 1, -1, 0]))])]);
    expect(await readMp4Orientation(file)).toEqual({ rotation: 90, codec: 'hvc1' });
    expect(await readMp4Orientation(new Blob([new Uint8Array(100)]))).toBeNull();
    expect(await readMp4Orientation(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]))).toBeNull();      // a webm
  });
});

describe('what is kept about a device\'s textures', () => {
  it('is for each browser version, codec and turn', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/156.0.8078.47 Mobile Safari/537.36';
    expect(turnKey(ua, { rotation: 90, codec: 'hvc1' })).toBe('156|hvc1|90');
    expect(turnKey(ua, { rotation: 270, codec: 'avc1' })).toBe('156|avc1|270');
    expect(turnKey('something else', { rotation: 90, codec: '' })).toBe('?||90');
  });
});
