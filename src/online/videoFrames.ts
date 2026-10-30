import { FRAME_BYTES } from './protocol';

/** The widest a picture sent for the server's look at a video is: enough for the automatic check, small enough to send a dozen at once. */
const FRAME_WIDTH = 640;

/** The kind of file a video is, from the browser's word for it or else from the end of its name (which is what a phone or a camera is sure of). */
export function videoTypeOf(blob: Blob, name: string): string {
  const t = blob.type.toLowerCase();
  if (t === 'video/mp4' || t === 'video/webm' || t === 'video/quicktime' || t === 'video/x-matroska') return t;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mkv') return 'video/x-matroska';
  return t;
}

const toBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('A picture of the video could not be prepared'));
    r.readAsDataURL(blob);
  });

const seekTo = (v: HTMLVideoElement, seconds: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('This browser could not take pictures from that video')), 8000);
    v.addEventListener(
      'seeked',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    v.currentTime = seconds;
  });

/**
 * A few pictures of a video, spread over its length (JPEGs, as base64 text): what the server's automatic check looks at in place of the video. Taken from a copy of the video of
 * their own, so that the video on the screen is not moved.
 */
export async function framesOf(video: Blob, count: number, seconds: number): Promise<string[]> {
  const url = URL.createObjectURL(video);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error('This browser cannot read that video'));
    });
    const scale = Math.min(1, FRAME_WIDTH / Math.max(1, v.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
    const ctx = canvas.getContext('2d')!;
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      await seekTo(v, Math.min(seconds * ((i + 0.5) / count), Math.max(0, seconds - 0.05)));
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      let blob: Blob | null = null;
      for (const quality of [0.7, 0.5, 0.3]) {
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= FRAME_BYTES) break;
      }
      if (!blob || blob.size > FRAME_BYTES) throw new Error('A picture of the video could not be prepared');
      out.push(await toBase64(blob));
    }
    return out;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}
