import type { Rng } from '../core/rng';

// Backgrounds for the empty board in Overlap: radial patterns drawn in code (sunbursts, targets, rose windows, spirals, ray-and-dot wheels). A piece's window cell shows
// the bit of this pattern that lies under its home, so the pattern has to look different from one place to the next: every style has a centre away from the middle
// of the board and rings / spokes of varying widths.

const PALETTES: string[][] = [
  ['#5b1f1a', '#c8793a', '#f0d9b5', '#2a1b14'],
  ['#12304a', '#2f7fa8', '#9fd3e6', '#e8f4f8'],
  ['#2b1a4a', '#7a4fb0', '#d9a6e8', '#f3e1f7'],
  ['#143a24', '#3f8a4f', '#b7dc8c', '#f1f0c0'],
  ['#4a1030', '#c23a6a', '#f5a3a0', '#fbe3c8'],
  ['#3a3a3a', '#8a8f98', '#cfd3d9', '#f5f5f5'],
];

type Ctx = CanvasRenderingContext2D;

interface Env {
  g: Ctx;
  w: number;
  h: number;
  cx: number;
  cy: number;
  R: number;
  pal: string[];
  rng: Rng;
}

const rand = (rng: Rng, a: number, b: number): number => a + rng.unit() * (b - a);

function wedges(e: Env, n: number, offset = 0): void {
  const { g, cx, cy, R, pal } = e;
  for (let i = 0; i < n; i++) {
    g.fillStyle = pal[i % pal.length];
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, R, offset + (i / n) * Math.PI * 2, offset + ((i + 1) / n) * Math.PI * 2);
    g.closePath();
    g.fill();
  }
}

function ring(e: Env, r: number, width: number, colour: string, alpha = 1): void {
  const { g, cx, cy } = e;
  g.globalAlpha = alpha;
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 1;
}

function sunburst(e: Env): void {
  const n = 16 + 2 * e.rng.below(10);
  wedges(e, n, rand(e.rng, 0, 6.28));
  let r = rand(e.rng, 30, 60);
  while (r < e.R) {
    ring(e, r, rand(e.rng, 3, 16), e.pal[e.rng.below(e.pal.length)], 0.55);
    r += rand(e.rng, 40, 120);
  }
}

function target(e: Env): void {
  const { g, cx, cy, pal, rng } = e;
  let r = e.R;
  let i = 0;
  while (r > 0) {
    g.fillStyle = pal[i++ % pal.length];
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    r -= rand(rng, 18, 70);
  }
  g.strokeStyle = pal[3];
  g.globalAlpha = 0.35;
  g.lineWidth = 3;
  const spokes = 20 + rng.below(16);
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * e.R, cy + Math.sin(a) * e.R);
    g.stroke();
  }
  g.globalAlpha = 1;
}

function rose(e: Env): void {
  const { g, cx, cy, pal, rng } = e;
  g.fillStyle = pal[0];
  g.fillRect(0, 0, e.w, e.h);
  for (let layer = 0; layer < 5; layer++) {
    const petals = 8 + 2 * rng.below(6);
    const radius = e.R * (0.2 + layer * 0.17);
    const pr = radius * rand(rng, 0.35, 0.6);
    const off = rand(rng, 0, 6.28);
    g.strokeStyle = pal[1 + (layer % 3)];
    g.fillStyle = pal[1 + ((layer + 1) % 3)];
    g.lineWidth = rand(rng, 3, 9);
    for (let k = 0; k < petals; k++) {
      const a = off + (k / petals) * Math.PI * 2;
      g.globalAlpha = 0.5;
      g.beginPath();
      g.arc(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, pr, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      g.stroke();
    }
  }
}

function spiral(e: Env): void {
  const { g, cx, cy, pal, rng } = e;
  g.fillStyle = pal[0];
  g.fillRect(0, 0, e.w, e.h);
  const arms = 3 + rng.below(4);
  const turns = rand(rng, 2.5, 5);
  g.lineCap = 'round';
  for (let a = 0; a < arms; a++) {
    for (let band = 0; band < 3; band++) {
      g.strokeStyle = pal[1 + band];
      g.lineWidth = e.R * (0.075 - band * 0.02);
      g.beginPath();
      for (let t = 0; t <= 1; t += 0.004) {
        const ang = (a / arms) * Math.PI * 2 + t * turns * Math.PI * 2 + band * 0.12;
        const r = t * e.R;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (t === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
  }
}

function wheel(e: Env): void {
  const { g, cx, cy, pal, rng } = e;
  g.fillStyle = pal[0];
  g.fillRect(0, 0, e.w, e.h);
  const spokes = 24 + rng.below(24);
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    const grad = g.createLinearGradient(cx, cy, cx + Math.cos(a) * e.R, cy + Math.sin(a) * e.R);
    grad.addColorStop(0, pal[1]);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.strokeStyle = grad;
    g.lineWidth = rand(rng, 2, 9);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * e.R, cy + Math.sin(a) * e.R);
    g.stroke();
  }
  let r = 40;
  while (r < e.R) {
    const dots = Math.max(6, Math.round(r / 7));
    const size = rand(rng, 2, 7);
    g.fillStyle = pal[2 + rng.below(2)];
    for (let k = 0; k < dots; k++) {
      const a = (k / dots) * Math.PI * 2 + r;
      g.beginPath();
      g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, size, 0, Math.PI * 2);
      g.fill();
    }
    r += rand(rng, 25, 70);
  }
}

const STYLES = [sunburst, target, rose, spiral, wheel];

/** A radial pattern of the given pixel size; the seed picks the style, the colours, the centre and the proportions. */
export function makePattern(rng: Rng, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const pal = PALETTES[rng.below(PALETTES.length)];
  const cx = w * rand(rng, 0.3, 0.7);
  const cy = h * rand(rng, 0.3, 0.7);
  const env: Env = { g, w, h, cx, cy, R: Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)), pal, rng };
  g.fillStyle = pal[0];
  g.fillRect(0, 0, w, h);
  STYLES[rng.below(STYLES.length)](env);
  // a soft shading across the board so that no two cells are alike even inside a flat band
  const shade = g.createLinearGradient(0, 0, w, h);
  shade.addColorStop(0, 'rgba(255,255,255,0.14)');
  shade.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  return c;
}
