import { WebmWriter } from './webm';

/**
 * Animated GIFs. A browser shows a GIF as one picture and, drawn on a canvas, only as its first frame, so the puzzles could not play it. Instead an animated GIF is turned into
 * a WebM video when it is added: the browser's own decoder (ImageDecoder) hands over the frames with their delays, the browser's video encoder (VideoEncoder, VP8) encodes them,
 * and a small writer (webm.ts) puts them in a file. After that it is an ordinary video to the rest of the game (playing, looping, the original window, the jigsaw on the
 * graphics card, saved puzzles). It takes a fraction of the GIF's playing time, not all of it.
 */

export function isGifFile(f: { name: string; type: string }): boolean {
  return f.type === 'image/gif' || ((!f.type || f.type === 'application/octet-stream') && /\.gif$/i.test(f.name));
}

/** Can this browser turn a GIF into a video (WebCodecs)? */
export function gifConversionAvailable(): boolean {
  return typeof ImageDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export interface GifVideo {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
}

/** How long a GIF frame is shown: browsers show a frame whose delay is under 20 ms (often 0 or 10 ms) for 100 ms. */
export function frameMs(durationUs: number | null | undefined): number {
  const ms = durationUs ? durationUs / 1000 : 100;
  return ms < 20 ? 100 : ms;
}

/**
 * The GIF as a WebM video, or null if it is not animated or this browser cannot do it (then it is added as the still picture it has always been). `onProgress` is told how many
 * frames are done of how many.
 */
export async function gifToWebm(file: Blob, onProgress?: (done: number, total: number) => void): Promise<GifVideo | null> {
  if (!gifConversionAvailable()) return null;
  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type: 'image/gif' });
  let encoder: VideoEncoder | null = null;
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const total = track?.frameCount ?? 0;
    if (!track || total < 2) return null;                       // one picture: an ordinary photo

    const first = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
    const width = first.image.displayWidth;
    const height = first.image.displayHeight;
    const bitrate = Math.min(12_000_000, Math.max(1_500_000, width * height * 10));       // a GIF is sharp-edged flat colour: give the encoder room
    const config: VideoEncoderConfig = { codec: 'vp8', width, height, bitrate, framerate: 20, latencyMode: 'quality' };
    if (!(await VideoEncoder.isConfigSupported(config)).supported) {
      first.image.close();
      return null;
    }

    const writer = new WebmWriter(width, height, 'V_VP8');
    let failure: unknown = null;
    encoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        writer.add(data, chunk.timestamp, chunk.type === 'key');
      },
      error: (e) => {
        failure = e;
      },
    });
    encoder.configure(config);

    // frames are drawn on a white sheet first: a GIF's transparent parts show the page behind them (white), and the encoder has no use for transparency
    const sheet = document.createElement('canvas');
    sheet.width = width;
    sheet.height = height;
    const g = sheet.getContext('2d')!;
    let t = 0;                                                  // microseconds
    let lastKey = -Infinity;
    for (let i = 0; i < total; i++) {
      const { image } = i === 0 ? first : await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      const ms = frameMs(image.duration);
      g.fillStyle = '#fff';
      g.fillRect(0, 0, width, height);
      g.drawImage(image, 0, 0, width, height);
      image.close();
      const frame = new VideoFrame(sheet, { timestamp: t, duration: ms * 1000 });
      const key = i === 0 || t - lastKey >= 2_000_000;
      encoder.encode(frame, { keyFrame: key });
      frame.close();
      if (key) lastKey = t;
      t += ms * 1000;
      if (failure) throw failure;
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));      // let the encoder catch up: frames are big
      onProgress?.(i + 1, total);
    }
    await encoder.flush();
    if (failure) throw failure;
    return { blob: writer.finish(t / 1000), width, height, durationMs: t / 1000 };
  } finally {
    try {
      encoder?.close();
    } catch {
      // already closed
    }
    decoder.close();
  }
}
