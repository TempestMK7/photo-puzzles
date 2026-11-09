import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import type { Readable } from 'node:stream';
import { checkVideoFrames, type FfmpegRun, type FrameVerdict } from '../frames';
import { RekognitionModeration } from './rekognition';
import { checkKey, mediaKey } from './s3media';

/** What the room service asks of this function (asynchronously: nobody waits for the answer, which is written to the bucket for `FrameVideoModeration.result` to read). */
export interface VideoCheckEvent {
  roomId: string;
  strict?: boolean;
  /** The length the maker's game said, in seconds, for a file that does not say its own. */
  seconds?: number;
}

/** Runs ffmpeg (a static build, from a layer: `FFMPEG_PATH`) and gathers what it wrote. */
export function runFfmpeg(path: string): (args: string[]) => Promise<FfmpegRun> {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let err = '';
      let size = 0;
      child.stdout.on('data', (b: Buffer) => {
        size += b.length;
        if (size <= 20_000_000) out.push(b);                                   // (a frame is a few hundred kilobytes: this is only a stop for a runaway)
      });
      child.stderr.on('data', (b: Buffer) => {
        if (err.length < 100_000) err += b.toString('latin1');
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
    });
}

/**
 * Looks at a video that is in the media bucket: it is copied to the function's own disk, a random frame of every two seconds is cut out of it and each is looked at by Rekognition as a
 * picture is, and the verdict is written to the bucket (`checks/<room>.json`). Any failure of our own is written as `failed`, so that the maker is told at once and not charged.
 */
export async function check(
  event: VideoCheckEvent,
  deps: { s3: Pick<S3Client, 'send'>; bucket: string; ffmpeg: (args: string[]) => Promise<FfmpegRun>; moderation: RekognitionModeration; unit: () => number; dir: string },
): Promise<FrameVerdict | { state: 'failed' }> {
  const file = `${deps.dir}/${event.roomId}`;
  let verdict: FrameVerdict | { state: 'failed' };
  try {
    const got = await deps.s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: mediaKey(event.roomId) }));
    await pipeline(got.Body as Readable, createWriteStream(file));
    verdict = await checkVideoFrames({ file, ffmpeg: deps.ffmpeg, moderation: deps.moderation, strict: event.strict === true, unit: deps.unit, declaredSeconds: event.seconds });
  } catch (e) {
    console.error(e);
    verdict = { state: 'failed' };
  } finally {
    await rm(file, { force: true });
  }
  await deps.s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: checkKey(event.roomId), Body: JSON.stringify(verdict), ContentType: 'application/json' }));
  return verdict;
}

export const handler = async (event: VideoCheckEvent): Promise<void> => {
  const bucket = process.env.MEDIA_BUCKET;
  if (!bucket) throw new Error('MEDIA_BUCKET is not set');
  await check(event, {
    s3: new S3Client({}),
    bucket,
    ffmpeg: runFfmpeg(process.env.FFMPEG_PATH ?? '/opt/bin/ffmpeg'),
    moderation: new RekognitionModeration(new RekognitionClient({})),
    unit: () => randomInt(0, 1_000_000) / 1_000_000,
    dir: '/tmp',
  });
};
