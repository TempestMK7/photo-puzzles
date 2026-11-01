import { describe, expect, it } from 'vitest';
import type { Anim } from '../src/render';
import { rectNow, SWAP_MS } from '../src/render';
import { VideoLayer } from '../src/sessions/videoGl';
import type { FocusGame } from '../src/core/focus';

/** A layer that only collects its triangles (there is no graphics card here): [x, y, u, v, a] of every vertex, in order. */
function collector(): { layer: VideoLayer; vertices: () => number[][] } {
  const layer = Object.create(VideoLayer.prototype) as VideoLayer;
  const inner = layer as unknown as { data: Float32Array; n: number };
  inner.data = new Float32Array(8 * 6 * 4);
  inner.n = 0;
  return {
    layer,
    vertices: () => Array.from({ length: inner.n / 8 }, (_, i) => [0, 1, 2, 3, 7].map((k) => inner.data[i * 8 + k])),
  };
}

const area = (t: number[][]): number => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])) / 2;

describe('VideoLayer shapes', () => {
  it('turns a square clockwise with what it shows: the picture corner that was at the top left goes to the top right after one quarter turn', () => {
    const { layer, vertices } = collector();
    layer.turned(10, 20, 5, 1, 0, 0, 1, 1);
    const v = vertices();
    expect(v).toHaveLength(6);
    const topLeftOfPicture = v[0];                                  // the first vertex takes the colour of picture corner (0, 0)
    expect([topLeftOfPicture[2], topLeftOfPicture[3]]).toEqual([0, 0]);
    expect([topLeftOfPicture[0], topLeftOfPicture[1]]).toEqual([15, 15]);        // (-5, -5) turned a quarter clockwise about (10, 20)
    const unturned = collector();
    unturned.layer.turned(10, 20, 5, 0, 0, 0, 1, 1);
    expect(unturned.vertices()[0].slice(0, 2)).toEqual([5, 15]);
    const full = collector();
    full.layer.turned(10, 20, 5, 4, 0, 0, 1, 1);
    expect(full.vertices()[0].slice(0, 2)).toEqual([5, 15]);
  });

  it('asks for the layer\'s own picture for a piece that shows it, and the video otherwise', () => {
    const { layer, vertices } = collector();
    layer.turned(0, 0, 1, 0, 0, 0, 1, 1, true);
    layer.turned(0, 0, 1, 0, 0, 0, 1, 1);
    const v = vertices();
    expect(v.slice(0, 6).every((p) => p[4] === -2)).toBe(true);
    expect(v.slice(6).every((p) => p[4] === -1)).toBe(true);
  });

  it('draws the outline of a rectangle in four pieces that do not overlap, as wide as the pen', () => {
    const { layer, vertices } = collector();
    layer.frame(10, 10, 100, 50, 2, [1, 1, 1, 0.5]);
    const v = vertices();
    expect(v).toHaveLength(24);
    let total = 0;
    for (let i = 0; i < v.length; i += 3) total += area(v.slice(i, i + 3));
    expect(total).toBeCloseTo(102 * 52 - 98 * 48, 6);               // the outer rectangle less the inner one
  });
});

describe('rectNow', () => {
  const game = { slotRect: (i: number) => ({ x: i * 10, y: 0, w: 10, h: 10 }) } as unknown as FocusGame;
  const from = { x: 0, y: 0, w: 10, h: 10 };
  const to = { x: 100, y: 0, w: 10, h: 10 };

  it('is the slot when nothing moves it, on the way while an animation runs, and drops an animation that has ended', () => {
    const anims = new Map<number, Anim>([[3, { from, to, start: 1000 }]]);
    expect(rectNow(game, anims, 2, 1000)).toEqual({ x: 20, y: 0, w: 10, h: 10 });
    const half = rectNow(game, anims, 3, 1000 + SWAP_MS / 2);
    expect(half.x).toBeGreaterThan(40);
    expect(half.x).toBeLessThan(60);
    expect(anims.has(3)).toBe(true);
    expect(rectNow(game, anims, 3, 1000 + SWAP_MS)).toEqual({ x: 30, y: 0, w: 10, h: 10 });
    expect(anims.has(3)).toBe(false);
  });
});
