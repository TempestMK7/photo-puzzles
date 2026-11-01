import type { Command, Lock, Reservation, RoomEvent, RoomState } from '../core/jigsawRoom';
import type { CallError, RoomApi } from './api';
import { HAND_INTERVAL_MS, lockHeld, RENEW_INTERVAL_MS, type HandMessage, type Member, type Playback, type RoomDescriptor, type RoomMessage } from './protocol';
import type { Connection, Realtime } from './realtime';

/** What the room needs from the puzzle on the screen (a session): it applies what the others did, and tells how many groups it has (for the puzzles without groups, the number `boardCheck` makes). */
export interface RoomView {
  /** Another player's operation, to be applied to the board. */
  applyEvent(event: RoomEvent): void;
  /** Throw the board away and take this one (after a gap in the messages, or a refusal). */
  resync(state: RoomState): void;
  /** Where the piece another player holds is now, or `null` when it is let go (it goes back to where the board has it). Only a Jigsaw has hands. */
  hand?(by: string, pose: HandMessage | null): void;
  groupCount(): number;
  /** The pieces that other players have chosen (and so nobody else may take) changed, or one ran out: draw them again. */
  reservations?(): void;
}

export type RoomStatus = 'connecting' | 'online' | 'reconnecting' | 'closed' | 'refused';

/**
 * One player's side of an online puzzle: it listens to the room, applies what the others do, sends what this player does (in order), keeps the hold on a piece alive,
 * says where the piece in hand is, and starts again from the server's board when it has missed something or lost the connection.
 */
export class OnlineRoom {
  members: Member[];
  online: Set<string>;
  status: RoomStatus = 'connecting';
  /** Why the room ended, once it has. */
  closedReason: 'owner' | 'expired' | 'solved' | 'removed' | null = null;
  solved: boolean;
  /** Players who knocked and wait for someone to let them in. */
  knocks: { id: string; name: string }[] = [];
  /** Called after anything the screen might show changed (the players, the connection, who holds a piece, solved). */
  onChange: () => void = () => undefined;
  /** Called when the server said no to something the player did (the reason, and who holds the piece if that is why). */
  onRefused: (error: CallError, holder?: string) => void = () => undefined;
  /** A video puzzle: where the host's video is (as the host last said), and who the host is (the owner of the puzzle: the next member if they leave). */
  playback: Playback | null;
  private ownerId: string;
  /** Called when the host says where the video is. */
  onPlayback: () => void = () => undefined;

  /** The time spent on the puzzle while someone was connected (the server's count; see `playedMs`). */
  private played: { ms: number; since: number | null };
  private solvedMs: number | null;
  /** When this game's own connection opened (this clock): the time runs from there if the server has not said so yet. */
  private connectedAt: number | null = null;
  private view: RoomView | null = null;
  private conn: Connection | null = null;
  private version: number;
  private lock: Lock | null;
  /** The pieces that players have picked up or clicked on, as the room last said (see `Reservation`). */
  private reserved: Reservation[];
  /** The server's clock minus this one's. */
  private offset: number;
  private queue: Promise<void> = Promise.resolve();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private handNo = 0;
  private handLast = 0;
  private handPending: Omit<HandMessage, 'n'> | null = null;
  private handTimer: ReturnType<typeof setTimeout> | null = null;
  private handSeen = new Map<string, number>();
  private handBy: string | null = null;
  private resyncing = false;
  private resyncAgain = false;
  /** Commands sent (or waiting to be) that the server has not answered yet: the board here is ahead of the server's by those. */
  private pending = 0;
  private ended = false;
  /** Another player's operation was applied while this player's own were still on their way (in a puzzle where everybody moves at once): the boards may now differ in order, so the room's is taken once those are answered. */
  private mixedUp = false;
  private readonly shared: boolean;

  constructor(
    private readonly api: RoomApi,
    private readonly realtime: Realtime,
    descriptor: RoomDescriptor,
    readonly me: string,
  ) {
    this.id = descriptor.id;
    this.members = [...descriptor.members];
    this.online = new Set(descriptor.online);
    this.knocks = (descriptor.knocks ?? []).map((k) => ({ ...k }));
    this.played = descriptor.played ?? { ms: 0, since: null };
    this.solvedMs = descriptor.solvedMs ?? null;
    this.version = descriptor.state.v;
    this.lock = descriptor.state.lock;
    this.reserved = descriptor.state.reserved ?? [];
    this.solved = descriptor.status === 'solved';
    this.offset = descriptor.serverTime - Date.now();
    this.descriptor = descriptor;
    this.playback = descriptor.playback ?? null;
    this.ownerId = descriptor.owner;
    this.shared = descriptor.settings.kind !== 'jigsaw';
  }

  readonly id: string;
  /** The room as it was when this player came in (the setup, the picture, the board at that time). */
  readonly descriptor: RoomDescriptor;

  /** Starts listening. `view` is the puzzle on the screen. */
  attach(view: RoomView): void {
    this.view = view;
    this.conn = this.realtime.connect(this.id, {
      onOpen: () => {
        this.status = 'online';
        this.connectedAt ??= Date.now();
        this.changed();
        void this.resync();                                          // whatever happened while there was no connection
      },
      onClose: () => {
        if (this.ended) return;
        this.status = 'reconnecting';
        this.changed();
      },
      onRefused: () => {
        this.status = 'refused';
        this.changed();
      },
      onMessage: (topic, message) => this.hear(topic, message),
    });
    this.armExpiry();
  }

  /** Leaves the room (the screen goes back to the list); the player stays a member. */
  detach(): void {
    this.ended = true;
    this.conn?.close();
    this.conn = null;
    this.view = null;
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.handTimer) clearTimeout(this.handTimer);
  }

  // ---------------------------------------------------------------------------------------------------------------- what the screen asks

  get serverNow(): number {
    return Date.now() + this.offset;
  }

  /** This player is the host of the video (the one who made the puzzle; if they leave, the next player). */
  get host(): boolean {
    return this.ownerId === this.me;
  }

  /** The host says where the video is (played, paused or moved, and now and then while it plays). The others hear it at once. */
  sendPlayback(pos: number, paused: boolean): void {
    this.playback = { pos, paused, at: this.serverNow };
    void this.api.setPlayback?.(this.id, { pos, paused });
  }

  /** Asks the server where the host's video is now (for a player who wants to be taken back to it). Nothing new if the server cannot be reached. */
  async refreshPlayback(): Promise<Playback | null> {
    const res = await this.api.getRoom(this.id);
    if (res.ok) {
      this.offset = res.room.serverTime - Date.now();
      this.takePlayback(res.room.playback);
      this.ownerId = res.room.owner;
    }
    return this.playback;
  }

  /** What the server said about the video is kept unless something newer was heard meanwhile (an answer can come in after a message that was sent later). True if it was kept. */
  private takePlayback(p: Playback | undefined): boolean {
    if (!p || (this.playback && p.at < this.playback.at)) return false;
    this.playback = p;
    return true;
  }

  /** The pieces that other players have chosen (a piece of each group), now: nobody else may pick one up or turn it. */
  othersReserved(): { by: string; piece: number }[] {
    const now = this.serverNow;
    return this.reserved.filter((r) => r.holder !== this.me && r.until > now).map((r) => ({ by: r.holder, piece: r.piece }));
  }

  /** The player who holds a piece (not this player), if any: while someone does, nothing can be picked up. */
  holderOther(): Member | null {
    const l = this.lock;
    if (!l || l.holder === this.me || !lockHeld(l, Date.now(), this.offset)) return null;
    return this.members.find((m) => m.id === l.holder) ?? { id: l.holder, name: 'Someone', color: 0 };
  }

  /**
   * The time spent on the puzzle so far, in ms: only time with at least one player connected counts. The server keeps the count (and fixes it when the puzzle is solved); a game that
   * is connected but has not heard from the server that the count began counts from its own connection.
   */
  playedMs(): number {
    if (this.solvedMs !== null) return this.solvedMs;
    const { ms, since } = this.played;
    if (since !== null) return ms + Math.max(0, this.serverNow - since);
    return ms + (this.status === 'online' && this.connectedAt !== null ? Math.max(0, Date.now() - this.connectedAt) : 0);
  }

  member(id: string): Member | undefined {
    return this.members.find((m) => m.id === id);
  }

  /** Sends what the player did, after what they did before. The caller has applied it to their own board already. */
  send(command: Command): void {
    this.pending++;
    this.queue = this.queue.then(async () => {
      let res: Awaited<ReturnType<RoomApi['command']>> | null = null;
      try {
        if (!this.ended) res = await this.api.command(this.id, command);
      } finally {
        this.pending--;
      }
      if (!res) return;
      if (res.ok) {
        this.process(res.event);
        if (this.mixedUp && this.pending === 0) await this.resync();
        return;
      }
      this.onRefused(res.error, 'holder' in res ? res.holder : undefined);
      if (res.error === 'offline') {
        this.status = 'reconnecting';
        this.changed();
      }
      await this.resync();                                           // the board the player sees is not the one the server has
    });
  }

  /** Resolves once everything the player did so far has been sent and answered. */
  whenSent(): Promise<void> {
    return this.queue;
  }

  /** A piece is in hand (a piece of its group) or let go: while it is in hand the hold is renewed, so that it does not run out. */
  holding(piece: number | null): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
    if (piece === null) return;
    this.renewTimer = setInterval(() => {
      void this.api.renew(this.id).then((r) => {
        if (!r.ok && r.error !== 'offline') void this.resync();      // the hold ran out and someone else has the piece: this player's board is wrong now
      });
    }, RENEW_INTERVAL_MS);
  }

  /** Where the piece in hand is. Said a few times a second, whatever the rate of the pointer. */
  hand(pose: Omit<HandMessage, 'n'>): void {
    this.handPending = pose;
    const wait = HAND_INTERVAL_MS - (Date.now() - this.handLast);
    if (wait <= 0) this.flushHand();
    else if (!this.handTimer) this.handTimer = setTimeout(() => this.flushHand(), wait);
  }

  private flushHand(): void {
    if (this.handTimer) clearTimeout(this.handTimer);
    this.handTimer = null;
    if (!this.handPending) return;
    this.handLast = Date.now();
    this.conn?.publishHand({ ...this.handPending, n: ++this.handNo });
    this.handPending = null;
  }

  // ---------------------------------------------------------------------------------------------------------------- what the server says

  private hear(topic: string, message: unknown): void {
    const hand = /\/hand\/([^/]+)$/.exec(topic)?.[1];
    if (hand) {
      this.hearHand(hand, message as HandMessage);
      return;
    }
    const m = message as RoomMessage;
    switch (m.t) {
      case 'event':
        this.process(m);
        break;
      case 'joined':
        if (!this.member(m.member.id)) this.members.push(m.member);
        this.knocks = this.knocks.filter((k) => k.id !== m.member.id);
        this.changed();
        break;
      case 'left':
        this.members = this.members.filter((x) => x.id !== m.id);
        this.online.delete(m.id);
        if (m.id === this.ownerId && this.members.length) this.ownerId = this.members[0].id;          // the server hands the puzzle (and the video) to the next player
        this.changed();
        break;
      case 'removed':
        if (m.id === this.me) {
          this.closedReason = 'removed';
          this.status = 'closed';
        } else {
          this.members = this.members.filter((x) => x.id !== m.id);
          this.online.delete(m.id);
        }
        this.changed();
        break;
      case 'renewed':
        // the holder is still holding: the hold lasts longer than the others' copy of it says
        if (this.lock?.holder === m.id && m.until > this.lock.until) this.setLock({ ...this.lock, until: m.until });
        break;
      case 'presence':
        if (m.online) this.online.add(m.id);
        else this.online.delete(m.id);
        this.changed();
        break;
      case 'knock':
        if (!this.knocks.some((k) => k.id === m.id)) this.knocks.push({ id: m.id, name: m.name });
        this.changed();
        break;
      case 'played':
        this.played = { ms: m.ms, since: m.since };
        this.changed();
        break;
      case 'playback':
        if (!this.host) {
          this.playback = { pos: m.pos, paused: m.paused, at: m.at };
          this.onPlayback();
        }
        break;
      case 'solved':
        this.solved = true;
        if (typeof m.ms === 'number') this.solvedMs = m.ms;
        this.changed();
        break;
      case 'closed':
        this.closedReason = m.reason;
        this.status = 'closed';
        this.changed();
        break;
    }
  }

  private hearHand(by: string, msg: HandMessage): void {
    if (by === this.me || !msg || typeof msg.n !== 'number') return;
    if (this.lock?.holder !== by || (this.handSeen.get(by) ?? 0) >= msg.n) return;       // not who holds a piece, or an older message that came late
    this.handSeen.set(by, msg.n);
    this.handBy = by;
    this.view?.hand?.(by, msg);
  }

  /** An event of the room, in order: the one after the last seen is applied, an older one is ignored, a later one means something was missed. */
  private process(ev: RoomEvent): void {
    if (ev.v <= this.version) return;
    if (ev.v !== this.version + 1) {
      void this.resync();
      return;
    }
    this.version = ev.v;
    // (this player's own are applied already, but not the making and taking away of trays: the room says which id a new tray has, so a screen waits for it)
    const ownTray = ev.by === this.me && (ev.op?.t === 'trayAdd' || ev.op?.t === 'trayRemove');
    if (ev.by !== this.me || ownTray) {
      if (!ownTray) this.dropHand();
      if (this.shared && ev.by !== this.me && this.pending > 0) this.mixedUp = true;
      this.view?.applyEvent(ev);
    }
    this.reserved = ev.reserved ?? [];
    this.setLock(ev.lock);
    this.view?.reservations?.();
    if (ev.solved) this.solved = true;
    // the board here and the board there have drifted apart (but while this player's own moves are on their way the board here is ahead, which is not that)
    if (this.view && this.pending === 0 && this.view.groupCount() !== ev.groups) void this.resync();
    this.changed();
  }

  private dropHand(): void {
    if (this.handBy) this.view?.hand?.(this.handBy, null);
    this.handBy = null;
  }

  private setLock(lock: Lock | null): void {
    if (this.lock?.holder !== lock?.holder) this.handSeen.clear();
    this.lock = lock;
    this.armExpiry();
  }

  /**
   * A hold, or a reservation, that runs out on its own sends no message: when it does, a piece in another's hand goes back to where the board has it, and one that was reserved is
   * drawn as any other.
   */
  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.ended) return;
    const l = this.lock;
    const now = this.serverNow;
    const times = [...(l && l.holder !== this.me && l.until > now ? [l.until] : []), ...this.reserved.filter((r) => r.holder !== this.me && r.until > now).map((r) => r.until)];
    if (!times.length) return;
    this.expiryTimer = setTimeout(() => {
      if (this.lock === l && l && l.holder !== this.me && l.until <= this.serverNow + 50) this.dropHand();
      this.view?.reservations?.();
      this.changed();
      this.armExpiry();
    }, Math.max(0, Math.min(...times) - now) + 50);
  }

  /** Asks the server for the whole board and starts again from it. */
  async resync(): Promise<void> {
    if (this.ended) return;
    if (this.resyncing) {
      this.resyncAgain = true;
      return;
    }
    this.resyncing = true;
    try {
      do {
        this.resyncAgain = false;
        const res = await this.api.getRoom(this.id);
        if (this.ended) return;
        if (!res.ok) {
          if (res.error === 'not-found') {
            this.status = 'closed';
            this.closedReason ??= 'expired';
            this.changed();
            return;
          }
          if (res.error === 'offline') {
            this.status = 'reconnecting';
            this.changed();
          }
          return;
        }
        const r = res.room;
        this.members = [...r.members];
        this.online = new Set(r.online);
        this.knocks = (r.knocks ?? []).map((k) => ({ ...k }));
        this.played = r.played ?? { ms: 0, since: null };
        this.solvedMs = r.solvedMs ?? null;
        this.offset = r.serverTime - Date.now();
        this.ownerId = r.owner;
        if (r.playback && !this.host && this.takePlayback(r.playback)) this.onPlayback();
        this.version = r.state.v;
        this.mixedUp = false;
        this.handSeen.clear();
        this.handBy = null;
        this.reserved = r.state.reserved ?? [];
        this.setLock(r.state.lock);
        this.solved = r.status === 'solved';
        this.view?.resync(r.state);
        this.view?.reservations?.();
        this.changed();
      } while (this.resyncAgain);
    } finally {
      this.resyncing = false;
    }
  }

  private changed(): void {
    this.onChange();
  }
}
