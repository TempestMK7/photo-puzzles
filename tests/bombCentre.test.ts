import { describe, expect, it } from 'vitest';
import { FocusGame } from '../src/core/focus';
import { buildJigsaw } from '../src/core/jigsawSetup';

// A bomb is centred on the piece that the pointer was over: anywhere on the same piece it names the same pieces.

describe('the centre of a bomb', () => {
  it('is the middle of the Jigsaw piece\'s place that the point is over, and the same for every point on it', () => {
    const { game } = buildJigsaw({ seed: 3, width: 600, height: 400, opts: { pieces: 48 } });
    const s = game.size;
    const centre = game.bombCentre(2.2 * s + 3, 1.1 * s + 5);
    expect(centre).toEqual({ x: 2.5 * s, y: 1.5 * s });
    const hits = game.bombHits(centre.x, centre.y).join();
    for (const [dx, dy] of [[0.01, 0.01], [0.99, 0.99], [0.5, 0.2], [0.2, 0.9]]) {
      const at = game.bombCentre((2 + dx) * s, (1 + dy) * s);
      expect(at).toEqual(centre);
      expect(game.bombHits(at.x, at.y).join()).toBe(hits);
    }
  });

  it('is the nearest piece\'s middle for a point outside the Jigsaw picture', () => {
    const { game } = buildJigsaw({ seed: 3, width: 600, height: 400, opts: { pieces: 48 } });
    const s = game.size;
    expect(game.bombCentre(-50, -50)).toEqual({ x: 0.5 * s, y: 0.5 * s });
    expect(game.bombCentre(1e6, 1e6).x).toBe((game.cols - 0.5) * s);
  });

  it('is the middle of the Tile Swap piece\'s home that the point is over, and the same for every point on it', () => {
    const game = new FocusGame(400, 300, { seed: 11, pieces: 20, irregular: true });
    const r = game.homes[7];
    const centre = game.bombCentre(r.x + r.w * 0.1, r.y + r.h * 0.9);
    expect(centre).toEqual({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    expect(game.bombCentre(r.x + r.w * 0.8, r.y + r.h * 0.2)).toEqual(centre);
    expect(game.bombHits(centre.x, centre.y)).toContain(7);
  });
});
