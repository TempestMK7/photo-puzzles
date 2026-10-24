/** Longest side a loaded photo is reduced to: keeps memory sane on phones and the puzzle quick to draw. */
export const MAX_SIDE = 1600;

/**
 * Loads a picture file (honouring its EXIF rotation) as a canvas no bigger than MAX_SIDE. If the browser cannot make a bitmap of it (a 50 megapixel photo can be too
 * much for a phone), the picture is decoded the other way, through an image element.
 */
export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement> {
  try {
    return await fromBitmap(file);
  } catch (first) {
    try {
      return await fromImage(file);
    } catch {
      throw first;
    }
  }
}

async function fromImage(file: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fromBitmap(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  } finally {
    bmp.close();
  }
}

const VIDEO_EXT = /\.(webm|mp4|m4v|mov|ogv|mkv)$/i;

/** Is this file a video? (By its type, or by its extension when the browser gives no type or only a general one.) */
export function isVideoFile(f: { name: string; type: string }): boolean {
  return f.type.startsWith('video/') || ((!f.type || f.type === 'application/octet-stream') && VIDEO_EXT.test(f.name));
}

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  /** A frame from near the start, for the thumbnail (at most 640 px on its longest side). */
  poster: HTMLCanvasElement;
}

/** Opens a video just far enough to learn its size and length and to take a poster frame. Rejects when this browser cannot play it. */
export function readVideo(file: Blob): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    const done = (fn: () => void) => {
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      fn();
    };
    const timer = window.setTimeout(() => done(() => reject(new Error('it did not open: this device may not decode its format'))), 20000);
    v.onerror = () => {
      window.clearTimeout(timer);
      done(() => reject(new Error('this browser cannot play it')));
    };
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1, (v.duration || 0) * 0.1);
    };
    let taken = false;
    let tries = 0;
    const take = () => {
      if (taken) return;
      const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(v.videoWidth * k));
      c.height = Math.max(1, Math.round(v.videoHeight * k));
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      if (tries++ < 3 && looksBlack(c)) {
        // some browsers have no picture to give for a video that was only seeked (and not on a page): let it play a moment, then look again
        taken = true;
        v.play().then(
          () => window.setTimeout(() => {
            v.pause();
            taken = false;
            take();
          }, 300),
          () => {
            taken = false;
            tries = 3;
            take();
          },
        );
        return;
      }
      taken = true;
      window.clearTimeout(timer);
      const info = { width: v.videoWidth, height: v.videoHeight, duration: v.duration, poster: c };
      done(() => resolve(info));
    };
    v.onseeked = () => {
      // the picture is only there to be drawn once the browser has presented it; drawn at once it can still be black
      if ('requestVideoFrameCallback' in v) {
        v.requestVideoFrameCallback(take);
        window.setTimeout(take, 1500);
      } else take();
    };
    v.src = url;
  });
}

/** Is this picture (all but) entirely black? */
function looksBlack(c: HTMLCanvasElement): boolean {
  const t = document.createElement('canvas');
  t.width = t.height = 8;
  const g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, 8, 8);
  const px = g.getImageData(0, 0, 8, 8).data;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 12 || px[i + 1] > 12 || px[i + 2] > 12) return false;
  return true;
}

/** A square thumbnail (cut from the middle) as a JPEG blob. */
export async function makeThumb(photo: HTMLCanvasElement, size = 160): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  const side = Math.min(photo.width, photo.height);
  g.drawImage(photo, (photo.width - side) / 2, (photo.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('no thumbnail'))), 'image/jpeg', 0.8));
}

export interface SampleInfo {
  id: string;
  name: string;
}

interface Palette extends SampleInfo {
  sky: [string, string, string];
  hills: [string, string, string];
  sun: string;
}

const PALETTES: Palette[] = [
  { id: 'sample-dusk', name: 'Sample: Dusk', sky: ['#2b4a8f', '#f0a36b', '#fbe3a6'], hills: ['#5b3f6e', '#3d2b57', '#241a3a'], sun: '#fff3c4' },
  { id: 'sample-meadow', name: 'Sample: Meadow', sky: ['#4a90d9', '#9fd3f5', '#e8f6ff'], hills: ['#6fae4f', '#4b8a3a', '#2f6a2c'], sun: '#fff6a8' },
  { id: 'sample-ember', name: 'Sample: Ember', sky: ['#2a1030', '#b8412f', '#f5b55a'], hills: ['#4a2430', '#34171f', '#1d0d12'], sun: '#ffe08a' },
];

export const SAMPLES: SampleInfo[] = PALETTES.map(({ id, name }) => ({ id, name }));

/** A made-up picture so there is something to play without choosing a file (no outside art). */
export function samplePhoto(id = 'sample-dusk'): HTMLCanvasElement {
  const pal = PALETTES.find((p) => p.id === id) ?? PALETTES[0];
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 800;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 800);
  sky.addColorStop(0, pal.sky[0]);
  sky.addColorStop(0.55, pal.sky[1]);
  sky.addColorStop(1, pal.sky[2]);
  g.fillStyle = sky;
  g.fillRect(0, 0, 1200, 800);
  g.fillStyle = pal.sun;
  g.beginPath();
  g.arc(860, 330, 90, 0, Math.PI * 2);
  g.fill();
  pal.hills.forEach((col, k) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, 800);
    for (let x = 0; x <= 1200; x += 20) g.lineTo(x, 520 + k * 85 + Math.sin(x / 130 + k * 2) * (40 + k * 12));
    g.lineTo(1200, 800);
    g.fill();
  });
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 90; i++) {
    const x = (i * 197) % 1200;
    const y = (i * 61) % 360;
    g.fillRect(x, y, 2 + (i % 3), 2 + (i % 3));
  }
  g.font = 'bold 90px system-ui, sans-serif';
  g.fillStyle = 'rgba(20,10,30,0.8)';
  g.fillText(pal.name.replace('Sample: ', '').toUpperCase(), 190, 700);
  return c;
}
