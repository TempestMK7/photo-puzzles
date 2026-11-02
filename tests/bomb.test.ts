import { afterEach, describe, expect, it, vi } from 'vitest';
import { BombFx, FALL_MS, type BombPlan } from '../src/sessions/bomb';

/** A canvas stand-in that notes what is drawn. */
function canvas() {
  const circles: { x: number; y: number; r: number; colour: string }[] = [];
  const squares: { side: number; alpha: number }[] = [];
  const state = { fillStyle: '', globalAlpha: 1 };
  const ctx = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v: string) { state.fillStyle = v; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v: number) { state.globalAlpha = v; },
    strokeStyle: '',
    lineWidth: 1,
    lineCap: '',
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    quadraticCurveTo() {},
    stroke() {},
    fill() {},
    arc(x: number, y: number, r: number) {
      circles.push({ x, y, r, colour: state.fillStyle });
    },
    fillRect(_x: number, _y: number, w: number) {
      squares.push({ side: w, alpha: state.globalAlpha });
    },
    getTransform: () => ({ f: 0, d: 1 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, circles, squares };
}

const plan = (over: Partial<BombPlan> = {}): BombPlan => ({ x: 100, y: 100, unit: 10, area: [{ x: 80, y: 80, w: 40, h: 40 }], lo: 0.75, hi: 2, ...over });

afterEach(() => vi.restoreAllMocks());

describe('BombFx, the bomb that falls and explodes', () => {
  it('falls for about a second, and is gone when it explodes', () => {
    expect(FALL_MS).toBeGreaterThanOrEqual(800);
    expect(FALL_MS).toBeLessThanOrEqual(1200);
    const fx = new BombFx();
    const c = canvas();
    expect(fx.draw(c.ctx, 0)).toBe(false);
    fx.drop(plan(), 0);
    expect(fx.active).toBe(true);
    expect(fx.draw(c.ctx, 500)).toBe(true);
    expect(c.circles.some((x) => x.colour === '#17120f')).toBe(true);          // (the bomb)
    fx.explode(plan(), FALL_MS);
    const d = canvas();
    fx.draw(d.ctx, FALL_MS + 10);
    expect(d.circles.some((x) => x.colour === '#17120f')).toBe(false);          // (no bomb any more)
  });

  it('makes circles from yellow to red, 0.75 to 2 cells across, and a square of smoke for each', () => {
    const fx = new BombFx();
    const p = plan();
    fx.explode(p, 0);
    const sizes: number[] = [];
    const hues: number[] = [];
    let squares = 0;
    for (let t = 0; t <= 450; t += 15) {
      const c = canvas();
      fx.draw(c.ctx, t);
      for (const x of c.circles) {
        const m = /hsl\((\d+), 100%, (\d+)%\)/.exec(x.colour);
        if (m) {
          hues.push(Number(m[1]));
          sizes.push(x.r * 2);
        }
      }
      for (const q of c.squares) {
        squares++;
        expect(q.alpha).toBeLessThanOrEqual(0.6);
      }
    }
    expect(hues.length).toBeGreaterThan(20);
    expect(Math.min(...hues)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...hues)).toBeLessThanOrEqual(58);                          // (from red, 0, to yellow, 58)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(p.unit * p.hi + 1e-6);
    expect(Math.max(...sizes)).toBeGreaterThan(p.unit * p.lo);
    expect(squares).toBeGreaterThan(20);
  });

  it('keeps the smoke going after the fire, and then nothing is left', () => {
    const fx = new BombFx();
    fx.explode(plan(), 0);
    expect(fx.draw(canvas().ctx, 800)).toBe(true);                              // (the fire has begun by 420 ms at the latest and lasts 460; smoke lasts a second from its start)
    expect(fx.draw(canvas().ctx, 2000)).toBe(false);
    expect(fx.active).toBe(false);
  });

  it('shows nothing when animations are off', () => {
    const fx = new BombFx(() => false);
    fx.drop(plan(), 0);
    fx.explode(plan(), 0);
    expect(fx.active).toBe(false);
    expect(fx.draw(canvas().ctx, 10)).toBe(false);
  });

  it('takes a bomb that is still falling away without cutting the fire short, and can be cleared', () => {
    const fx = new BombFx();
    fx.drop(plan(), 0);
    fx.cancelFall();
    expect(fx.active).toBe(false);
    fx.explode(plan(), 0);
    fx.cancelFall();
    expect(fx.active).toBe(true);
    fx.clear();
    expect(fx.active).toBe(false);
  });

  it('puts the fire in the area that the bomb clears (a little beyond it too)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fx = new BombFx();
    fx.explode(plan({ area: [{ x: 50, y: 60, w: 20, h: 20 }] }), 0);
    const c = canvas();
    fx.draw(c.ctx, 100);
    const fire = c.circles.filter((x) => /hsl/.test(x.colour));
    expect(fire.length).toBeGreaterThan(0);
    for (const x of fire) {
      expect(x.x).toBeGreaterThanOrEqual(50 - 2.5 - 1e-6);
      expect(x.y).toBeGreaterThanOrEqual(60 - 2.5 - 1e-6);
      expect(x.x).toBeLessThanOrEqual(70 + 2.5 + 1e-6);
      expect(x.y).toBeLessThanOrEqual(80 + 2.5 + 1e-6);
    }
  });
});
