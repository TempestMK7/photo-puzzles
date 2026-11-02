import type { Rng } from '../core/rng';

// Backgrounds for the empty board in Overlap: spokes radiating out from a centre, drawn in code (wedges of colour, thin rays, or both). A piece's window cell shows the bit of this
// pattern that lies under its home, so the pattern has to look different from one place to the next: every style has its centre off the board (past one of its sides), so that the
// board shows spokes fanning across it, of varying widths. There are no rings and no bands round the centre.

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

/** Wedges of colour from the centre, each of its own width (the angles are shares of a whole turn, drawn from the seed). */
function wedges(e: Env, n: number, offset = 0): void {
  const { g, cx, cy, R, pal, rng } = e;
  const widths = Array.from({ length: n }, () => rand(rng, 0.4, 1.6));
  const total = widths.reduce((a, b) => a + b, 0);
  let from = offset;
  for (let i = 0; i < n; i++) {
    const to = from + (widths[i] / total) * Math.PI * 2;
    g.fillStyle = pal[i % pal.length];
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, R, from, to + 0.002);
    g.closePath();
    g.fill();
    from = to;
  }
}

/** Thin rays from the centre over what is drawn, as far as the board goes. */
function rays(e: Env, n: number, colour: string, alpha: number, thick: [number, number]): void {
  const { g, cx, cy, R, rng } = e;
  g.strokeStyle = colour;
  g.globalAlpha = alpha;
  for (let k = 0; k < n; k++) {
    const a = rand(rng, 0, Math.PI * 2);
    g.lineWidth = rand(rng, thick[0], thick[1]);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** A sunburst: wedges of the palette's colours, wide and narrow. */
function sunburst(e: Env): void {
  wedges(e, 16 + 2 * e.rng.below(10), rand(e.rng, 0, 6.28));
}

/** A sunburst with fine rays over it, in a lighter or darker colour. */
function fan(e: Env): void {
  wedges(e, 8 + 2 * e.rng.below(6), rand(e.rng, 0, 6.28));
  rays(e, 30 + e.rng.below(30), e.pal[e.rng.below(2) ? 3 : 0], 0.35, [1, 4]);
}

/** Rays alone, of different widths, on the dark ground: a wheel without its rim. */
function wheel(e: Env): void {
  const { g, cx, cy, R, pal, rng } = e;
  g.fillStyle = pal[0];
  g.fillRect(0, 0, e.w, e.h);
  const spokes = 24 + rng.below(24);
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2 + rand(rng, -0.03, 0.03);
    const grad = g.createLinearGradient(cx, cy, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    grad.addColorStop(0, pal[1 + (k % 3)]);
    grad.addColorStop(0.85, pal[1 + (k % 3)]);          // (the centre is off the board: the spokes have to last as far as the board is)
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.strokeStyle = grad;
    g.lineWidth = rand(rng, 3, 14);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    g.stroke();
  }
}

const STYLES = [sunburst, fan, wheel];

/** A pattern of spokes of the given pixel size; the seed picks the style, the colours, the centre and the proportions. */
export function makePattern(rng: Rng, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const pal = PALETTES[rng.below(PALETTES.length)];
  // the centre lies outside the board: past one of its four sides, somewhere along it (a little beyond its ends too, for a corner)
  const side = rng.below(4);
  const out = rand(rng, 0.2, 0.6);
  const along = rand(rng, -0.15, 1.15);
  const cx = side === 0 ? -w * out : side === 1 ? w * (1 + out) : w * along;
  const cy = side === 2 ? -h * out : side === 3 ? h * (1 + out) : h * along;
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
