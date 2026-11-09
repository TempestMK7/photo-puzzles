import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkVideoFrames, FRAME_EVERY_S, sampleTimes, type FfmpegRun } from '../server/src/frames';
import { runFfmpeg } from '../server/src/aws/videoCheck';
import { FrameVideoModeration } from '../server/src/aws/frameVideo';
import type { Moderation } from '../server/src/types';

const seeded = (): (() => number) => {
  let x = 12345;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
};

describe('sampleTimes', () => {
  it('takes one moment from each two seconds: 60 for two minutes, each inside its own stretch', () => {
    const t = sampleTimes(120, seeded());
    expect(t).toHaveLength(60);
    t.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(i * FRAME_EVERY_S);
      expect(v).toBeLessThan((i + 1) * FRAME_EVERY_S);
    });
    expect(new Set(t.map((v) => Math.round(v * 1000) % 2000)).size).toBeGreaterThan(30);                     // (random within the stretch, not always the same place)
  });

  it('counts the last short stretch, keeps inside the video, and takes none from nothing', () => {
    expect(sampleTimes(5, () => 0.999999)).toHaveLength(3);
    expect(Math.max(...sampleTimes(5, () => 0.999999))).toBeLessThan(5);
    expect(sampleTimes(1, () => 0.5)).toEqual([0.5]);
    expect(sampleTimes(0, () => 0.5)).toEqual([]);
    expect(sampleTimes(Number.NaN, () => 0.5)).toEqual([]);
    expect(sampleTimes(Infinity, () => 0.5)).toEqual([]);
  });

  it('is different each time it is given other random numbers (so that what is looked at cannot be known beforehand)', () => {
    expect(sampleTimes(40, seeded())).not.toEqual(sampleTimes(40, () => 0.5));
  });
});

/** A fake ffmpeg: the probe says what the file is, and each frame asked for comes back as bytes that carry the moment they were cut at. */
function fakeFfmpeg(about: string, opts: { noFrameAfter?: number } = {}) {
  const cut: number[] = [];
  const run = async (args: string[]): Promise<FfmpegRun> => {
    if (!args.includes('-ss')) return { code: 1, stdout: new Uint8Array(), stderr: about };
    const at = Number(args[args.indexOf('-ss') + 1]);
    cut.push(at);
    if (opts.noFrameAfter !== undefined && at > opts.noFrameAfter) return { code: 0, stdout: new Uint8Array(), stderr: '' };
    return { code: 0, stdout: new TextEncoder().encode(String(at)), stderr: '' };
  };
  return { run, cut };
}
const MP4_INFO = '  Duration: 00:02:00.00, start: 0.0, bitrate: 1000 kb/s\n  Stream #0:0: Video: h264, yuv420p, 1920x1080, 60 fps';
const ok: Moderation = { check: async () => ({ ok: true }) };

describe('checkVideoFrames', () => {
  it('looks at 60 frames of a two-minute video, once each, and passes it', async () => {
    const f = fakeFfmpeg(MP4_INFO);
    const seen: number[] = [];
    const verdict = await checkVideoFrames({ file: 'v', ffmpeg: f.run, moderation: { check: async (b) => (seen.push(Number(new TextDecoder().decode(b))), { ok: true }) }, strict: false, unit: seeded() });
    expect(verdict).toEqual({ state: 'done', ok: true, frames: 60 });
    expect(seen).toHaveLength(60);
    expect(f.cut).toHaveLength(60);
  });

  it('turns the video down at the first frame that is turned down, and says when it was (and asks no more once it is)', async () => {
    const f = fakeFfmpeg(MP4_INFO);
    let calls = 0;
    const flagged: Moderation = {
      check: async (b) => {
        calls++;
        return Number(new TextDecoder().decode(b)) >= 61 ? { ok: false, label: 'Violence / Graphic Violence' } : { ok: true };
      },
    };
    const verdict = await checkVideoFrames({ file: 'v', ffmpeg: f.run, moderation: flagged, strict: true, unit: seeded(), concurrency: 1 });
    expect(verdict).toMatchObject({ state: 'done', ok: false });
    expect((verdict as { label: string }).label).toMatch(/^Violence \/ Graphic Violence at 1:0\d$/);
    expect(calls).toBeLessThan(60);
  });

  it('passes on the stricter look to every frame when it was asked for', async () => {
    const stricts: boolean[] = [];
    await checkVideoFrames({ file: 'v', ffmpeg: fakeFfmpeg(MP4_INFO).run, moderation: { check: async (_b, _t, strict) => (stricts.push(strict ?? false), { ok: true }) }, strict: true, unit: seeded() });
    expect(new Set(stricts)).toEqual(new Set([true]));
  });

  it('says a file with no video, no length or too few frames is unreadable, and uses the length the game said for a file with none', async () => {
    const run = (about: string, o = {}) => checkVideoFrames({ file: 'v', ffmpeg: fakeFfmpeg(about, o).run, moderation: ok, strict: false, unit: seeded(), ...o });
    expect(await run('Stream #0:0: Audio: aac')).toEqual({ state: 'unreadable' });
    expect(await run('garbage')).toEqual({ state: 'unreadable' });
    expect(await run('  Stream #0:0: Video: vp9, yuv420p, 640x360')).toEqual({ state: 'unreadable' });        // (no length, and none said)
    expect(await run('  Stream #0:0: Video: vp9, yuv420p, 640x360', { declaredSeconds: 10 })).toEqual({ state: 'done', ok: true, frames: 5 });
    expect(await run(MP4_INFO, { noFrameAfter: 10 })).toEqual({ state: 'unreadable' });                           // (frames could be cut from the first few seconds only)
  });

  it('lets a failure of the look itself through (it is not the file\'s fault)', async () => {
    await expect(checkVideoFrames({ file: 'v', ffmpeg: fakeFfmpeg(MP4_INFO).run, moderation: { check: async () => { throw new Error('throttled'); } }, strict: false, unit: seeded() })).rejects.toThrow('throttled');
  });
});

describe('FrameVideoModeration', () => {
  const sent: unknown[] = [];
  const lambda = { send: async (c: { input: unknown }) => (sent.push(c.input), { StatusCode: 202 }) };
  const missing = Object.assign(new Error('no'), { name: 'NoSuchKey' });
  const bucket = (body: string | null) => ({ send: async () => { if (body === null) throw missing; return { Body: { transformToString: async () => body } }; } });

  it('starts the function without waiting for it, and reads what it wrote: nothing yet is still working', async () => {
    const m = new FrameVideoModeration(lambda as never, bucket(null) as never, 'b', 'fn');
    expect(await m.start('room1', true, 12)).toEqual({ jobId: 'room1' });
    expect(sent[0]).toMatchObject({ FunctionName: 'fn', InvocationType: 'Event' });
    expect(JSON.parse(new TextDecoder().decode((sent[0] as { Payload: Uint8Array }).Payload))).toEqual({ roomId: 'room1', strict: true, seconds: 12 });
    expect(await m.result('room1')).toEqual({ state: 'working' });
  });

  it('reads each kind of verdict, and takes anything it does not know as a failure on our side', async () => {
    const read = (v: unknown) => new FrameVideoModeration(lambda as never, bucket(JSON.stringify(v)) as never, 'b', 'fn').result('r');
    expect(await read({ state: 'done', ok: true, frames: 60 })).toEqual({ state: 'done', ok: true });
    expect(await read({ state: 'done', ok: false, label: 'Violence at 0:42' })).toEqual({ state: 'done', ok: false, label: 'Violence at 0:42' });
    expect(await read({ state: 'unreadable' })).toEqual({ state: 'unreadable' });
    expect(await read({ state: 'failed' })).toEqual({ state: 'failed' });
    expect(await read({ what: 'is this' })).toEqual({ state: 'failed' });
  });

  it('does not take the start as made when the function was not started', async () => {
    const m = new FrameVideoModeration({ send: async () => ({ StatusCode: 500 }) } as never, bucket(null) as never, 'b', 'fn');
    await expect(m.start('r')).rejects.toThrow();
  });
});

// With the real ffmpeg, where there is one on the machine: a video in a container the old check could not read (WebM, VP8) is cut into frames and looked at.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
describe.skipIf(!hasFfmpeg)('with the real ffmpeg', () => {
  it('cuts frames out of a WebM video and finds nothing to read in a file that is not a video', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frames-'));
    try {
      const webm = join(dir, 'clip.webm');
      expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=7:size=320x240:rate=15', '-c:v', 'libvpx', '-b:v', '200k', webm]).status).toBe(0);
      const sizes: number[] = [];
      const verdict = await checkVideoFrames({ file: webm, ffmpeg: runFfmpeg('ffmpeg'), moderation: { check: async (b, type) => (sizes.push(b.length), expect(type).toBe('image/jpeg'), expect(b[0]).toBe(0xff), { ok: true }) }, strict: false, unit: Math.random });
      expect(verdict).toEqual({ state: 'done', ok: true, frames: 4 });                                           // 7 s: stretches of 2, 2, 2 and 1
      expect(sizes.every((n) => n > 500)).toBe(true);
      const text = join(dir, 'notes.webm');
      spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(text)}, 'not a video at all')`]);
      expect(await checkVideoFrames({ file: text, ffmpeg: runFfmpeg('ffmpeg'), moderation: ok, strict: false, unit: Math.random })).toEqual({ state: 'unreadable' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
