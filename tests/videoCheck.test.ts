import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { VIDEO_TYPES } from '../src/online/protocol';
import { sayError } from '../src/ui/online';
import type { RekognitionModeration } from '../server/src/aws/rekognition';
import { check } from '../server/src/aws/videoCheck';
import { looksLike } from '../server/src/service';

const INFO = '  Duration: 00:00:06.00, start: 0.0\n  Stream #0:0: Video: vp9, yuv420p, 640x360';

/** The bucket as the function sees it: one stored video, and whatever is written to it. */
function bucket(video: Uint8Array | null) {
  const written: { Key: string; Body: string }[] = [];
  return {
    written,
    s3: {
      send: async (c: { input: { Key: string; Body?: string }; constructor: { name: string } }) => {
        if (c.constructor.name === 'GetObjectCommand') {
          if (!video) throw new Error('gone');
          return { Body: Readable.from([Buffer.from(video)]) };
        }
        written.push({ Key: c.input.Key, Body: c.input.Body as string });
        return {};
      },
    },
  };
}

describe('the function that looks at a video', () => {
  const run = async (video: Uint8Array | null, moderation: Pick<RekognitionModeration, 'check'>, ffmpeg?: (args: string[]) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>) => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'));
    const b = bucket(video);
    const f = ffmpeg ?? (async (args: string[]) => (args.includes('-ss') ? { code: 0, stdout: new Uint8Array([0xff, 0xd8, 1, 2]), stderr: '' } : { code: 1, stdout: new Uint8Array(), stderr: INFO }));
    const verdict = await check({ roomId: 'r1', strict: true }, { s3: b.s3 as never, bucket: 'b', ffmpeg: f, moderation: moderation as never, unit: () => 0.5, dir });
    const left = readdirSync(dir);
    rmSync(dir, { recursive: true, force: true });
    return { verdict, written: b.written, left };
  };

  it('copies the video to its disk, looks at its frames, writes the verdict where the service reads it, and leaves nothing on the disk', async () => {
    const seen: boolean[] = [];
    const { verdict, written, left } = await run(new Uint8Array([1, 2, 3]), { check: async (_b: Uint8Array, _t?: string, strict?: boolean) => (seen.push(strict === true), { ok: true as const }) });
    expect(verdict).toEqual({ state: 'done', ok: true, frames: 3 });
    expect(seen).toEqual([true, true, true]);
    expect(written).toHaveLength(1);
    expect(written[0].Key).toBe('checks/r1.json');
    expect(JSON.parse(written[0].Body)).toEqual({ state: 'done', ok: true, frames: 3 });
    expect(left).toEqual([]);
  });

  it('writes what was found for a video that is turned down, and "failed" (our fault) for anything that breaks, so that the maker is not kept waiting', async () => {
    const bad = await run(new Uint8Array([1]), { check: async () => ({ ok: false as const, label: 'Violence' }) });
    expect(bad.verdict).toMatchObject({ state: 'done', ok: false });
    expect(JSON.parse(bad.written[0].Body).label).toMatch(/^Violence at 0:0\d$/);
    const gone = await run(null, { check: async () => ({ ok: true as const }) });
    expect(gone.verdict).toEqual({ state: 'failed' });
    expect(JSON.parse(gone.written[0].Body)).toEqual({ state: 'failed' });
    const broken = await run(new Uint8Array([1]), { check: async () => { throw new Error('throttled'); } });
    expect(broken.verdict).toEqual({ state: 'failed' });
    expect(broken.left).toEqual([]);
  });
});

describe('what the game and the server accept and say', () => {
  it('takes MP4, MOV, WebM and MKV, and can tell each from its first bytes', () => {
    expect([...VIDEO_TYPES]).toEqual(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(looksLike(webm, 'video/webm')).toBe(true);
    expect(looksLike(webm, 'video/x-matroska')).toBe(true);
    expect(looksLike(webm, 'video/mp4')).toBe(false);
  });

  it('tells the maker when it was our fault, and that nothing was charged', () => {
    expect(sayError('check-failed')).toMatch(/our side/);
    expect(sayError('check-failed')).toMatch(/not been charged/);
    expect(sayError('unreadable')).toMatch(/not been charged/);
    expect(sayError('rejected')).toMatch(/moderator/);
  });
});
