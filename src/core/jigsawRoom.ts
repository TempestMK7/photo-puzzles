import { TRAY_MAX, type JigsawState } from './jigsaw';
import { centreAt, traySize } from './trays';
import { applyOp, buildJigsaw, TOL_MAX_K, TOL_MIN_K, type JigsawBoard, type JigsawOp, type JigsawSetup } from './jigsawSetup';

/**
 * A Jigsaw puzzle that several players share. This is the rule keeper: whoever runs a room (a server, or a test) gives it the players' commands and publishes what it answers.
 * It has no clock, no network and no storage; the caller says what time it is, and keeps the state between commands.
 *
 * Only one player holds a piece in hand at a time. Besides that, every player may have **one piece reserved**: the one they picked up last, or clicked on (it stays theirs, and shows in their
 * colour on everyone's screen, until they click somewhere else, pick up another, or `RESERVE_MS` pass without them touching it). Another player can neither pick up nor turn a reserved piece.
 * Only one player holds a piece at a time. A lock is taken by picking a group up and given back by putting it down, and it runs out on its own `LOCK_MS` after the holder
 * last renewed it: nothing has to notice that a player has gone, the next one to ask just gets the piece. Everything else a player does to the board is an operation
 * (`JigsawOp`), which the room checks, applies to its own board, and hands back so that every player's screen can apply the same one.
 */

/** How long a hand stays on a piece without being renewed. */
export const LOCK_MS = 10_000;
/** How long a piece stays reserved for a player after they last touched it. */
export const RESERVE_MS = 15_000;

/** A piece that a player has picked up or clicked on, and that nobody else may take until `until` (the caller's clock) or until they let it go. */
export interface Reservation {
  holder: string;
  /** A piece of the group. */
  piece: number;
  until: number;
}

export interface Lock {
  holder: string;
  /** A piece of the group in hand. */
  piece: number;
  /** When the hold runs out (the caller's clock). */
  until: number;
}

export type Command = JigsawOp | { t: 'release' } | { t: 'select'; piece: number } | { t: 'unselect' };

/** What the room tells everyone after it accepted a command. */
export interface RoomEvent {
  /** Counts up by one with every event: a player that sees a gap has missed one and asks for the whole state again. */
  v: number;
  by: string;
  /** The operation to apply to the board (a release has none). `tol` is what the room allowed, which may differ from what was asked. */
  op?: JigsawOp;
  /** Who holds a piece now. */
  lock: Lock | null;
  /** Every piece that is reserved now (a screen replaces what it had by this). */
  reserved: Reservation[];
  /** How many groups the operation joined, and whether that finished the puzzle. */
  joins: number;
  /** How many groups the board has now: a screen that counts a different number has gone wrong and asks for the whole state. */
  groups: number;
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
  /** The reserved pieces (a room from before they existed has none). */
  reserved?: Reservation[];
}

export class JigsawRoom {
  readonly board: JigsawBoard;
  private v = 0;
  private lock: Lock | null = null;
  private done = false;
  private reserved: Reservation[] = [];
  private at = 0;

  constructor(readonly setup: JigsawSetup, state?: RoomState) {
    this.board = buildJigsaw(setup);
    if (state) {
      this.board.game.restore(state.game);               // throws if it is not this puzzle
      this.v = state.v;
      this.lock = state.lock;
      this.done = state.solved;
      this.reserved = (state.reserved ?? []).map((r) => ({ ...r }));
    }
  }

  get version(): number {
    return this.v;
  }

  get solved(): boolean {
    return this.done;
  }

  state(): RoomState {
    return { v: this.v, lock: this.lock && { ...this.lock }, solved: this.done, game: this.board.game.snapshot(), reserved: this.reserved.map((r) => ({ ...r })) };
  }

  /** Who holds a piece at time `now`; a hold that has run out is nobody's. */
  holder(now: number): Lock | null {
    return this.lock && this.lock.until > now ? this.lock : null;
  }

  /** The reservations that have not run out at time `now`. */
  reservations(now: number): Reservation[] {
    return this.reserved.filter((r) => r.until > now).map((r) => ({ ...r }));
  }

  /** A player's reservation ends (they left, or were sent out): the others hear of it with the next event, or when it would have run out. */
  unreserve(player: string): void {
    this.reserved = this.reserved.filter((r) => r.holder !== player);
  }

  /** The reservation of another player on this group, if there is one. */
  private reservedByOther(player: string, groupId: number, now: number): Reservation | undefined {
    const g = this.board.game;
    return this.reserved.find((r) => r.holder !== player && r.until > now && g.groupOf[r.piece] === groupId);
  }

  /** The player's reservation is this piece, from now (what they had before is let go). */
  private reserve(player: string, piece: number, now: number): void {
    this.reserved = this.reserved.filter((r) => r.holder !== player && r.until > now).concat({ holder: player, piece, until: now + RESERVE_MS });
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
    this.at = now;
    const g = this.board.game;
    const others = this.holder(now);
    if (cmd.t === 'release') {
      if (this.lock?.holder !== player) return { ok: false, reason: 'not-holder' };
      const piece = this.lock.piece;
      this.lock = null;
      // a piece let go is still the player's for a while (it is the one they have chosen), unless it is now part of the picture
      if (!g.groups.get(g.groupOf[piece])?.anchored) this.reserve(player, piece, now);
      return this.accept(player, undefined, 0);
    }
    if (cmd.t === 'unselect') {
      this.unreserve(player);
      return this.accept(player, undefined, 0);
    }
    // the trays belong to the puzzle: any player may add one, or take away one that is empty (the room says which id the new one has: it is the next, on every screen)
    if (cmd.t === 'trayAdd') {
      if (g.trays.length >= TRAY_MAX) return { ok: false, reason: 'bad' };
      return this.accept(player, this.run(cmd).op, 0);
    }
    if (cmd.t === 'trayRemove') {
      if (!Number.isInteger(cmd.tray) || !g.trays.includes(cmd.tray) || g.piecesIn(cmd.tray) > 0) return { ok: false, reason: 'bad' };
      return this.accept(player, this.run(cmd).op, 0);
    }
    if (!Number.isInteger(cmd.piece) || cmd.piece < 0 || cmd.piece >= g.count) return { ok: false, reason: 'bad' };
    const grp = g.groups.get(g.groupOf[cmd.piece]);
    if (!grp || grp.anchored) return { ok: false, reason: 'no-group' };
    const taken = this.reservedByOther(player, grp.id, now);
    if (taken && cmd.t !== 'drop') return { ok: false, reason: 'busy', holder: taken.holder };
    if (cmd.t === 'select') {
      this.reserve(player, cmd.piece, now);
      return this.accept(player, undefined, 0);
    }
    const size = this.board.layout.size;
    const tol = (t: number | null): number | null | undefined =>
      t === null ? null : typeof t === 'number' && Number.isFinite(t) ? Math.min(TOL_MAX_K * size, Math.max(TOL_MIN_K * size, t)) : undefined;

    switch (cmd.t) {
      case 'grab': {
        if (others && others.holder !== player) return { ok: false, reason: 'busy', holder: others.holder };
        this.lock = { holder: player, piece: cmd.piece, until: now + LOCK_MS };
        this.reserve(player, cmd.piece, now);
        return this.accept(player, this.run(cmd).op, 0);
      }
      case 'drop': {
        if (this.lock?.holder !== player || g.groupOf[this.lock.piece] !== grp.id) return { ok: false, reason: 'not-holder' };
        const t = tol(cmd.tol);
        const limit = Math.max(this.board.worldW, this.board.worldH);
        const sane = [cmd.dx, cmd.dy].every((x) => typeof x === 'number' && Number.isFinite(x) && x > -limit && x < 2 * limit) && Number.isInteger(cmd.rot) && cmd.rot >= 0 && cmd.rot <= 3;
        if (t === undefined || !sane) return { ok: false, reason: 'bad' };
        // into a tray: one that is there, and the middle of the group inside it
        const tray = cmd.tray ?? -1;
        if (tray !== -1) {
          if (!Number.isInteger(tray) || !g.trays.includes(tray)) return { ok: false, reason: 'bad' };
          const ts = traySize(g.cols, g.size);
          const [cx, cy] = centreAt(grp, g.cols, g.size, cmd.dx, cmd.dy, cmd.rot);
          if (cx < 0 || cy < 0 || cx > ts.w || cy > ts.h) return { ok: false, reason: 'bad' };
        }
        const joins = this.run({ t: 'drop', piece: cmd.piece, dx: cmd.dx, dy: cmd.dy, rot: cmd.rot, tol: tray === -1 ? t : null, ...(tray === -1 ? {} : { tray }) });
        this.lock = null;
        if (g.groups.get(g.groupOf[cmd.piece])?.anchored) this.unreserve(player);
        else this.reserve(player, cmd.piece, now);
        return this.accept(player, joins.op, joins.joins);
      }
      case 'rotate': {
        if (others && others.holder !== player) return { ok: false, reason: 'busy', holder: others.holder };
        if (this.lock?.holder === player && g.groupOf[this.lock.piece] !== grp.id) return { ok: false, reason: 'busy', holder: player };      // it has a piece in hand: let that go first
        const t = tol(cmd.tol);
        if (t === undefined) return { ok: false, reason: 'bad' };
        const r = this.run({ t: 'rotate', piece: cmd.piece, tol: t });
        if (g.groups.get(g.groupOf[cmd.piece])?.anchored) this.unreserve(player);
        else this.reserve(player, cmd.piece, now);
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
      this.reserved = [];
    }
    return { ok: true, event: { v: this.v, by, op, lock: this.lock && { ...this.lock }, reserved: this.reservations(this.at), joins, groups: this.board.game.groups.size, solved: this.done } };
  }
}
