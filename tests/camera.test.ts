import { describe, expect, it } from 'vitest';
import { Camera } from '../src/sessions/camera';

// a 400 x 200 board on a 1000 x 800 canvas (no window here: one device pixel per CSS pixel, a 12 pixel margin)
const make = (): { cam: Camera; draws: () => number } => {
  let n = 0;
  return { cam: new Camera(400, 200, 2, () => n++), draws: () => n };
};

describe('Camera', () => {
  it('shows the whole board, centred, until it is zoomed', () => {
    const { cam } = make();
    const v = cam.view(1000, 800);
    expect(v.scale).toBeCloseTo((1000 - 24) / 400);
    expect(v.ox).toBeCloseTo(12);
    expect(v.oy).toBeCloseTo((800 - 200 * v.scale) / 2);
    expect(cam.zoomLabel()).toBe('100%');
    expect(cam.canPan).toBe(false);
    expect(cam.lineK()).toBe(1);
  });

  it('keeps the point under the pointer where it is when it zooms', () => {
    const { cam } = make();
    cam.view(1000, 800);
    const at = { x: 300, y: 50 };
    const before = cam.screen(at);
    cam.zoomAt(at, 1.5);
    const v = cam.view(1000, 800);
    expect(v.scale).toBeCloseTo(((1000 - 24) / 400) * 1.5);
    const after = cam.screen(at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo((800 - 200 * v.scale) / 2 + 50 * v.scale);      // (the board is still shorter than the canvas: it stays in the middle, so this point cannot stay)
    expect(cam.zoomLabel()).toBe('150%');
    expect(cam.canPan).toBe(true);
    expect(cam.lineK()).toBeCloseTo(1 / 1.5);
  });

  it('never zooms out past the whole board, nor in past the limit', () => {
    const { cam } = make();
    cam.view(1000, 800);
    cam.zoomBy(0.1);
    expect(cam.view(1000, 800).scale).toBeCloseTo((1000 - 24) / 400);
    cam.zoomBy(1000);
    expect(cam.view(1000, 800).scale).toBeCloseTo(Math.max(((1000 - 24) / 400) * 2, 2));
  });

  it('keeps the board in view when it is moved, and in the middle where it is smaller than the view', () => {
    const { cam } = make();
    cam.view(1000, 800);
    cam.zoomBy(3);
    cam.panBy(-1e6, 1e6);                                          // as far as it goes
    const v = cam.view(1000, 800);
    expect(v.ox).toBeLessThanOrEqual(12 + 1e-6);                   // the board's left edge is no further in than the margin
    expect(v.oy + 200 * v.scale).toBeGreaterThanOrEqual(800 - 12 - 1e-6);
    cam.zoomFit();
    const w = cam.view(1000, 800);
    expect(w.oy).toBeCloseTo((800 - 200 * w.scale) / 2);           // (the short side of the board stays in the middle)
  });

  it('moves with a pinch: what was under the first point is under the second', () => {
    const { cam } = make();
    cam.view(1000, 800);
    const from = { x: 500, y: 400 };
    const world = cam.world(from);
    cam.pinch(from, { x: 520, y: 400 }, 2);
    const v = cam.view(1000, 800);
    expect(v.scale).toBeCloseTo(((1000 - 24) / 400) * 2);
    const now = cam.screen(world);
    expect(now.x).toBeCloseTo(520);
    expect(now.y).toBeCloseTo(400);
  });

  it('stays as far in, relative to the whole board, when the canvas changes shape', () => {
    const { cam } = make();
    cam.view(1000, 800);
    cam.zoomBy(2);
    cam.view(500, 800);
    expect(cam.zoomLabel()).toBe('200%');
  });

  describe('a press that may move it', () => {
    it('is no pan when the whole board shows: nothing to move', () => {
      const { cam } = make();
      cam.view(1000, 800);
      cam.startPan({ x: 100, y: 100 });
      expect(cam.panning).toBe(false);
      expect(cam.panTo({ x: 300, y: 100 })).toBe(false);
      expect(cam.endPan()).toBe(false);
    });

    it('is a tap until it has moved a few pixels, then keeps the pressed point under the pointer', () => {
      const { cam, draws } = make();
      cam.view(1000, 800);
      cam.zoomBy(3);
      const start = cam.screen({ x: 200, y: 100 });
      const p = cam.world(start);
      cam.startPan(p);
      expect(cam.panning).toBe(true);
      const n = draws();
      expect(cam.panTo(cam.world({ x: start.x + 2, y: start.y }))).toBe(false);        // a tap's wobble
      expect(draws()).toBe(n);
      let at = { x: start.x + 60, y: start.y + 20 };
      expect(cam.panTo(cam.world(at))).toBe(true);
      cam.view(1000, 800);
      at = { x: start.x + 90, y: start.y + 30 };                   // the pointer moves on (the view has followed)
      expect(cam.panTo(cam.world(at))).toBe(true);
      cam.view(1000, 800);
      const now = cam.screen(p);
      expect(now.x).toBeCloseTo(at.x);
      expect(now.y).toBeCloseTo(at.y);
      expect(cam.endPan()).toBe(true);
      expect(cam.panning).toBe(false);
    });
  });
});
