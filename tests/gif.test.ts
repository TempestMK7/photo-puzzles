import { describe, expect, it } from 'vitest';
import { frameMs, isGifFile } from '../src/gif';
import { WebmWriter } from '../src/webm';

describe('GIF helpers', () => {
  it('recognises a GIF by its type, or by its name when the system gives no type', () => {
    expect(isGifFile({ name: 'a.gif', type: 'image/gif' })).toBe(true);
    expect(isGifFile({ name: 'a.GIF', type: '' })).toBe(true);
    expect(isGifFile({ name: 'a.gif', type: 'application/octet-stream' })).toBe(true);
    expect(isGifFile({ name: 'a.png', type: 'image/png' })).toBe(false);
    expect(isGifFile({ name: 'giffy.mp4', type: 'video/mp4' })).toBe(false);
  });

  it('shows a frame for as long as the GIF says, but a delay under 20 ms (0 or 10 ms) for 100 ms, as browsers do', () => {
    expect(frameMs(40_000)).toBe(40);
    expect(frameMs(20_000)).toBe(20);
    expect(frameMs(10_000)).toBe(100);
    expect(frameMs(0)).toBe(100);
    expect(frameMs(null)).toBe(100);
    expect(frameMs(undefined)).toBe(100);
    expect(frameMs(2_500_000)).toBe(2500);
  });
});

// ---- a small EBML reader, enough to check what the writer wrote
interface El {
  id: number;
  start: number;          // of the data
  end: number;
}

function read(buf: Uint8Array, pos: number): El {
  let id = 0;
  const first = buf[pos];
  const idLen = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : 4;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];
  pos += idLen;
  const sizeLen = Math.clz32(buf[pos]) - 23;                    // leading zeros of the byte, plus one
  let size = buf[pos] & (0xff >> sizeLen);
  for (let i = 1; i < sizeLen; i++) size = size * 256 + buf[pos + i];
  pos += sizeLen;
  return { id, start: pos, end: pos + size };
}

function children(buf: Uint8Array, el: El): El[] {
  const out: El[] = [];
  for (let at = el.start; at < el.end; ) {
    const c = read(buf, at);
    out.push(c);
    at = c.end;
  }
  return out;
}

const num = (buf: Uint8Array, el: El): number => {
  let v = 0;
  for (let i = el.start; i < el.end; i++) v = v * 256 + buf[i];
  return v;
};

describe('WebmWriter', () => {
  async function write(frames: { ms: number; key: boolean; n: number }[], durationMs: number) {
    const w = new WebmWriter(320, 240, 'V_VP8');
    for (const f of frames) w.add(new Uint8Array(f.n).fill(f.n & 0xff), f.ms * 1000, f.key);
    return new Uint8Array(await w.finish(durationMs).arrayBuffer());
  }
  // 30 frames of 100 ms, a key frame every 10th
  const frames = Array.from({ length: 30 }, (_, i) => ({ ms: i * 100, key: i % 10 === 0, n: 20 + i }));

  it('writes an EBML header for a webm, then one segment holding info, the track, clusters and cues', async () => {
    const buf = await write(frames, 3000);
    const head = read(buf, 0);
    expect(head.id).toBe(0x1a45dfa3);
    expect(new TextDecoder().decode(buf.subarray(head.start, head.end))).toContain('webm');
    const segment = read(buf, head.end);
    expect(segment.id).toBe(0x18538067);
    expect(segment.end).toBe(buf.length);
    const ids = children(buf, segment).map((c) => c.id);
    expect(ids[0]).toBe(0x1549a966);
    expect(ids[1]).toBe(0x1654ae6b);
    expect(ids.slice(2, -1).every((id) => id === 0x1f43b675)).toBe(true);
    expect(ids[ids.length - 1]).toBe(0x1c53bb6b);
  });

  it('says how long the video is and what size and codec it is', async () => {
    const buf = await write(frames, 3000);
    const segment = read(buf, read(buf, 0).end);
    const [info, tracks] = children(buf, segment);
    const duration = children(buf, info).find((c) => c.id === 0x4489)!;
    expect(new DataView(buf.buffer, duration.start, 8).getFloat64(0)).toBe(3000);
    const entry = children(buf, children(buf, tracks)[0]);
    expect(new TextDecoder().decode(buf.subarray(entry.find((c) => c.id === 0x86)!.start, entry.find((c) => c.id === 0x86)!.end))).toBe('V_VP8');
    const video = children(buf, entry.find((c) => c.id === 0xe0)!);
    expect(num(buf, video.find((c) => c.id === 0xb0)!)).toBe(320);
    expect(num(buf, video.find((c) => c.id === 0xba)!)).toBe(240);
  });

  it('puts every frame in a block with its time, starts a cluster at a key frame two seconds on, and flags the key frames', async () => {
    const buf = await write(frames, 3000);
    const segment = read(buf, read(buf, 0).end);
    const clusters = children(buf, segment).filter((c) => c.id === 0x1f43b675);
    expect(clusters.length).toBe(2);                           // frames at 0 and 2000 are key frames; the second is >= 2000 ms after the first cluster's start
    const times: number[] = [];
    const keys: boolean[] = [];
    for (const cl of clusters) {
      const parts = children(buf, cl);
      const start = num(buf, parts.find((c) => c.id === 0xe7)!);
      for (const b of parts.filter((c) => c.id === 0xa3)) {
        expect(buf[b.start]).toBe(0x81);
        const rel = (buf[b.start + 1] << 8) | buf[b.start + 2];
        times.push(start + rel);
        keys.push((buf[b.start + 3] & 0x80) !== 0);
      }
    }
    expect(times).toEqual(frames.map((f) => f.ms));
    expect(keys).toEqual(frames.map((f) => f.key));
    // the first frame's bytes are what was given
    const first = children(buf, clusters[0]).filter((c) => c.id === 0xa3)[0];
    expect(first.end - (first.start + 4)).toBe(frames[0].n);
  });

  it('has cues that point at the start of each cluster, so the video can be moved about in', async () => {
    const buf = await write(frames, 3000);
    const segment = read(buf, read(buf, 0).end);
    const kids = children(buf, segment);
    const cues = kids[kids.length - 1];
    const points = children(buf, cues);
    const clusters = kids.filter((c) => c.id === 0x1f43b675);
    expect(points.length).toBe(clusters.length);
    points.forEach((pt, i) => {
      const parts = children(buf, pt);
      const time = num(buf, parts.find((c) => c.id === 0xb3)!);
      const pos = children(buf, parts.find((c) => c.id === 0xb7)!);
      const where = num(buf, pos.find((c) => c.id === 0xf1)!);
      expect(read(buf, segment.start + where).id).toBe(0x1f43b675);
      expect(segment.start + where + 12).toBe(clusters[i].start);          // (id 4 bytes + 8 size bytes)
      expect(time).toBe(i === 0 ? 0 : 2000);
    });
  });
});
