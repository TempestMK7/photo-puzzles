const COLOURS = ['#ffd84a', '#ff5d73', '#4ac8ff', '#7be069', '#c07bff', '#ff9a3c', '#ffffff'];
const PER_SIDE = 90;
const STREAMERS_PER_SIDE = 14;
const STREAMER_POINTS = 16;
const LAUNCH_MS = 220;          // the pieces do not all leave at the same instant
const LIFE_MS = 4800;
const FADE_MS = 1200;

/** What every flying thing (a bit of confetti, or the head of a streamer) does: it leaves its corner fast, slows down along both axes, and ends up drifting slowly down. */
interface Flyer {
  /** Milliseconds after the start at which it leaves its corner. */
  delay: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How quickly it slows down (per second), and the slow speed it settles to going down (px/s). */
  drag: number;
  drift: number;
  /** A gentle sideways sway while it drifts. */
  swayPhase: number;
  swayRate: number;
  swayAmp: number;
  colour: string;
}

interface Piece extends Flyer {
  size: number;
  angle: number;
  spin: number;
  /** The phase and speed of the flip that makes a piece look thin from the side. */
  flip: number;
  flipSpeed: number;
}

/** A ribbon: its head flies like a piece of confetti and the rest of it follows, each point keeping its distance from the one before. */
interface Streamer extends Flyer {
  /** x, y of each point, head first. */
  trail: Float32Array;
  width: number;
}

let running = 0;

function flyer(side: number, w: number, h: number, speed: number): Flyer {
  const dir = side === 0 ? 1 : -1;                               // from the left corner towards the right, and the other way
  const drag = 2.4 + Math.random() * 1.2;
  // an exponentially slowing piece goes v0 / drag in all: so the start speed is the distance it should cover, times the drag. It is aimed at the middle of the screen
  const across = (w / 2) * (0.45 + Math.random() * 0.6);
  const up = h * (0.45 + Math.random() * 0.5);
  return {
    delay: Math.random() * LAUNCH_MS,
    x: side === 0 ? 0 : w,
    y: h,
    vx: dir * across * drag * speed,
    vy: -up * drag * speed,
    drag,
    drift: h * (0.05 + Math.random() * 0.05),
    swayPhase: Math.random() * Math.PI * 2,
    swayRate: 2 + Math.random() * 2.5,
    swayAmp: 14 + Math.random() * 22,
    colour: COLOURS[(Math.random() * COLOURS.length) | 0],
  };
}

/** One step: slower and slower along both axes, towards a slow fall. */
function fly(f: Flyer, dt: number, age: number): void {
  const keep = Math.exp(-f.drag * dt);
  f.vx *= keep;
  f.vy = f.drift + (f.vy - f.drift) * keep;
  const speed = Math.hypot(f.vx, f.vy) / (f.drift * 12);
  const sway = Math.sin(f.swayPhase + (age / 1000) * f.swayRate) * f.swayAmp / (1 + speed * speed);        // (it sways once it has settled, not while it is still shooting)
  f.x += (f.vx + sway) * dt;
  f.y += f.vy * dt;
}

/**
 * A burst of confetti and streamers that flies in from the bottom left and bottom right corners of the screen towards its middle, quickly at first, slowing down in both
 * directions, and then drifts slowly down. It is drawn on a canvas of its own over the page (which does not take clicks) and takes itself away when it is over.
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
  const pieces: Piece[] = [];
  const streamers: Streamer[] = [];
  const seg = Math.max(5, h * 0.013);                            // how far apart the points of a streamer are kept
  for (const side of [0, 1]) {
    for (let i = 0; i < PER_SIDE; i++) {
      pieces.push({
        ...flyer(side, w, h, 1),
        size: 8 + Math.random() * 7,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 14,
        flip: Math.random() * Math.PI * 2,
        flipSpeed: 6 + Math.random() * 8,
      });
    }
    for (let i = 0; i < STREAMERS_PER_SIDE; i++) {
      const f = flyer(side, w, h, 1.1);
      const trail = new Float32Array(STREAMER_POINTS * 2);
      for (let k = 0; k < STREAMER_POINTS; k++) {
        trail[2 * k] = f.x;
        trail[2 * k + 1] = f.y;
      }
      streamers.push({ ...f, trail, width: 3 + Math.random() * 2 });
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
    for (const p of pieces) {
      const age = t - p.delay;
      if (age < 0) continue;
      fly(p, dt, age);
      p.angle += p.spin * dt;
      const left = (LIFE_MS - age) / FADE_MS;
      if (left <= 0 || p.y > h + 40) continue;
      ctx.globalAlpha = Math.min(1, left);
      ctx.fillStyle = p.colour;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.scale(1, Math.cos(p.flip + (age / 1000) * p.flipSpeed));
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of streamers) {
      const age = t - s.delay;
      if (age < 0) continue;
      fly(s, dt, age);
      const tr = s.trail;
      tr[0] = s.x;
      tr[1] = s.y;
      for (let k = 1; k < STREAMER_POINTS; k++) {                // each point follows the one before, at a fixed distance; the tail also sags a little
        const px = tr[2 * k - 2];
        const py = tr[2 * k - 1];
        let dx = tr[2 * k] - px;
        let dy = tr[2 * k + 1] - py + 18 * dt * (k / STREAMER_POINTS);
        const d = Math.hypot(dx, dy) || 1;
        if (d > seg) {
          dx = (dx / d) * seg;
          dy = (dy / d) * seg;
        }
        tr[2 * k] = px + dx;
        tr[2 * k + 1] = py + dy;
      }
      const left = (LIFE_MS - age) / FADE_MS;
      if (left <= 0 || tr[2 * STREAMER_POINTS - 1] > h + 40) continue;
      ctx.globalAlpha = Math.min(1, left);
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(tr[0], tr[1]);
      for (let k = 1; k < STREAMER_POINTS; k++) ctx.lineTo(tr[2 * k], tr[2 * k + 1]);
      ctx.stroke();
    }
    if (t < LIFE_MS + LAUNCH_MS) running = window.requestAnimationFrame(frame);
    else canvas.remove();
  };
  running = window.requestAnimationFrame(frame);
}
