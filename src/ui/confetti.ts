const COLOURS = ['#ffd84a', '#ff5d73', '#4ac8ff', '#7be069', '#c07bff', '#ff9a3c', '#ffffff'];
const PER_SIDE = 90;
const LAUNCH_MS = 220;          // the pieces do not all leave at the same instant
const LIFE_MS = 3200;
const DRAG = 0.9;               // per second: slows the pieces so that they flutter down instead of falling like stones

interface Piece {
  /** Milliseconds after the start at which it leaves its corner. */
  delay: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  colour: string;
  angle: number;
  spin: number;
  /** The phase and speed of the flip that makes a piece look thin from the side. */
  flip: number;
  flipSpeed: number;
}

let running = 0;

/**
 * A burst of confetti that flies in from the bottom left and bottom right corners of the screen towards its middle, then drifts down. It is drawn on a canvas of its own over
 * the page (which does not take clicks) and takes itself away when it is over.
 */
export function launchConfetti(): void {
  if (typeof document === 'undefined') return;
  window.cancelAnimationFrame(running);
  document.querySelector('canvas.confetti')?.remove();
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  document.body.append(canvas);
  const grav = h * 1.7;                                          // px/s²: the same arc whatever the screen
  const pieces: Piece[] = [];
  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;                             // from the left corner towards the right, and the other way
    for (let i = 0; i < PER_SIDE; i++) {
      const rise = h * (0.5 + Math.random() * 0.6);              // how high it goes before it turns
      const vy = -Math.sqrt(2 * grav * rise);
      const aim = (w / h) * (0.55 + Math.random() * 0.6);        // horizontal over vertical speed: aimed at the middle of the screen, with some scatter
      pieces.push({
        delay: Math.random() * LAUNCH_MS,
        x: side === 0 ? 0 : w,
        y: h,
        vx: dir * -vy * aim * 0.55,
        vy,
        size: 8 + Math.random() * 7,
        colour: COLOURS[(Math.random() * COLOURS.length) | 0],
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 14,
        flip: Math.random() * Math.PI * 2,
        flipSpeed: 6 + Math.random() * 8,
      });
    }
  }
  const start = performance.now();
  let last = start;
  const frame = (now: number): void => {
    const t = now - start;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const slow = Math.exp(-DRAG * dt);
    for (const p of pieces) {
      const age = t - p.delay;
      if (age < 0) continue;
      p.vx *= slow;
      p.vy = p.vy * slow + grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      const left = 1 - age / LIFE_MS;
      if (left <= 0 || p.y > h + 40) continue;
      ctx.globalAlpha = Math.min(1, left * 4);
      ctx.fillStyle = p.colour;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.scale(1, Math.cos(p.flip + (age / 1000) * p.flipSpeed));
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (t < LIFE_MS + LAUNCH_MS) running = window.requestAnimationFrame(frame);
    else canvas.remove();
  };
  running = window.requestAnimationFrame(frame);
}
