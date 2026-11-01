import { FocusGame, type FocusState } from './focus';
import { JigsawRoom, type Lock, type Refusal, type RoomEvent, type RoomResult, type RoomState } from './jigsawRoom';
import type { JigsawSetup } from './jigsawSetup';
import { makeOverlap, type OverlapGame, type OverlapState } from './overlap';
import { makeStrips, type StripsGame, type StripsState } from './strips';

/**
 * Tile Swap, Overlap and Strips played by several players at once. These puzzles have no piece that only one player can hold: everybody may move whatever they like at any time, each move is
 * a small operation (`BoardOp`) that the room checks, puts in order and hands back, and every screen applies the same operations in the same order. A move that no longer fits (the piece
 * was placed a moment ago by someone else) is refused, and the screen that made it takes the room's board again.
 *
 * What a player has in hand while dragging is on their own screen only; the board changes when the piece is put down.
 */

export const BOARD_KINDS = ['focus', 'overlap', 'strips'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export function isBoardKind(kind: unknown): kind is BoardKind {
  return (BOARD_KINDS as readonly unknown[]).includes(kind);
}

/** What makes a room's puzzle the same puzzle for everyone: the kind, the seed, the size of the picture and the options. */
export interface RoomSetup extends JigsawSetup {
  kind: 'jigsaw' | BoardKind;
}

export type BoardOp =
  /** Tile Swap: pieces `a` and `b` trade places (neither may be in its own place). */
  | { t: 'swap'; a: number; b: number }
  /** Overlap: the piece is put down with its centre on cell (x, y): it stays if that is where it belongs and it is turned right, else it goes back to its stack. */
  | { t: 'put'; piece: number; x: number; y: number }
  /** Overlap: a quarter turn. */
  | { t: 'turn'; piece: number }
  /** Overlap: the piece goes on top of another stack. */
  | { t: 'toStack'; piece: number; stack: number }
  /** Overlap: the top piece of a stack goes to the bottom (`dir` 1) or the bottom one to the top (`dir` -1). */
  | { t: 'cycle'; stack: number; dir: 1 | -1 }
  /** Strips: the strip is put down at this pose (its box's top left corner, turned `angle` quarter turns, on `tab`), on top of the others; it locks if it lies where it belongs. */
  | { t: 'place'; strip: number; x: number; y: number; angle: number; tab: number }
  /** A hint (not Sliding Tiles or Rotascope: see help.ts): the piece (a strip, in Strips) is put where it belongs. */
  | { t: 'hint'; piece: number }
  /** A bomb: every piece round the point is put where it belongs. The point is in picture pixels (Tile Swap), or a cell of the grid (Overlap; Strips: of the field, with its margin). */
  | { t: 'bomb'; x: number; y: number };

export type Board =
  | { kind: 'focus'; game: FocusGame }
  | { kind: 'overlap'; game: OverlapGame; cols: number; rows: number }
  | { kind: 'strips'; game: StripsGame; picCols: number; picRows: number };

export type BoardState = FocusState | OverlapState | StripsState;

/** The puzzle of a room, made from its setup alone (the screens and the server all make it this way). */
export function buildBoard(setup: RoomSetup & { kind: BoardKind }): Board {
  const { seed, width, height, opts } = setup;
  switch (setup.kind) {
    case 'focus':
      return { kind: 'focus', game: new FocusGame(width, height, { seed, pieces: opts.pieces, irregular: opts.irregular === 1 }) };
    case 'overlap':
      return { kind: 'overlap', ...makeOverlap(seed, width, height, opts) };
    case 'strips':
      return { kind: 'strips', ...makeStrips(seed, width, height, opts) };
  }
}

const whole = (n: unknown, lo: number, hi: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;

/** The hint or bomb of an operation, as far as every kind of puzzle reads them alike: the pieces it places, or null if it is neither. Nothing is changed. */
function helpOf(board: Board, op: BoardOp): { ok: false; stale?: boolean } | { ok: true; run(): number[] } | null {
  if (op.t !== 'hint' && op.t !== 'bomb') return null;
  const g = board.game;
  const count = board.kind === 'focus' ? board.game.count : board.game.total;
  if (op.t === 'hint') {
    if (!whole(op.piece, 0, count - 1)) return { ok: false };
    const left = board.kind === 'focus' ? !board.game.placed(op.piece) : board.kind === 'overlap' ? !board.game.done[op.piece] : !board.game.state[op.piece].locked;
    return left ? { ok: true, run: () => ((g as { hint(i: number): boolean }).hint(op.piece) ? [op.piece] : []) } : { ok: false, stale: true };
  }
  const [maxX, maxY] = board.kind === 'focus' ? [board.game.width, board.game.height] : board.kind === 'overlap' ? [board.cols - 1, board.rows - 1] : [board.game.cols - 1, board.game.rows - 1];
  if (typeof op.x !== 'number' || typeof op.y !== 'number' || !Number.isFinite(op.x) || !Number.isFinite(op.y) || op.x < 0 || op.y < 0 || op.x > maxX || op.y > maxY) return { ok: false };
  if (board.kind !== 'focus' && (!Number.isInteger(op.x) || !Number.isInteger(op.y))) return { ok: false };
  return { ok: true, run: () => (g as { bomb(x: number, y: number): number[] }).bomb(op.x, op.y) };
}

/** What an operation did, for the screen that shows it. */
export interface BoardResult {
  /** The operation was allowed and has been applied. */
  ok: boolean;
  /** Not allowed (`ok` is false) only because the board is not as it was when the player made it: the piece was put in its place a moment ago by someone else. Otherwise a refusal means the numbers make no sense. */
  stale?: boolean;
  /** Overlap `put` / Strips `place` / Tile Swap `swap`: a piece now lies where it belongs. */
  placed?: boolean;
}

/** Applies an operation to a board if it is allowed in the state the board is in (anything else is `ok: false` and changes nothing). The same function runs on the server and on every screen. */
export function applyBoardOp(board: Board, op: BoardOp): BoardResult {
  if (!op || typeof op !== 'object') return { ok: false };
  const help = helpOf(board, op);
  if (help) {
    if (!help.ok) return help;
    const hit = help.run();
    return { ok: hit.length > 0, stale: hit.length === 0 || undefined, placed: hit.length > 0 };      // (a bomb that placed nothing is a refusal: nothing was there)
  }
  switch (board.kind) {
    case 'focus': {
      const g = board.game;
      if (op.t !== 'swap' || !whole(op.a, 0, g.count - 1) || !whole(op.b, 0, g.count - 1) || op.a === op.b) return { ok: false };
      if (g.placed(op.a) || g.placed(op.b)) return { ok: false, stale: true };
      g.swap(op.a, op.b);
      return { ok: true, placed: g.placed(op.a) || g.placed(op.b) };
    }
    case 'overlap': {
      const g = board.game;
      if (op.t === 'cycle') {
        if (!whole(op.stack, 0, g.stacks.length - 1) || (op.dir !== 1 && op.dir !== -1)) return { ok: false };
        g.cycle(op.stack, op.dir);
        return { ok: true };
      }
      if (op.t !== 'put' && op.t !== 'turn' && op.t !== 'toStack') return { ok: false };
      if (!whole(op.piece, 0, g.total - 1)) return { ok: false };
      if (op.t === 'toStack' && !whole(op.stack, 0, g.stacks.length - 1)) return { ok: false };
      if (op.t === 'put' && (!whole(op.x, 0, board.cols - 1) || !whole(op.y, 0, board.rows - 1))) return { ok: false };
      if (g.done[op.piece]) return { ok: false, stale: true };
      if (op.t === 'turn') {
        g.rotate(op.piece);
        return { ok: true };
      }
      if (op.t === 'toStack') {
        g.moveToStack(op.piece, op.stack);
        return { ok: true };
      }
      return { ok: true, placed: g.drop(op.piece, op.x, op.y) === 'placed' };
    }
    case 'strips': {
      const g = board.game;
      if (op.t !== 'place' || !whole(op.strip, 0, g.total - 1)) return { ok: false };
      if (!whole(op.angle, 0, 3) || !whole(op.tab, 0, g.tabs - 1) || !whole(op.x, -1000, 1000) || !whole(op.y, -1000, 1000)) return { ok: false };
      if (g.state[op.strip].locked) return { ok: false, stale: true };
      const s = g.state[op.strip];
      s.angle = op.angle;
      s.tab = op.tab;
      s.locked = false;
      g.moveTo(op.strip, op.x, op.y);                          // (kept inside the field)
      g.bringToFront(op.strip);
      return { ok: true, placed: g.lockIfHome(op.strip) };
    }
  }
}

const mix = (h: number, n: number): number => Math.imul(h ^ (n + 1), 16777619) >>> 0;

/**
 * A number that says what the board comes to, which the room puts in every event (as `groups`, which a Jigsaw uses for its group count): a screen that has the same operations applied and
 * gets another number has drifted, and asks for the room's board. It leaves out what a player's own hand changes before the piece is put down (where a strip being dragged is).
 */
export function boardCheck(board: Board): number {
  let h = 2166136261;
  switch (board.kind) {
    case 'focus':
      for (const s of board.game.slotOf) h = mix(h, s);
      return h;
    case 'overlap':
      board.game.done.forEach((d, i) => (h = mix(h, d ? 1 + board.game.rot[i] * 2 : board.game.rot[i] * 2)));
      for (const s of board.game.stacks) {
        h = mix(h, 0x7fffffff);
        for (const id of s) h = mix(h, id);
      }
      return h;
    case 'strips':
      board.game.state.forEach((s, i) => (h = mix(h, s.locked ? i + 1 : 0)));
      return h;
  }
}

/** What the room does besides keeping the board: the same calls as a Jigsaw room, so that the service can hold either. */
export interface RoomRules {
  readonly solved: boolean;
  state(): RoomState;
  holder(now: number): Lock | null;
  unreserve(player: string): void;
  renew(player: string, now: number): { ok: true; until: number } | { ok: false; reason: Refusal };
  submit(player: string, cmd: unknown, now: number): RoomResult;
}

export class BoardRoom implements RoomRules {
  readonly board: Board;
  private v = 0;
  private done = false;

  constructor(readonly setup: RoomSetup & { kind: BoardKind }, state?: RoomState) {
    this.board = buildBoard(setup);
    if (state) {
      (this.board.game as { restore(s: BoardState): void }).restore(state.game as BoardState);       // throws if it is not this puzzle
      this.v = state.v;
      this.done = state.solved;
    }
  }

  get version(): number {
    return this.v;
  }

  get solved(): boolean {
    return this.done;
  }

  state(): RoomState {
    return { v: this.v, lock: null, solved: this.done, game: this.board.game.snapshot(), reserved: [] };
  }

  /** Nobody holds a piece in these puzzles. */
  holder(): null {
    return null;
  }

  unreserve(): void {
    // (nothing is reserved)
  }

  renew(): { ok: false; reason: Refusal } {
    return { ok: false, reason: this.done ? 'ended' : 'not-holder' };
  }

  submit(player: string, cmd: unknown, _now: number): RoomResult {
    if (this.done) return { ok: false, reason: 'ended' };
    const op = cmd as BoardOp;
    if (!op || typeof op !== 'object' || typeof op.t !== 'string') return { ok: false, reason: 'bad' };
    // an operation of another kind of puzzle, or one with numbers that make no sense, is `bad`; one that was fine but no longer fits the board is `no-group` (someone was first)
    if (!shapeOk(this.board.kind, op)) return { ok: false, reason: 'bad' };
    const res = applyBoardOp(this.board, op);
    if (!res.ok) return { ok: false, reason: res.stale ? 'no-group' : 'bad' };
    this.v++;
    this.done = this.board.game.solved;
    const event: RoomEvent = { v: this.v, by: player, op, lock: null, reserved: [], joins: 0, groups: boardCheck(this.board), solved: this.done };
    return { ok: true, event };
  }
}

/** Is this operation one that this kind of puzzle has (whatever state it is in)? */
function shapeOk(kind: BoardKind, op: BoardOp): boolean {
  const ops: Record<BoardKind, readonly string[]> = { focus: ['swap', 'hint', 'bomb'], overlap: ['put', 'turn', 'toStack', 'cycle', 'hint', 'bomb'], strips: ['place', 'hint', 'bomb'] };
  return ops[kind].includes(op.t);
}

/** The room of a setup: a Jigsaw's, or the kind of room the other puzzles have. */
export function openRoom(setup: RoomSetup, state?: RoomState): RoomRules {
  if (setup.kind === 'jigsaw') return new JigsawRoom(setup, state);
  if (!isBoardKind(setup.kind)) throw new Error(`no room for ${String(setup.kind)}`);
  return new BoardRoom(setup as RoomSetup & { kind: BoardKind }, state);
}
