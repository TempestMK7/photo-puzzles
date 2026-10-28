import type { JigsawState } from './jigsaw';
import { applyOp, buildJigsaw, TOL_MAX_K, TOL_MIN_K, type JigsawBoard, type JigsawOp, type JigsawSetup } from './jigsawSetup';

/**
 * A Jigsaw puzzle that several players share. This is the rule keeper: whoever runs a room (a server, or a test) gives it the players' commands and publishes what it answers.
 * It has no clock, no network and no storage; the caller says what time it is, and keeps the state between commands.
 *
 * Only one player holds a piece at a time. A lock is taken by picking a group up and given back by putting it down, and it runs out on its own `LOCK_MS` after the holder
 * last renewed it: nothing has to notice that a player has gone, the next one to ask just gets the piece. Everything else a player does to the board is an operation
 * (`JigsawOp`), which the room checks, applies to its own board, and hands back so that every player's screen can apply the same one.
 */

/** How long a hand stays on a piece without being renewed. */
export const LOCK_MS = 10_000;

export interface Lock {
  holder: string;
  gid: number;
  /** When the hold runs out (the caller's clock). */
  until: number;
}

export type Command = JigsawOp | { t: 'release' };

/** What the room tells everyone after it accepted a command. */
export interface RoomEvent {
  /** Counts up by one with every event: a player that sees a gap has missed one and asks for the whole state again. */
  v: number;
  by: string;
  /** The operation to apply to the board (a release has none). `tol` is what the room allowed, which may differ from what was asked. */
  op?: JigsawOp;
  /** Who holds a piece now. */
  lock: Lock | null;
  /** How many groups the operation joined, and whether that finished the puzzle. */
  joins: number;
  solved: boolean;
}

export type Refusal =
  /** Another player holds a piece (`holder`). */
  | 'busy'
  /** The player does not hold that piece. */
  | 'not-holder'
  | 'no-group'
  /** Numbers that make no sense. */
  | 'bad'
  /** The puzzle is solved. */
  | 'ended';

export type RoomResult = { ok: true; event: RoomEvent } | { ok: false; reason: Refusal; holder?: string };

/** What a room is, apart from its setup: enough to carry on after a pause. */
export interface RoomState {
  v: number;
  lock: Lock | null;
  solved: boolean;
  game: JigsawState;
}

export class JigsawRoom {
  readonly board: JigsawBoard;
  private v = 0;
  private lock: Lock | null = null;
  private done = false;

  constructor(readonly setup: JigsawSetup, state?: RoomState) {
    this.board = buildJigsaw(setup);
    if (state) {
      this.board.game.restore(state.game);               // throws if it is not this puzzle
      this.v = state.v;
      this.lock = state.lock;
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
    return { v: this.v, lock: this.lock && { ...this.lock }, solved: this.done, game: this.board.game.snapshot() };
  }

  /** Who holds a piece at time `now`; a hold that has run out is nobody's. */
  holder(now: number): Lock | null {
    return this.lock && this.lock.until > now ? this.lock : null;
  }

  /** The hand stays on the piece for another `LOCK_MS`. Returns when it now runs out, or why not. */
  renew(player: string, now: number): { ok: true; until: number } | { ok: false; reason: Refusal } {
    if (this.done) return { ok: false, reason: 'ended' };
    if (this.lock?.holder !== player) return { ok: false, reason: 'not-holder' };       // (a hold that ran out but nobody took over is still the holder's)
    this.lock.until = now + LOCK_MS;
    return { ok: true, until: this.lock.until };
  }

  submit(player: string, cmd: Command, now: number): RoomResult {
    if (this.done) return { ok: false, reason: 'ended' };
    const g = this.board.game;
    const others = this.holder(now);
    if (cmd.t === 'release') {
      if (this.lock?.holder !== player) return { ok: false, reason: 'not-holder' };
      this.lock = null;
      return this.accept(player, undefined, 0);
    }
    if (!Number.isInteger(cmd.gid)) return { ok: false, reason: 'bad' };
    const grp = g.groups.get(cmd.gid);
    if (!grp || grp.anchored) return { ok: false, reason: 'no-group' };
    const size = this.board.layout.size;
    const tol = (t: number | null): number | null | undefined =>
      t === null ? null : typeof t === 'number' && Number.isFinite(t) ? Math.min(TOL_MAX_K * size, Math.max(TOL_MIN_K * size, t)) : undefined;

    switch (cmd.t) {
      case 'grab': {
        if (others && others.holder !== player) return { ok: false, reason: 'busy', holder: others.holder };
        this.lock = { holder: player, gid: cmd.gid, until: now + LOCK_MS };
        return this.accept(player, this.run(cmd).op, 0);
      }
      case 'drop': {
        if (this.lock?.holder !== player || this.lock.gid !== cmd.gid) return { ok: false, reason: 'not-holder' };
        const t = tol(cmd.tol);
        const limit = Math.max(this.board.worldW, this.board.worldH);
        const sane = [cmd.dx, cmd.dy].every((x) => typeof x === 'number' && Number.isFinite(x) && x > -limit && x < 2 * limit) && Number.isInteger(cmd.rot) && cmd.rot >= 0 && cmd.rot <= 3;
        if (t === undefined || !sane) return { ok: false, reason: 'bad' };
        const joins = this.run({ t: 'drop', gid: cmd.gid, dx: cmd.dx, dy: cmd.dy, rot: cmd.rot, tol: t });
        this.lock = null;
        return this.accept(player, joins.op, joins.joins);
      }
      case 'rotate': {
        if (others && others.holder !== player) return { ok: false, reason: 'busy', holder: others.holder };
        if (this.lock?.holder === player && this.lock.gid !== cmd.gid) return { ok: false, reason: 'busy', holder: player };      // it has a piece in hand: let that go first
        const t = tol(cmd.tol);
        if (t === undefined) return { ok: false, reason: 'bad' };
        const r = this.run({ t: 'rotate', gid: cmd.gid, tol: t });
        return this.accept(player, r.op, r.joins);
      }
    }
  }

  private run(op: JigsawOp): { op: JigsawOp; joins: number } {
    const res = applyOp(this.board.game, op);
    return { op, joins: res.joins };
  }

  private accept(by: string, op: JigsawOp | undefined, joins: number): RoomResult {
    this.v++;
    if (this.board.game.solved) {
      this.done = true;
      this.lock = null;
    }
    return { ok: true, event: { v: this.v, by, op, lock: this.lock && { ...this.lock }, joins, solved: this.done } };
  }
}
