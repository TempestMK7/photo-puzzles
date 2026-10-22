/** Longest side a loaded photo is reduced to: keeps memory sane on phones and the puzzle quick to draw. */
export const MAX_SIDE = 1600;

/** Loads a picture file (honouring its EXIF rotation) as a canvas no bigger than MAX_SIDE. */
export async function loadPhoto(file: Blob): Promise<HTMLCanvasElement> {
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
