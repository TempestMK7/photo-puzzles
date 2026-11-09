import type { Moderation } from './types';

/** The video is looked at through one frame from each stretch of this many seconds. */
export const FRAME_EVERY_S = 2;
/** The longest side of a frame that is sent to be looked at (a frame is made smaller than this, never larger). */
export const FRAME_MAX_SIDE = 1280;

/**
 * Where in a video of `seconds` the frames to look at are taken: one at a random moment of each stretch of `FRAME_EVERY_S` seconds (the last, shorter stretch included), so that what is
 * looked at cannot be known beforehand. `unit` gives a number from 0 up to (not including) 1.
 */
export function sampleTimes(seconds: number, unit: () => number): number[] {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return [];
  const out: number[] = [];
  for (let from = 0; from < seconds; from += FRAME_EVERY_S) {
    const length = Math.min(FRAME_EVERY_S, seconds - from);
    out.push(from + Math.min(length * 0.999, unit() * length));
  }
  return out;
}

/** What running ffmpeg once gave: its exit code, what it wrote to the standard output (a picture, when it was asked for one) and what it said. */
export interface FfmpegRun {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

export type FrameVerdict = { state: 'unreadable' } | { state: 'done'; ok: true; frames: number } | { state: 'done'; ok: false; label: string };

/** "0:42" for a time in seconds. */
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * Looks at a video (a file that ffmpeg can read) by cutting one random frame out of every two seconds and having each looked at as a picture is (`Moderation`). The first frame that is turned
 * down ends it, with what was found and when. A file with no video in it, or one from which too few frames can be cut, is `unreadable`. A failure of the look itself (the service or ffmpeg
 * breaking) is thrown: it is not the file's fault.
 */
export async function checkVideoFrames(o: {
  file: string;
  ffmpeg: (args: string[]) => Promise<FfmpegRun>;
  moderation: Moderation;
  strict: boolean;
  unit: () => number;
  /** The length the maker's game said, for a file that does not say its own. */
  declaredSeconds?: number;
  concurrency?: number;
}): Promise<FrameVerdict> {
  const probe = await o.ffmpeg(['-hide_banner', '-i', o.file]);               // (it exits with an error for want of an output: what it says about the file is what is wanted)
  if (!/Stream #[^\n]*Video:/.test(probe.stderr)) return { state: 'unreadable' };
  const found = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe.stderr);
  const seconds = found ? Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3]) : o.declaredSeconds ?? 0;
  const times = sampleTimes(seconds, o.unit);
  if (!times.length) return { state: 'unreadable' };
  let verdict: { label: string } | null = null;
  let looked = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!verdict) {
      const i = next++;
      if (i >= times.length) return;
      const run = await o.ffmpeg([
        '-v', 'error', '-ss', times[i].toFixed(3), '-i', o.file, '-frames:v', '1',
        '-vf', `scale='min(${FRAME_MAX_SIDE},iw)':'min(${FRAME_MAX_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
        '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
      ]);
      if (run.code !== 0 || run.stdout.length === 0) continue;                 // (a moment that has no frame: the next one)
      looked++;
      const said = await o.moderation.check(run.stdout, 'image/jpeg', o.strict);
      if (!said.ok && !verdict) verdict = { label: `${said.label} at ${clock(times[i])}` };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  if (verdict) return { state: 'done', ok: false, label: (verdict as { label: string }).label };
  if (looked < Math.max(1, Math.ceil(times.length / 2))) return { state: 'unreadable' };
  return { state: 'done', ok: true, frames: looked };
}
