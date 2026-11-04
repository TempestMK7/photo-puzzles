import type { Rng } from '../core/rng';

// Backgrounds for the empty board in Overlap: spokes radiating out from a centre, drawn in code (wedges of colour, thin rays, or both). A piece's window cell shows the bit of this
// pattern that lies under its home, so the pattern has to look different from one place to the next: every style has its centre off the board (past one of its sides), so that the
// board shows spokes fanning across it, of varying widths. There are no rings and no bands round the centre. Over the spokes go a colour that shifts as it travels out from the centre,
// and scattered dots and stars, so that no stretch of the board is a flat colour to place a piece by.

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

/** A colour that shifts from one palette colour to the next with the distance from the centre (over the stretch of it that the board covers). */
function drift(e: Env): void {
  const { g, cx, cy, w, h, R, pal } = e;
  const near = Math.hypot(Math.min(Math.max(cx, 0), w) - cx, Math.min(Math.max(cy, 0), h) - cy);   // (the centre is off the board: the gradient starts at the board's nearest point)
  const grad = g.createRadialGradient(cx, cy, near, cx, cy, Math.max(R, near + 1));
  const alpha = (c: string, a: number): string => `${c}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
  grad.addColorStop(0, alpha(pal[1], 0.6));
  grad.addColorStop(0.5, alpha(pal[2], 0.5));
  grad.addColorStop(1, alpha(pal[3], 0.45));
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
}

/** A star of `n` points, `r` across, turned by `turn`. */
function star(g: Ctx, x: number, y: number, r: number, n: number, turn: number): void {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = turn + (i * Math.PI) / n;
    const d = i % 2 ? r * 0.45 : r;
    g[i ? 'lineTo' : 'moveTo'](x + Math.sin(a) * d, y - Math.cos(a) * d);
  }
  g.closePath();
  g.fill();
}

/** Dots and stars (of five and of four points) over the whole board, one in each square of a loose grid, each at its own place, size and colour. */
function specks(e: Env): void {
  const { g, w, h, pal, rng } = e;
  const step = Math.min(w, h) / 12;
  for (let y = step / 2; y < h + step / 2; y += step) {
    for (let x = step / 2; x < w + step / 2; x += step) {
      const px = x + rand(rng, -0.4, 0.4) * step;
      const py = y + rand(rng, -0.4, 0.4) * step;
      const r = step * rand(rng, 0.1, 0.28);
      g.globalAlpha = rand(rng, 0.3, 0.6);
      g.fillStyle = rng.below(2) ? pal[3] : pal[0];
      const kind = rng.below(3);
      if (kind === 0) {
        g.beginPath();
        g.arc(px, py, r * 0.7, 0, Math.PI * 2);
        g.fill();
      } else star(g, px, py, r * 1.4, kind === 1 ? 5 : 4, rand(rng, 0, Math.PI * 2));
    }
  }
  g.globalAlpha = 1;
}

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
  drift(env);
  specks(env);
  // a soft shading across the board so that no two cells are alike even inside a flat band
  const shade = g.createLinearGradient(0, 0, w, h);
  shade.addColorStop(0, 'rgba(255,255,255,0.14)');
  shade.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  return c;
}
