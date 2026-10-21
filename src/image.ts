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

/** A made-up picture for the first run, so there is something to play without choosing a file (no outside art). */
export function samplePhoto(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 800;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 800);
  sky.addColorStop(0, '#2b4a8f');
  sky.addColorStop(0.55, '#f0a36b');
  sky.addColorStop(1, '#fbe3a6');
  g.fillStyle = sky;
  g.fillRect(0, 0, 1200, 800);
  g.fillStyle = '#fff3c4';
  g.beginPath();
  g.arc(860, 330, 90, 0, Math.PI * 2);
  g.fill();
  const hills = ['#5b3f6e', '#3d2b57', '#241a3a'];
  hills.forEach((col, k) => {
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
  g.fillText('PHOTO PUZZLES', 190, 700);
  return c;
}
