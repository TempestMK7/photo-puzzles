import { describe, expect, it } from 'vitest';
import { GOLD, GroupRipple, Ripples } from '../src/sessions/ripple';

describe('GroupRipple', () => {
  const cols = 10;
  const size = 50;
  const members = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it('starts at the pieces that were put down and travels outward, lighting each piece in turn', () => {
    const r = new GroupRipple();
    r.start(7, members, [0], cols, size, 1000);
    expect(r.step(1000 + 60)).toBe(true);
    expect(r.ks[0]).toBeGreaterThan(0);                           // the first piece is lit at once ...
    expect(r.ks[9]).toBe(0);                                      // ... and the far end has not been reached
    let reachedFarEnd = false;
    for (let t = 1000; t < 3000; t += 16) {
      if (!r.step(t)) break;
      if (r.ks[9] > 0.5) reachedFarEnd = true;
      expect(Math.max(...r.ks)).toBeLessThanOrEqual(1);
      expect(Math.min(...r.ks)).toBeGreaterThanOrEqual(0);
    }
    expect(reachedFarEnd).toBe(true);
  });

  it('is over within about a second however many pieces are locked together, and then forgets the group', () => {
    const r = new GroupRipple();
    const many = Array.from({ length: 400 }, (_, i) => i);
    r.start(3, many, [0], 20, size, 0);
    expect(r.step(1200)).toBe(false);
    expect(r.gid).toBe(-1);
    expect(r.members).toEqual([]);
  });

  it('a single piece just glows and fades', () => {
    const r = new GroupRipple();
    r.start(1, [4], [4], cols, size, 0);
    expect(r.step(150)).toBe(true);
    expect(r.ks[0]).toBeGreaterThan(0.5);
    expect(r.step(600)).toBe(false);
  });
});

describe('GroupRipple as a cascade', () => {
  const cols = 10;
  const size = 50;
  const row = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it('lights the pieces that were placed one after the other, each `step` after the one before, in the order given', () => {
    const r = new GroupRipple();
    r.start(2, row, [3, 4, 5], cols, size, 1000, 200);
    expect(r.step(1000 + 100)).toBe(true);
    expect(r.ks[3]).toBeGreaterThan(0);
    expect(r.ks[4]).toBe(0);
    expect(r.ks[5]).toBe(0);
    r.step(1000 + 300);
    expect(r.ks[4]).toBeGreaterThan(0);
    expect(r.ks[5]).toBe(0);
    r.step(1000 + 500);
    expect(r.ks[5]).toBeGreaterThan(0);
  });

  it('lights the others with the placed piece that is nearest to them, and is over soon after the last of those', () => {
    const r = new GroupRipple();
    r.start(2, row, [1, 8], cols, size, 0, 200);
    r.step(150);
    expect(r.ks[0]).toBeGreaterThan(0);                           // beside the first ...
    expect(r.ks[9]).toBe(0);                                      // ... and the one beside the second has to wait
    expect(r.step(200 + 3000)).toBe(false);
    expect(r.gid).toBe(-1);
  });

  it('keeps the colour it was started with (none: white)', () => {
    const r = new GroupRipple();
    expect(r.css).toBeNull();
    r.start(1, [4], [4], cols, size, 0, 0, '#4ac8ff');
    expect(r.css).toBe('#4ac8ff');
    r.start(1, [4], [4], cols, size, 0);
    expect(r.css).toBeNull();
  });
});

describe('Ripples', () => {
  /** A canvas stand-in that notes the ring colour of every stroke. */
  function canvas() {
    const strokes: string[] = [];
    const ctx = {
      strokeStyle: '',
      fillStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillRect() {},
      arc() {},
      stroke() {
        strokes.push(this.strokeStyle);
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
  }
  const rect = { x: 0, y: 0, w: 10, h: 10 };

  it('draws its ring in gold, or in the colour of the player who put the piece there', () => {
    const r = new Ripples();
    r.add([rect], 0);
    r.add([rect], 0, 0, '#4ac8ff');
    const c = canvas();
    r.draw(c.ctx, 100);
    expect(c.strokes).toContain(GOLD);
    expect(c.strokes).toContain('#4ac8ff');
    expect(c.strokes.filter((x) => x === '#4ac8ff')).toHaveLength(3);          // (the ring is drawn three times)
  });

  it('shows a ripple that starts later only once its time has come', () => {
    const r = new Ripples();
    r.add([rect], 0, 400, '#ff6b6b');
    const c = canvas();
    expect(r.draw(c.ctx, 200)).toBe(true);
    expect(c.strokes).toHaveLength(0);
    r.draw(c.ctx, 500);
    expect(c.strokes).toHaveLength(3);
  });
});
