import { JigsawRoom } from '../../src/core/jigsawRoom';
import { layoutJigsaw } from '../../src/core/jigsaw';
import { findKind, optionsOf } from '../../src/core/kinds';
import { Rng } from '../../src/core/rng';
import {
  cleanName,
  inviteLink,
  normalizeCode,
  PROTOCOL_VERSION,
  secretFrom,
  topics,
  type ApiError,
  type ApiFailure,
  type CommandRequest,
  type CommandResponse,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type Invite,
  type JoinRequest,
  type JoinResponse,
  type Member,
  type MeResponse,
  type RoomDescriptor,
  type RoomMessage,
  type RoomSettings,
  type RoomSummary,
} from '../../src/online/protocol';
import { sniffImage } from './image';
import type { Clock, Limits, Media, Player, Presence, PubSub, Random, RoomRecord, Store } from './types';

export interface Deps {
  store: Store;
  media: Media;
  pubsub: PubSub;
  presence: Presence;
  clock: Clock;
  random: Random;
  limits: Limits;
  /** The web address the game is served from, for the links to send to friends. */
  webBase: string;
}

const WEEK = 7 * 24 * 3600 * 1000;
const COLORS = 8;
/** A guest's chosen name is kept this long after it was last set (a little longer than their token lasts). */
const GUEST_NAME_KEEP_MS = 100 * 24 * 3600 * 1000;
const fail = (error: ApiError, extra: Partial<ApiFailure> = {}): ApiFailure => ({ ok: false, error, ...extra });

async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The settings of a puzzle as the server will keep them: checked, the options within their limits, nothing else. */
export function checkSettings(raw: RoomSettings, limits: Limits): RoomSettings | ApiFailure {
  const kind = findKind('jigsaw')!;
  if (!raw || raw.kind !== 'jigsaw') return fail('bad-request');
  const whole = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
  if (!whole(raw.width, 64, 4096) || !whole(raw.height, 64, 4096) || !whole(raw.seed, 0, 4294967295)) return fail('bad-request');
  if (!raw.opts || typeof raw.opts !== 'object') return fail('bad-request');
  const given: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.opts)) given[`jigsaw.${k}`] = v;
  const all = optionsOf(given, kind);
  const opts: Record<string, number> = {};
  for (const o of kind.options) if (!o.display) opts[o.key] = all[o.key];            // what a player sees on their own screen is not part of the puzzle
  if (opts.pieces > limits.jigsawPieces) return fail('limit');
  const layout = layoutJigsaw(new Rng(raw.seed), raw.width, raw.height, opts.pieces);
  if (layout.cols * layout.rows > limits.jigsawPieces * 1.2) return fail('limit');        // the grid is only about as many as asked
  return { kind: 'jigsaw', seed: raw.seed, width: raw.width, height: raw.height, opts };
}

/** The service behind the online puzzles: every call is one request, and everything it keeps it keeps in the `Store`. */
export class RoomService {
  constructor(private readonly d: Deps) {}

  // ---------------------------------------------------------------------------------------------------------------- who the player is

  /** What the server knows about the player: the name they chose, if they have. (The token only says who they are.) */
  async profile(player: Player): Promise<MeResponse> {
    return { ok: true, id: player.id, name: (await this.d.store.getName(player.id)) ?? null, guest: player.guest === true };
  }

  async setProfile(player: Player, name: unknown): Promise<MeResponse | ApiFailure> {
    const clean = cleanName(name);
    if (!clean) return fail('bad-request');
    await this.d.store.setName(player.id, clean, player.guest ? this.d.clock.now() + GUEST_NAME_KEEP_MS : undefined);
    return this.profile(player);
  }

  /** The player as the others see them: with the name they chose, if they chose one, and otherwise the name that came with the token. */
  private async named(player: Player): Promise<Player> {
    const name = await this.d.store.getName(player.id);
    return name ? { ...player, name } : player;
  }

  // ---------------------------------------------------------------------------------------------------------------- making a room

  async createRoom(who: Player, req: CreateRoomRequest): Promise<CreateRoomResponse | ApiFailure> {
    const { store, clock, random, limits } = this.d;
    // a guest may join puzzles but not make them (the cloud's gateway turns a guest's token away before it gets here; this is for any server that does not)
    if (who.guest) return fail('account-required');
    if (req?.protocol !== PROTOCOL_VERSION) return fail('update-required', { protocol: PROTOCOL_VERSION });
    if (req.consent !== true) return fail('bad-request');
    const settings = checkSettings(req.settings, limits);
    if ('ok' in settings) return settings;
    const player = await this.named(who);
    const now = clock.now();
    const recent = (await store.creationsSince(player.id, now - WEEK)).sort((a, b) => a - b);
    if (recent.length >= limits.freeRoomsPerWeek) return fail('quota', { retryAt: recent[recent.length - limits.freeRoomsPerWeek] + WEEK });
    if ((await store.roomsOf(player.id)).length >= limits.activeRoomsPerPlayer) return fail('limit');

    const id = secretFrom(random.bytes(16));
    const code = await this.newCode(id);
    if (!code) return fail('limit');
    const secret = secretFrom(random.bytes(20));
    const room: RoomRecord = {
      id,
      settings,
      sourceId: typeof req.sourceId === 'string' ? req.sourceId.slice(0, 64) : undefined,
      ownerId: player.id,
      members: [{ id: player.id, name: player.name, color: 0 }],
      code,
      secretHash: await sha256(secret),
      knocks: [],
      ready: false,
      status: 'open',
      createdAt: now,
      expiresAt: now + limits.idleMs,
      state: new JigsawRoom(settings).state(),
      rev: 0,
    };
    if (!(await store.putRoom(room))) return fail('limit');
    await store.addCreation(player.id, now);
    return { ok: true, roomId: id, upload: { url: await this.d.media.uploadUrl(id) }, invite: { code, secret, link: inviteLink(this.d.webBase, code, secret) } };
  }

  /** A free five-digit code, claimed for the room (null if they all seem to be taken). */
  private async newCode(roomId: string): Promise<string | null> {
    for (let i = 0; i < 40; i++) {
      const code = String(this.d.random.below(100000)).padStart(5, '0');
      if (await this.d.store.claimCode(code, roomId)) return code;
    }
    return null;
  }

  /** The creator's game has sent the picture (to the address `createRoom` gave): it is checked, and the room can then be joined. */
  async finishUpload(roomId: string, bytes: Uint8Array): Promise<{ ok: true } | ApiFailure> {
    const room = await this.live(roomId);
    if (!room || room.ready) return fail('not-found');
    const found = bytes.length <= this.d.limits.pictureBytes ? sniffImage(bytes) : null;
    if (!found || found.width !== room.settings.width || found.height !== room.settings.height) {
      await this.cleanup(room, 'owner');                          // not the picture the puzzle was made for: nothing is kept
      return fail('bad-request');
    }
    await this.d.media.put(roomId, bytes, found.type);
    const done = await this.update(roomId, (r) => {
      r.ready = true;
      return r;
    });
    return 'error' in done ? done : { ok: true };
  }

  // ---------------------------------------------------------------------------------------------------------------- joining

  async join(who: Player, req: JoinRequest): Promise<JoinResponse> {
    if (req?.protocol !== PROTOCOL_VERSION) return fail('update-required', { protocol: PROTOCOL_VERSION });
    const code = normalizeCode(String(req.code ?? ''));
    if (!code) return fail('bad-request');
    const player = await this.named(who);
    const id = await this.d.store.roomOfCode(code);
    const room = id ? await this.live(id) : undefined;
    if (!room) return fail('not-found');
    if (!room.ready) return fail('not-ready');
    if (room.members.some((m) => m.id === player.id)) return { ok: true, room: await this.describe(room) };
    const withSecret = typeof req.secret === 'string' && req.secret !== '' && (await sha256(req.secret)) === room.secretHash;
    if (typeof req.secret === 'string' && req.secret !== '' && !withSecret) return fail('not-found');
    if (!withSecret) {
      // a code alone knocks: a member says yes or no, and the player asks again
      const knock = room.knocks.find((k) => k.id === player.id);
      if (knock?.status === 'denied') return fail('knock-denied');
      if (knock?.status !== 'allowed') {
        if (!knock) {
          const r = await this.update(room.id, (x) => {
            x.knocks.push({ id: player.id, name: player.name, status: 'pending' });
            return x;
          });
          if ('error' in r) return r;
          await this.publish(room.id, { t: 'knock', id: player.id, name: player.name });
        }
        return fail('knock-pending');
      }
    }
    return this.addMember(room.id, player);
  }

  private async addMember(roomId: string, player: Player): Promise<JoinResponse> {
    const { limits, store } = this.d;
    if ((await store.roomsOf(player.id)).length >= limits.activeRoomsPerPlayer) return fail('limit');
    let member: Member | undefined;
    const done = await this.update(roomId, (r) => {
      const had = r.members.find((m) => m.id === player.id);
      if (had) {
        member = had;
        return r;
      }
      if (r.members.length >= limits.playersPerRoom) return fail('full');
      const used = new Set(r.members.map((m) => m.color));
      let color = 0;
      while (used.has(color) && color < COLORS - 1) color++;
      member = { id: player.id, name: player.name, color };
      r.members.push(member);
      r.knocks = r.knocks.filter((k) => k.id !== player.id);
      return r;
    });
    if ('error' in done) return done;
    await this.publish(roomId, { t: 'joined', member: member! });
    return { ok: true, room: await this.describe(done.room) };
  }

  async answerKnock(player: Player, roomId: string, who: string, allow: boolean): Promise<{ ok: true } | ApiFailure> {
    const r = await this.memberRoom(player, roomId);
    if ('error' in r) return r;
    const done = await this.update(roomId, (x) => {
      const k = x.knocks.find((n) => n.id === who && n.status === 'pending');
      if (!k) return fail('not-found');
      k.status = allow ? 'allowed' : 'denied';
      return x;
    });
    return 'error' in done ? done : { ok: true };
  }

  // ---------------------------------------------------------------------------------------------------------------- looking

  async getRoom(player: Player, roomId: string): Promise<{ ok: true; room: RoomDescriptor } | ApiFailure> {
    const r = await this.memberRoom(player, roomId);
    if ('error' in r) return r;
    return { ok: true, room: await this.describe(r.room) };
  }

  /** Whether the player is in the room (what the live connection asks before it lets them listen). */
  async isMember(player: Player, roomId: string): Promise<boolean> {
    return !('error' in (await this.memberRoom(player, roomId)));
  }

  async listRooms(player: Player): Promise<{ ok: true; rooms: RoomSummary[] }> {
    const rooms: RoomSummary[] = [];
    for (const id of await this.d.store.roomsOf(player.id)) {
      const r = await this.live(id);
      if (!r?.ready) continue;
      rooms.push({ id, settings: { kind: 'jigsaw', opts: r.settings.opts }, owner: r.ownerId, members: r.members, online: (await this.d.presence.online(id)).length, status: r.status, expiresAt: r.expiresAt });
    }
    return { ok: true, rooms: rooms.sort((a, b) => b.expiresAt - a.expiresAt) };
  }

  private async describe(room: RoomRecord): Promise<RoomDescriptor> {
    return {
      id: room.id,
      protocol: PROTOCOL_VERSION,
      settings: room.settings,
      media: { url: await this.d.media.signedUrl(room.id), type: 'image', sourceId: room.sourceId },
      owner: room.ownerId,
      members: room.members,
      online: await this.d.presence.online(room.id),
      state: room.state,
      serverTime: this.d.clock.now(),
      expiresAt: room.expiresAt,
      status: room.status,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------- playing

  async command(player: Player, roomId: string, req: CommandRequest): Promise<CommandResponse> {
    if (req?.protocol !== PROTOCOL_VERSION) return fail('update-required', { protocol: PROTOCOL_VERSION });
    const { clock, limits } = this.d;
    const before = await this.memberRoom(player, roomId);
    if ('error' in before) return before;
    let event: Extract<CommandResponse, { ok: true }>['event'] | undefined;
    let refusal: ApiFailure | undefined;
    const done = await this.update(roomId, (r) => {
      event = undefined;
      refusal = undefined;
      if (r.status === 'solved') return fail('ended');
      const now = clock.now();
      const room = new JigsawRoom(r.settings, r.state);
      const res = room.submit(player.id, req.command, now);
      if (!res.ok) {
        refusal = fail(res.reason === 'bad' ? 'bad-request' : res.reason, res.holder ? { holder: res.holder } : {});
        return r;                                                     // nothing changes (and nothing is written)
      }
      event = res.event;
      r.state = room.state();
      r.status = room.solved ? 'solved' : 'open';
      r.expiresAt = now + (room.solved ? limits.solvedKeepMs : limits.idleMs);
      return r;
    });
    if ('error' in done) return done;
    if (refusal) return refusal;
    await this.publish(roomId, { t: 'event', ...event! });
    if (event!.solved) await this.publish(roomId, { t: 'solved', at: clock.now() });
    return { ok: true, event: event! };
  }

  /** The hand stays on the piece for another while. */
  async renew(player: Player, roomId: string): Promise<{ ok: true; until: number } | ApiFailure> {
    const before = await this.memberRoom(player, roomId);
    if ('error' in before) return before;
    let until = 0;
    let refusal: ApiFailure | undefined;
    const done = await this.update(roomId, (r) => {
      refusal = undefined;
      const room = new JigsawRoom(r.settings, r.state);
      const res = room.renew(player.id, this.d.clock.now());
      if (!res.ok) {
        refusal = fail(res.reason === 'bad' ? 'bad-request' : res.reason);
        return r;
      }
      until = res.until;
      r.state = room.state();
      r.expiresAt = Math.max(r.expiresAt, this.d.clock.now() + this.d.limits.idleMs);
      return r;
    });
    if ('error' in done) return done;
    return refusal ?? { ok: true, until };
  }

  // ---------------------------------------------------------------------------------------------------------------- leaving, closing, inviting

  /** The player is out of the room for good (they can get back in with a code or a link). A room with nobody left goes. */
  async leave(player: Player, roomId: string): Promise<{ ok: true } | ApiFailure> {
    const before = await this.memberRoom(player, roomId);
    if ('error' in before) return before;
    const done = await this.update(roomId, (r) => {
      r.members = r.members.filter((m) => m.id !== player.id);
      if (r.ownerId === player.id && r.members.length) r.ownerId = r.members[0].id;
      const room = new JigsawRoom(r.settings, r.state);
      const held = room.holder(this.d.clock.now());
      if (held?.holder === player.id) {
        room.submit(player.id, { t: 'release' }, this.d.clock.now());
        r.state = room.state();
      }
      return r;
    });
    if ('error' in done) return done;
    if (!done.room.members.length) await this.cleanup(done.room, 'solved');
    else await this.publish(roomId, { t: 'left', id: player.id });
    return { ok: true };
  }

  async close(player: Player, roomId: string): Promise<{ ok: true } | ApiFailure> {
    const r = await this.memberRoom(player, roomId);
    if ('error' in r) return r;
    if (r.room.ownerId !== player.id) return fail('unauthorized');
    await this.cleanup(r.room, 'owner');
    return { ok: true };
  }

  /** A new code and link; the old ones stop working. */
  async regenerateInvite(player: Player, roomId: string): Promise<{ ok: true; invite: Invite } | ApiFailure> {
    const r = await this.memberRoom(player, roomId);
    if ('error' in r) return r;
    if (r.room.ownerId !== player.id) return fail('unauthorized');
    const code = await this.newCode(roomId);
    if (!code) return fail('limit');
    const secret = secretFrom(this.d.random.bytes(20));
    const hash = await sha256(secret);
    const done = await this.update(roomId, (x) => {
      x.code = code;
      x.secretHash = hash;
      x.knocks = [];
      return x;
    });
    if ('error' in done) {
      await this.d.store.releaseCode(code);
      return done;
    }
    await this.d.store.releaseCode(r.room.code);
    return { ok: true, invite: { code, secret, link: inviteLink(this.d.webBase, code, secret) } };
  }

  /** Clears out the rooms nobody has touched for a day (and the solved ones whose time is up). Returns how many went. */
  async sweep(): Promise<number> {
    const now = this.d.clock.now();
    let n = 0;
    for (const room of await this.d.store.allRooms()) {
      if (room.expiresAt <= now) {
        await this.cleanup(room, room.status === 'solved' ? 'solved' : 'expired');
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------------------------- the inside

  /** The room, unless it has expired (then it is cleared away now: nothing waits for a sweep to make a code stop working). */
  private async live(id: string): Promise<RoomRecord | undefined> {
    const room = await this.d.store.getRoom(id);
    if (!room) return undefined;
    if (room.expiresAt <= this.d.clock.now()) {
      await this.cleanup(room, room.status === 'solved' ? 'solved' : 'expired');
      return undefined;
    }
    return room;
  }

  private async memberRoom(player: Player, id: string): Promise<{ room: RoomRecord } | ApiFailure> {
    const room = await this.live(id);
    if (!room || !room.members.some((m) => m.id === player.id)) return fail('not-found');
    if (!room.ready) return fail('not-ready');
    return { room };
  }

  private async cleanup(room: RoomRecord, reason: 'owner' | 'expired' | 'solved'): Promise<void> {
    await this.publish(room.id, { t: 'closed', reason });
    await this.d.media.delete(room.id);
    await this.d.store.releaseCode(room.code);
    await this.d.store.deleteRoom(room.id);
  }

  private publish(roomId: string, message: RoomMessage): Promise<void> {
    return this.d.pubsub.publish(topics.events(roomId), message);
  }

  /** Changes a room and writes it, again from the start if someone else wrote in between. `fn` returns the room to write, or a failure (then nothing is written). */
  private async update(id: string, fn: (room: RoomRecord) => RoomRecord | ApiFailure): Promise<{ room: RoomRecord } | ApiFailure> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const room = await this.d.store.getRoom(id);
      if (!room) return fail('not-found');
      const before = JSON.stringify(room);
      const next = fn(room);
      if ('ok' in next) return next;
      if (JSON.stringify(next) === before) return { room: next };      // nothing changed (a refused command): nothing to write
      next.rev = room.rev + 1;
      if (await this.d.store.putRoom(next)) return { room: next };
    }
    return fail('busy');
  }
}
