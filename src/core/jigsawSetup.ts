import { isEdgePiece, JigsawGame, layoutJigsaw, pickPlaced, rotVec, type JigsawLayout } from './jigsaw';
import { Rng } from './rng';

/** The table is this many puzzles wide and high. */
export const WORLD_K = 4;
/** Pieces start this far round the puzzle (in puzzle widths / heights), not all over the table. */
export const SCATTER_K = 0.75;
/** How close, as a share of a piece's size, a group has to lie to a neighbour to join it: the least and the most (a player's screen picks one between). */
export const TOL_MIN_K = 0.2;
export const TOL_MAX_K = 0.5;

/** Everything that makes one Jigsaw puzzle the same puzzle for everyone: the seed, the size of the picture and the difficulty options. */
export interface JigsawSetup {
  seed: number;
  width: number;
  height: number;
  opts: Record<string, number>;
}

export interface JigsawBoard {
  layout: JigsawLayout;
  game: JigsawGame;
  worldW: number;
  worldH: number;
  /** Where the finished picture goes on the table. */
  frameX: number;
  frameY: number;
}

/**
 * The pieces, their shapes and where each starts on the table. Both the game on a player's screen and a server that keeps a shared board make the puzzle with this, so
 * they start with exactly the same one: nothing in here depends on the screen (the table is measured in picture pixels).
 */
export function buildJigsaw(setup: JigsawSetup): JigsawBoard {
  const { width, height, opts } = setup;
  const rng = new Rng(setup.seed);
  const turning = opts.turning === 1;
  const l = layoutJigsaw(rng, width, height, opts.pieces);
  const puzzleW = l.cols * l.size;
  const puzzleH = l.rows * l.size;
  const worldW = puzzleW * WORLD_K;
  const worldH = puzzleH * WORLD_K;
  const frameX = (worldW - puzzleW) / 2;
  const frameY = (worldH - puzzleH) / 2;
  const mx = puzzleW * SCATTER_K;
  const my = puzzleH * SCATTER_K;
  const edgesInside = opts.edges === 1;
  // its own generator, so that the way the other pieces are scattered does not depend on which are placed
  const placed = pickPlaced(l, new Rng((setup.seed ^ 0x2f6b9d1) >>> 0), opts.placed ?? 0, edgesInside);
  // every loose piece starts somewhere round the frame, not on it (the edge pieces, if asked, in the frame's area instead, not where they belong)
  const game = new JigsawGame(l, (i) => {
    const c = i % l.cols;
    const r = Math.floor(i / l.cols);
    let x = 0;
    let y = 0;
    if (edgesInside && isEdgePiece(l.cols, l.rows, i)) {
      x = frameX + rng.unit() * (puzzleW - l.size);
      y = frameY + rng.unit() * (puzzleH - l.size);
    } else {
      for (let tries = 0; tries < 20; tries++) {
        x = frameX - mx + rng.unit() * (puzzleW + 2 * mx - l.size);
        y = frameY - my + rng.unit() * (puzzleH + 2 * my - l.size);
        const onFrame = x + l.size > frameX && x < frameX + puzzleW && y + l.size > frameY && y < frameY + puzzleH;
        if (!onFrame) break;
      }
    }
    const rot = turning ? rng.below(4) : 0;
    // the piece's cell centre, turned, lies at the chosen spot
    const [cx, cy] = rotVec(rot, (c + 0.5) * l.size, (r + 0.5) * l.size);
    return { rot, dx: x + l.size / 2 - frameX - cx, dy: y + l.size / 2 - frameY - cy };
  }, placed);
  return { layout: l, game, worldW, worldH, frameX, frameY };
}

/**
 * What a player can do to the board that others must see. A player's screen and the server apply the very same operations with `applyOp`, so that they end up with the same
 * board. (While a piece is being dragged it only moves on the screen of the player who holds it; the operations are what is left when it is let go.)
 */
export type JigsawOp =
  /** A group is picked up: it goes to the front. */
  | { t: 'grab'; gid: number }
  /** The group is put down where it is (turned `rot` quarter turns, offset (dx, dy)); with `tol` it then joins whatever it lies right against, within that many picture pixels. */
  | { t: 'drop'; gid: number; dx: number; dy: number; rot: number; tol: number | null }
  /** A loose group is turned a quarter turn about its middle; with `tol` it then joins what it lies right against. */
  | { t: 'rotate'; gid: number; tol: number | null };

/** Applies an operation. A group that is not there, or is part of the picture already, is left alone. Returns the id of the group that now holds the operation's group, and how many joins happened. */
export function applyOp(game: JigsawGame, op: JigsawOp): { id: number; joins: number } {
  const g = game.groups.get(op.gid);
  if (!g || g.anchored) return { id: op.gid, joins: 0 };
  switch (op.t) {
    case 'grab':
      game.bringToFront(op.gid);
      return { id: op.gid, joins: 0 };
    case 'drop':
      game.setPose(op.gid, op.dx, op.dy, op.rot);
      return op.tol === null ? { id: op.gid, joins: 0 } : game.connect(op.gid, op.tol);
    case 'rotate': {
      const [cx, cy] = game.centre(op.gid);
      game.rotate(op.gid, cx, cy);
      return op.tol === null ? { id: op.gid, joins: 0 } : game.connect(op.gid, op.tol);
    }
  }
}
