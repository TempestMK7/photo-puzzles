import { JigsawRoom } from '../../src/core/jigsawRoom';
import { layoutJigsaw } from '../../src/core/jigsaw';
import { findKind, optionsOf } from '../../src/core/kinds';
import { Rng } from '../../src/core/rng';
import {
  cleanName,
  cleanNote,
  inviteLink,
  normalizeCode,
  ACCOUNT_TYPES,
  adGives,
  mayStartVideos,
  photosAreFree,
  PROTOCOL_VERSION,
  REPORT_REASONS,
  skipsTheCheck,
  videosAreFree,
  secretFrom,
  topics,
  VIDEO_TYPES,
  type ApiError,
  type AccountSummary,
  type AccountType,
  type AdRequest,
  type AdResponse,
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
  type PlaybackRequest,
  type VideoCheckResponse,
  type RoomDescriptor,
  type RoomMessage,
  type RoomSettings,
  type ReportRequest,
  type RoomSummary,
} from '../../src/online/protocol';
import { adsToday, dayOf, GUEST_SUMMARY, newAccount, summaryOf } from './accounts';
import { sniffImage } from './image';
import type { AdminFile, AdminRoomSummary } from '../../src/online/adminProtocol';
import { playedMs } from './played';
import type { AccountRecord, Accounts, AdVerifier, Clock, FileRecord, Limits, Media, Moderation, Player, Presence, PubSub, Random, Report, RoomRecord, Store, VideoModeration } from './types';

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
  /** Where an account is deleted for good (nothing for a server that has no accounts). */
  accounts?: Accounts;
  /** Looks at every picture before the puzzle can be joined (nothing for a server that has no such service). */
  moderation?: Moderation;
  /** The same for the whole of a video, which takes a minute or two (nothing for a server that has no such service: a video is let through). */
  videoModeration?: VideoModeration;
  /** Tells the operator something (an e-mail, in the cloud). Nothing for a server that has nobody to tell. */
  notify?: (text: string) => Promise<void>;
  /** Checks with the ad network that a rewarded ad was watched. Nothing for a server that cannot: then an ad counts only if the limit `adsTrusted` says to take the game's word. */
  ads?: AdVerifier;
}

const DAY = 24 * 3600 * 1000;
/** The record of who may use a file outlives the file by this much at most (it is only looked at once the file is found). */
const FILE_USER_SLACK_MS = 2 * DAY;
/** A page of the operator's list of files. */
const ADMIN_FILES_PAGE = 60;
/** The largest video an administrator may send: storage takes a file of up to 5 GB in one request. */
const ADMIN_VIDEO_BYTES = 5_000_000_000;
/** How many bytes at the start of a stored video are read to tell what kind of file it is. */
const PEEK = 16;
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
    return { ok: true, id: player.id, name: (await this.d.store.getName(player.id)) ?? null, guest: player.guest === true, account: await this.summary(player) };
  }

  async setProfile(player: Player, name: unknown): Promise<MeResponse | ApiFailure> {
    const clean = cleanName(name);
    if (!clean) return fail('bad-request');
    await this.d.store.setName(player.id, clean, player.guest ? this.d.clock.now() + GUEST_NAME_KEEP_MS : undefined);
    return this.profile(player);
  }

  /**
   * The player asks to be forgotten. The puzzles they made end (their picture is theirs to take away), they leave the others (which go on, with a new owner), the name and the record of
   * puzzles made are deleted, and then the account itself. Asking again after a failure finishes the job.
   */
  async deleteAccount(player: Player): Promise<{ ok: true } | ApiFailure> {
    const { store, accounts } = this.d;
    await this.releaseRooms(player);
    await this.releaseFiles(player.id);
    await store.forgetPlayer(player.id);
    if (accounts && !player.guest) {
      try {
        await accounts.delete(player.id);
      } catch (e) {
        console.error(e);
        return fail('busy');
      }
    }
    return { ok: true };
  }

  /** The puzzles a player made end (their picture goes with them), and they leave the others (which go on, with a new owner). */
  private async releaseRooms(player: Player): Promise<void> {
    const { store } = this.d;
    for (const id of await store.roomsOf(player.id)) {
      const room = await store.getRoom(id);
      if (!room) continue;
      if (room.ownerId === player.id) await this.cleanup(room, 'owner');
      else await this.leave(player, id);
    }
  }

  /** The files a player sent are deleted (what they took away with them is theirs to take away; the puzzles that were made from them end separately). */
  private async releaseFiles(playerId: string): Promise<void> {
    for (const id of await this.d.store.filesOf(playerId)) await this.removeFile(id);
  }

  // ---------------------------------------------------------------------------------------------------------------- reports, and what the operator does about them

  /** Whether the operator has stopped this player from playing online. */
  async isBanned(playerId: string): Promise<boolean> {
    return !!(await this.d.store.getBan(playerId));
  }

  /**
   * A member tells the operator that a puzzle is a problem. The report is kept (with who was in the puzzle: it may be gone before anyone looks) and the operator is told at once.
   * Nothing happens to the puzzle by itself: the operator looks at the picture and decides (see `adminRemoveRoom` and `adminBan`).
   */
  async report(player: Player, roomId: string, req: ReportRequest): Promise<{ ok: true } | ApiFailure> {
    const r = await this.memberRoom(player, roomId);
    if ('error' in r) return r;
    if (!REPORT_REASONS.some((x) => x.id === req?.reason)) return fail('bad-request');
    const now = this.d.clock.now();
    const tag = secretFrom(this.d.random.bytes(3));
    const report: Report = {
      id: `${String(now).padStart(15, '0')}#${tag}`,
      at: now,
      roomId,
      ownerId: r.room.ownerId,
      reporterId: player.id,
      members: r.room.members.map((m) => m.id),
      reason: req.reason,
      note: cleanNote(req.note),
    };
    await this.d.store.addReport(report);
    await this.tell(`A puzzle was reported (${report.reason}): room ${roomId}, made by ${report.ownerId}, reported by ${report.reporterId}. List the reports with the admin function.`);
    return { ok: true };
  }

  /** Tells the operator something; if that cannot be done the thing is logged and goes on (what was kept is there to be found). */
  private async tell(text: string): Promise<void> {
    try {
      await this.d.notify?.(text);
    } catch (e) {
      console.error(e);
    }
  }

  /** For the operator: the reports of the last `days` days, newest first. */
  async adminReports(days = 30): Promise<Report[]> {
    return this.d.store.reportsSince(this.d.clock.now() - days * 24 * 3600 * 1000);
  }

  /** For the operator: what a puzzle is, with a short-lived address of its picture. */
  async adminRoom(roomId: string) {
    const room = await this.live(roomId);
    if (!room) return undefined;
    return {
      id: room.id,
      ownerId: room.ownerId,
      members: room.members.map((m) => ({ id: m.id, name: m.name })),
      status: room.status,
      ready: room.ready,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      pieces: room.settings.opts.pieces,
      picture: room.ready ? await this.d.media.signedUrl(room.id) : null,
      video: room.video,
    };
  }

  /** For the operator: the puzzles that exist now, longest-lived first, with who is in each and who is connected. */
  async adminRooms(): Promise<AdminRoomSummary[]> {
    const now = this.d.clock.now();
    const out: AdminRoomSummary[] = [];
    for (const room of await this.d.store.allRooms()) {
      if (room.expiresAt <= now) continue;
      const online = new Set(await this.d.presence.online(room.id));
      out.push({
        id: room.id,
        owner: { id: room.ownerId, name: room.members.find((m) => m.id === room.ownerId)?.name ?? '' },
        members: room.members.map((m) => ({ id: m.id, name: m.name, online: online.has(m.id) })),
        pieces: room.settings.opts.pieces,
        status: room.status,
        ready: room.ready,
        createdAt: room.createdAt,
        expiresAt: room.expiresAt,
        playedMs: playedMs(room, now),
      });
    }
    return out.sort((a, b) => b.expiresAt - a.expiresAt);
  }

  /**
   * For the operator: the files that are kept, newest first, `ADMIN_FILES_PAGE` at a time, each with a short-lived address to look at it by. `before` is the `next` of the page before;
   * `next` is nothing on the last page.
   */
  async adminFiles(before?: string): Promise<{ files: AdminFile[]; next: string | null }> {
    const now = this.d.clock.now();
    const keyOf = (f: FileRecord) => `${String(f.createdAt).padStart(15, '0')}#${f.id}`;
    const all = (await this.d.store.allFiles()).filter((f) => f.expiresAt > now).sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : -1));
    const rest = before ? all.filter((f) => keyOf(f) < before) : all;
    const page = rest.slice(0, ADMIN_FILES_PAGE);
    const names = new Map<string, string>();
    for (const f of page) if (!names.has(f.ownerId)) names.set(f.ownerId, (await this.d.store.getName(f.ownerId)) ?? '');
    const files: AdminFile[] = [];
    for (const f of page) {
      files.push({
        id: f.id,
        ownerId: f.ownerId,
        ownerName: names.get(f.ownerId) ?? '',
        type: f.type,
        mime: f.mime,
        bytes: f.bytes,
        width: f.width,
        height: f.height,
        ...(f.video ? { ms: f.video.ms } : {}),
        createdAt: f.createdAt,
        usedAt: f.usedAt,
        expiresAt: f.expiresAt,
        url: await this.d.media.fileUrl(f.id),
      });
    }
    return { files, next: rest.length > page.length ? keyOf(page[page.length - 1]) : null };
  }

  /** For the operator: deletes a kept file now, and ends the puzzles that were made from it (their pictures go with them). False if there is no such file. */
  async adminRemoveFile(fileId: string): Promise<boolean> {
    if (!(await this.d.store.getFile(fileId))) return false;
    for (const room of await this.d.store.allRooms()) if (room.fileId === fileId) await this.cleanup(room, 'owner');
    await this.removeFile(fileId);
    return true;
  }

  /** For the operator: the display names that players chose (a player who never did has none here). */
  async adminNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const id of ids) {
      const name = await this.d.store.getName(id);
      if (name) names.set(id, name);
    }
    return names;
  }

  /**
   * For the operator: ends a puzzle now, with its picture and its codes; the players are told it was closed. The kept copy of the picture goes too (and the other puzzles made from it):
   * the operator ended the puzzle for what is in the picture, which must not be able to start another.
   */
  async adminRemoveRoom(roomId: string): Promise<boolean> {
    const room = await this.d.store.getRoom(roomId);
    if (!room) return false;
    await this.cleanup(room, 'owner');
    if (room.fileId) await this.adminRemoveFile(room.fileId);
    return true;
  }

  /** For the operator: stops a player from playing online (they leave every puzzle, and the puzzles they made end) until `adminUnban`. */
  async adminBan(playerId: string, reason: string): Promise<void> {
    await this.d.store.ban({ playerId, at: this.d.clock.now(), reason: cleanNote(reason).slice(0, 100) });
    await this.releaseRooms({ id: playerId, name: '' });
    await this.releaseFiles(playerId);
  }

  async adminUnban(playerId: string): Promise<void> {
    await this.d.store.unban(playerId);
  }

  adminBans() {
    return this.d.store.bans();
  }

  /** For the operator: deletes an account as if its owner had asked to (for someone who writes and cannot sign in). A guest's id starts with `g`; an account's is the `sub` of its token. */
  adminDeleteAccount(playerId: string): Promise<{ ok: true } | ApiFailure> {
    return this.deleteAccount({ id: playerId, name: '', guest: playerId.startsWith('g') });
  }

  /** The player as the others see them: with the name they chose, if they chose one, and otherwise the name that came with the token. */
  private async named(player: Player): Promise<Player> {
    const name = await this.d.store.getName(player.id);
    return name ? { ...player, name } : player;
  }

  // ---------------------------------------------------------------------------------------------------------------- accounts and credits

  /** The account's record: made (a free account with its starting credits) the first time it is asked about. */
  private async accountOf(playerId: string): Promise<AccountRecord> {
    const { store, limits, clock } = this.d;
    for (let attempt = 0; attempt < 4; attempt++) {
      const had = await store.getAccount(playerId);
      if (had) return had;
      await store.putAccount(newAccount(playerId, limits, clock.now()));                 // (false: someone else made it first: read it again)
    }
    throw new Error(`the account of ${playerId} could not be made`);
  }

  /** The type that counts: the administrators' group (the token says so) makes an account an admin whatever its record says. */
  private typeOf(player: Player, account: AccountRecord): AccountType {
    return player.admin ? 'admin' : account.type;
  }

  /** Where the player stands: a guest has nothing. */
  async summary(player: Player): Promise<AccountSummary> {
    if (player.guest) return GUEST_SUMMARY;
    const account = await this.accountOf(player.id);
    return summaryOf(this.typeOf(player, account), account, this.d.limits, this.d.clock.now());
  }

  /** Changes an account and writes it, again from the start if someone else wrote in between. `fn` returns the account to write, or a failure (then nothing is written). */
  private async changeAccount(playerId: string, fn: (account: AccountRecord) => AccountRecord | ApiFailure): Promise<{ account: AccountRecord } | ApiFailure> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const account = await this.accountOf(playerId);
      const next = fn({ ...account });
      if ('ok' in next) return next;
      next.rev = account.rev + 1;
      if (await this.d.store.putAccount(next)) return { account: next };
    }
    return fail('busy');
  }

  /** Why an ad cannot be counted for this account now, or nothing if it can. The count of ads is of today's (a new day starts it again). */
  private adRefusal(type: AccountType, account: AccountRecord, kind: 'photo' | 'video'): ApiFailure | null {
    const { limits, clock } = this.d;
    if (!adGives(type, kind)) return fail('ad-refused', { reason: 'plan' });
    if (account[kind] > 0) return fail('ad-refused', { reason: 'has-credits' });                       // only when there are none left
    const used = adsToday(account, clock.now())[kind];
    if (used >= (kind === 'photo' ? limits.adsPerDay : limits.videoAdsPerDay)) return fail('ad-refused', { reason: 'daily-limit' });
    return null;
  }

  /**
   * A rewarded ad was watched in one of the mobile apps (Steam, itch and the web have none): a free account gets photo credits for it and a paid one video credits, but only when it has
   * none left, and only so many a day. The server cannot see the ad: it asks the ad network (`Deps.ads`) when it can, and otherwise believes the game only if the operator has said
   * so (`adsTrusted`), which is for trying things out.
   */
  async claimAd(player: Player, req: AdRequest): Promise<AdResponse> {
    if (player.guest) return fail('account-required');
    if (!req || (req.kind !== 'photo' && req.kind !== 'video')) return fail('bad-request');
    const { limits, clock, ads } = this.d;
    const refuse = async (f: ApiFailure): Promise<ApiFailure> => ({ ...f, account: await this.summary(player) });
    if (req.platform !== 'android' && req.platform !== 'ios') return refuse(fail('ad-refused', { reason: 'platform' }));
    const account = await this.accountOf(player.id);
    const type = this.typeOf(player, account);
    const early = this.adRefusal(type, account, req.kind);
    if (early) return refuse(early);
    if (ads) {
      if (!(await ads.verify(req.kind, req.platform, typeof req.proof === 'string' ? req.proof.slice(0, 2000) : undefined, player.id))) return refuse(fail('ad-refused', { reason: 'unverified' }));
    } else if (!(limits.adsTrusted > 0)) return fail('ads-off');
    const done = await this.changeAccount(player.id, (a) => {
      const now = clock.now();
      if (a.adDay !== dayOf(now)) Object.assign(a, { adDay: dayOf(now), photoAds: 0, videoAds: 0 });
      const again = this.adRefusal(type, a, req.kind);                                                  // (it may have changed while the ad network was asked)
      if (again) return again;
      if (req.kind === 'photo') {
        a.photo += limits.adPhotoCredits;
        a.photoAds++;
      } else {
        a.video += limits.adVideoCredits;
        a.videoAds++;
      }
      return a;
    });
    if ('error' in done) return done.error === 'ad-refused' ? refuse(done) : done;
    return { ok: true, account: summaryOf(type, done.account, limits, clock.now()) };
  }

  /** Takes one credit of the kind, if the account has one. */
  private spend(playerId: string, kind: 'photo' | 'video'): Promise<{ account: AccountRecord } | ApiFailure> {
    return this.changeAccount(playerId, (a) => {
      if (a[kind] < 1) return fail('no-credits', { credits: kind });
      a[kind]--;
      return a;
    });
  }

  /** Gives back the credit of a puzzle that could not be made after all. */
  private async refund(playerId: string, kind: 'photo' | 'video'): Promise<void> {
    await this.changeAccount(playerId, (a) => {
      a[kind]++;
      return a;
    });
  }

  /** A paid account's payment period has begun (the payments, when they are built, call this): it is given its video credits, which add to what it has and roll over for ever. */
  async grantPaidPeriod(playerId: string): Promise<void> {
    await this.changeAccount(playerId, (a) => {
      a.video += this.d.limits.paidVideoCredits;
      return a;
    });
  }

  /** For the operator: the type and credits of each of these accounts (an account that has never been asked about shows what it will start with). */
  async adminAccounts(ids: string[]): Promise<Map<string, { type: AccountType; photo: number; video: number }>> {
    const out = new Map<string, { type: AccountType; photo: number; video: number }>();
    for (const id of ids) {
      const a = await this.d.store.getAccount(id);
      out.set(id, a ? { type: a.type, photo: a.photo, video: a.video } : { type: 'free', photo: this.d.limits.freePhotoCredits, video: 0 });
    }
    return out;
  }

  /** For the operator: changes an account's type and/or credits (payment is not built: this is how a type is given). Credits are whole numbers from 0 to a million. */
  async adminSetAccount(id: string, patch: { type?: unknown; photo?: unknown; video?: unknown }): Promise<{ ok: true; account: { type: AccountType; photo: number; video: number } } | ApiFailure> {
    const credits = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000);
    if (patch.type !== undefined && !(ACCOUNT_TYPES as readonly unknown[]).includes(patch.type)) return fail('bad-request');
    if (!credits(patch.photo) || !credits(patch.video)) return fail('bad-request');
    const done = await this.changeAccount(id, (a) => {
      if (patch.type !== undefined) a.type = patch.type as AccountType;
      if (patch.photo !== undefined) a.photo = patch.photo as number;
      if (patch.video !== undefined) a.video = patch.video as number;
      return a;
    });
    if ('error' in done) return done;
    return { ok: true, account: { type: done.account.type, photo: done.account.photo, video: done.account.video } };
  }

  /** Whether the account's own record makes it an administrator (the page may then be used without being in the group). */
  async isAdminAccount(playerId: string): Promise<boolean> {
    return (await this.d.store.getAccount(playerId))?.type === 'admin';
  }

  // ---------------------------------------------------------------------------------------------------------------- making a room

  async createRoom(who: Player, req: CreateRoomRequest): Promise<CreateRoomResponse | ApiFailure> {
    const { store, clock, random, limits } = this.d;
    // a guest may join puzzles but not make them (the cloud's gateway turns a guest's token away before it gets here; this is for any server that does not)
    if (who.guest) return fail('account-required');
    if (limits.hostingPaused > 0) return fail('paused');                        // the operator has switched the making of puzzles off
    if (req?.protocol !== PROTOCOL_VERSION) return fail('update-required', { protocol: PROTOCOL_VERSION });
    if (req.consent !== true) return fail('bad-request');
    const settings = checkSettings(req.settings, limits);
    if ('ok' in settings) return settings;
    const record = await this.accountOf(who.id);
    const type = this.typeOf(who, record);
    let video: RoomRecord['video'];
    // a file that is kept already: no picture is sent (or looked at) again. Only the player who sent it, or one who joined a puzzle made from it, may use it
    let file: FileRecord | undefined;
    if (req.fileId !== undefined) {
      if (typeof req.fileId !== 'string' || !/^[\w-]{1,64}$/.test(req.fileId)) return fail('bad-request');
      file = await this.liveFile(req.fileId);
      if (!file) return fail('file-gone');
      if (file.ownerId !== who.id && !(await store.hasFileUser(file.id, who.id))) return fail('unauthorized');
      if (file.unchecked && !skipsTheCheck(type)) return fail('unauthorized');                // (it was not looked at: only an account whose own files are not looked at may use it)
      if (settings.width !== file.width || settings.height !== file.height) return fail('file-gone');          // not the picture that is held: it has to be sent
      if (file.video) {
        if (!mayStartVideos(type)) return fail('plan-required');
        if (file.video.bytes > limits.videoBytes || file.video.ms > limits.videoMs) return fail('too-big');
        video = { ...file.video };
      }
    } else if (req.video !== undefined) {
      const v = req.video;
      if (!mayStartVideos(type)) return fail('plan-required');
      if (!v || !(VIDEO_TYPES as readonly unknown[]).includes(v.type) || !Number.isInteger(v.bytes) || v.bytes <= 0 || typeof v.ms !== 'number' || !(v.ms > 0)) return fail('bad-request');
      // the operator may try a video of any size that storage takes in one piece
      if (v.bytes > (type === 'admin' ? ADMIN_VIDEO_BYTES : limits.videoBytes) || (type !== 'admin' && v.ms > limits.videoMs)) return fail('too-big');
      video = { type: v.type, bytes: v.bytes, ms: Math.round(v.ms) };
    }
    const player = await this.named(who);
    const now = clock.now();
    // what it costs: a free account pays a photo credit for a picture; a paid one a video credit for a video; the family and the operator nothing (and they are not looked at: see `skipsTheCheck`)
    const pays: 'photo' | 'video' | null = video ? (videosAreFree(type) ? null : 'video') : photosAreFree(type) ? null : 'photo';
    const noCredits = async (kind: 'photo' | 'video'): Promise<ApiFailure> => fail('no-credits', { credits: kind, account: await this.summary(who) });
    if (pays && record[pays] < 1) return noCredits(pays);
    if ((await store.roomsOf(player.id)).length >= limits.activeRoomsPerPlayer) return fail('limit');

    const id = secretFrom(random.bytes(16));
    // the puzzle gets a copy of the file of its own, so that it ends (and its picture goes) as any other does
    if (file && !(await this.d.media.useFile(file.id, id))) {
      await this.removeFile(file.id);                                                          // the record outlived the file: the player sends it again
      return fail('file-gone');
    }
    const code = await this.newCode(id);
    if (!code) {
      if (file) await this.d.media.delete(id);
      return fail('limit');
    }
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
      video,
      unchecked: skipsTheCheck(type) || undefined,
      strict: req.stock === true || undefined,
      fileId: file?.id,
      ready: !!file,
      ...(file?.video ? { playback: { pos: 0, paused: false, at: now } } : {}),
      status: 'open',
      createdAt: now,
      expiresAt: Math.min(now + limits.idleMs, now + limits.maxAgeMs),
      state: new JigsawRoom(settings).state(),
      rev: 0,
    };
    // paid for just before the room is written, so that nothing is lost when something fails before (two puzzles started at once with one credit left: one of them is turned away here)
    if (pays) {
      const paid = await this.spend(player.id, pays);
      if ('error' in paid) {
        await store.releaseCode(code);
        if (file) await this.d.media.delete(id);
        return paid.error === 'no-credits' ? noCredits(pays) : paid;
      }
    }
    if (!(await store.putRoom(room))) {
      if (pays) await this.refund(player.id, pays);
      if (file) await this.d.media.delete(id);
      return fail('limit');
    }
    const invite = { code, secret, link: inviteLink(this.d.webBase, code, secret) };
    const account = await this.summary(who);
    if (file) {
      await store.putFile({ ...file, usedAt: now, expiresAt: now + limits.fileKeepMs });          // used: it is kept another week
      return { ok: true, roomId: id, invite, account };
    }
    const upload = video ? await this.d.media.videoUpload(id, video.type, video.bytes) : { url: await this.d.media.uploadUrl(id) };
    return { ok: true, roomId: id, upload, invite, account };
  }

  /** The file, unless it has run out of time (then it is cleared away now: nothing waits for the table's own expiry to make a file stop being used). */
  private async liveFile(id: string): Promise<FileRecord | undefined> {
    const file = await this.d.store.getFile(id);
    if (!file) return undefined;
    const now = this.d.clock.now();
    if (file.expiresAt <= now) {
      await this.removeFile(id);
      return undefined;
    }
    return file;
  }

  private async removeFile(id: string): Promise<void> {
    await this.d.media.deleteFile(id);
    await this.d.store.deleteFile(id);
  }

  /**
   * Keeps a copy of the picture or video that has just passed the check (or that was not looked at: it is marked, and only the family and the operator may make a puzzle from it),
   * as a file that a puzzle can be made from again (nothing is kept when the operator has switched keeping off). The puzzle goes on without it if it cannot be kept: the owner just has to send it again next time. Returns the file's id.
   */
  private async keep(room: RoomRecord, what: Pick<FileRecord, 'type' | 'mime' | 'bytes' | 'video'>): Promise<string | undefined> {
    const { limits, clock, random, media, store } = this.d;
    if (!(limits.fileKeepMs > 0)) return undefined;
    const id = secretFrom(random.bytes(16));
    const now = clock.now();
    try {
      await media.keepFile(room.id, id);
      await store.putFile({
        id,
        ownerId: room.ownerId,
        ...what,
        ...(room.unchecked ? { unchecked: true as const } : {}),
        width: room.settings.width,
        height: room.settings.height,
        createdAt: now,
        usedAt: now,
        expiresAt: now + limits.fileKeepMs,
      });
      return id;
    } catch (e) {
      console.error(e);
      return undefined;
    }
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
    if (this.d.moderation && !room.unchecked) {
      let verdict: Awaited<ReturnType<Moderation['check']>>;
      try {
        verdict = await this.d.moderation.check(bytes, found.type, room.strict === true);
      } catch (e) {
        console.error(e);
        return fail('busy');                                      // not looked at: nothing is shown, and the creator may send it again
      }
      if (!verdict.ok) {
        await this.cleanup(room, 'owner');
        await this.tell(`A picture was turned down by the automatic check (${verdict.label}): room ${roomId}, made by ${room.ownerId}. The puzzle was ended.`);
        return fail('rejected');
      }
    }
    await this.d.media.put(roomId, bytes, found.type);
    const fileId = await this.keep(room, { type: 'image', mime: found.type, bytes: bytes.length });
    const done = await this.update(roomId, (r) => {
      r.ready = true;
      r.fileId = fileId;
      return r;
    });
    if ('error' in done) {
      if (fileId) await this.removeFile(fileId);                         // the puzzle is gone: so is what was kept for it
      return done;
    }
    return { ok: true };
  }

  /**
   * The creator's game has put a video in storage (at the address `createRoom` gave) and asks for it to be checked; asking again says how the check is going. The file must be exactly
   * what was said (the size, the kind). Then the whole video is looked at by Amazon's service (a minute or two), and only when it passes can anyone join. A video that is turned down
   * ends the puzzle (and the operator is told); one that the service cannot read ends it too (`unreadable`). A server with no such service lets a video through.
   */
  async checkVideo(player: Player, roomId: string): Promise<VideoCheckResponse | ApiFailure> {
    const room = await this.live(roomId);
    if (!room || room.ownerId !== player.id || !room.video) return fail('not-found');
    if (room.ready) return { ok: true, state: 'ready' };
    const { videoModeration } = this.d;
    if (!room.checking) {
      const stored = await this.d.media.inspect(roomId, PEEK);
      if (!stored) return fail('not-ready');                               // the video has not arrived (yet): the creator may ask again
      if (stored.bytes !== room.video.bytes || !looksLike(stored.head, room.video.type)) {
        await this.cleanup(room, 'owner');                                  // not the file the puzzle was made for: nothing is kept
        return fail('bad-request');
      }
      if (!videoModeration || room.unchecked) return this.videoReady(room);
      let job: Awaited<ReturnType<VideoModeration['start']>>;
      try {
        job = await videoModeration.start(roomId);
      } catch (e) {
        console.error(e);
        return fail('busy');                                                // not started: nothing is shown, and the creator may ask again
      }
      if ('unreadable' in job) {
        await this.cleanup(room, 'owner');
        return fail('unreadable');
      }
      const started = await this.update(roomId, (r) => {
        r.checking ??= { jobId: job.jobId, at: this.d.clock.now() };
        return r;
      });
      if ('error' in started) return started;
      return { ok: true, state: 'checking' };
    }
    if (!videoModeration || room.unchecked) return this.videoReady(room);
    let verdict: Awaited<ReturnType<VideoModeration['result']>>;
    try {
      verdict = await videoModeration.result(room.checking.jobId, room.strict === true);
    } catch (e) {
      console.error(e);
      return fail('busy');
    }
    if (verdict.state === 'working') return { ok: true, state: 'checking' };
    if (verdict.state === 'unreadable') {
      await this.cleanup(room, 'owner');
      return fail('unreadable');
    }
    if (!verdict.ok) {
      await this.cleanup(room, 'owner');
      await this.tell(`A video was turned down by the automatic check (${verdict.label}): room ${roomId}, made by ${room.ownerId}. The puzzle was ended.`);
      return fail('rejected');
    }
    return this.videoReady(room);
  }

  /** The video has passed (or no check is made here): the room can be joined, and the video plays from the start as of now. The video is kept as a file, to make a puzzle from again. */
  private async videoReady(room: RoomRecord): Promise<VideoCheckResponse | ApiFailure> {
    const fileId = await this.keep(room, { type: 'video', mime: room.video!.type, bytes: room.video!.bytes, video: room.video });
    const done = await this.update(room.id, (r) => {
      if (r.ready) return r;                                                  // a second answer to the same question: the first one has done it
      r.ready = true;
      r.checking = undefined;
      r.fileId = fileId;
      r.playback = { pos: 0, paused: false, at: this.d.clock.now() };
      return r;
    });
    if ('error' in done) {
      if (fileId) await this.removeFile(fileId);
      return done;
    }
    if (fileId && done.room.fileId !== fileId) await this.removeFile(fileId);          // lost the race: the other answer's file is the one that is kept
    return { ok: true, state: 'ready' };
  }

  /** A server with no storage of its own to send a video to (the local one) is sent the file itself, to the address `createRoom` gave. */
  async storeVideo(roomId: string, bytes: Uint8Array): Promise<{ ok: true } | ApiFailure> {
    const room = await this.live(roomId);
    if (!room || room.ready || !room.video) return fail('not-found');
    if (bytes.length !== room.video.bytes) {
      await this.cleanup(room, 'owner');
      return fail('bad-request');
    }
    await this.d.media.put(roomId, bytes, room.video.type);
    return { ok: true };
  }

  /** The host says where the video is. Only the owner may, and only in a video puzzle; the others' games hear it at once (and those who join later are told it as they join). */
  async setPlayback(player: Player, roomId: string, req: PlaybackRequest): Promise<{ ok: true } | ApiFailure> {
    const r = await this.memberRoom(player, roomId);
    if ('error' in r) return r;
    if (r.room.ownerId !== player.id) return fail('unauthorized');
    if (!r.room.video) return fail('bad-request');
    const duration = r.room.video.ms / 1000;
    if (!req || typeof req.paused !== 'boolean' || typeof req.pos !== 'number' || !Number.isFinite(req.pos) || req.pos < 0 || req.pos > duration + 1) return fail('bad-request');
    const playback = { pos: Math.min(req.pos, duration), paused: req.paused, at: this.d.clock.now() };
    const done = await this.update(roomId, (x) => {
      x.playback = playback;
      return x;
    });
    if ('error' in done) return done;
    await this.publish(roomId, { t: 'playback', ...playback });
    return { ok: true };
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
    if (room.removed?.includes(player.id)) return fail('removed');
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
    // whoever is in a puzzle may make one of their own from its picture (a guest cannot make puzzles)
    if (done.room.fileId && !player.guest) await store.addFileUser(done.room.fileId, player.id, this.d.clock.now() + limits.fileKeepMs + FILE_USER_SLACK_MS);
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
      media: { url: await this.d.media.signedUrl(room.id), type: room.video ? 'video' : 'image', video: room.video, sourceId: room.sourceId, fileId: room.fileId },
      owner: room.ownerId,
      members: room.members,
      online: await this.d.presence.online(room.id),
      knocks: room.knocks.filter((k) => k.status === 'pending').map((k) => ({ id: k.id, name: k.name })),
      played: room.played,
      solvedMs: room.solvedMs,
      playback: room.playback,
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
      if (room.solved && r.solvedMs === undefined) r.solvedMs = playedMs(r, now);          // the time that counted, fixed at the last move
      r.expiresAt = this.expiry(r, now + (room.solved ? limits.solvedKeepMs : limits.idleMs));
      return r;
    });
    if ('error' in done) return done;
    if (refusal) return refusal;
    await this.publish(roomId, { t: 'event', ...event! });
    if (event!.solved) await this.publish(roomId, { t: 'solved', at: clock.now(), ms: done.room.solvedMs });
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
      r.expiresAt = Math.max(r.expiresAt, this.expiry(r, this.d.clock.now() + this.d.limits.idleMs));
      return r;
    });
    if ('error' in done) return done;
    if (refusal) return refusal;
    await this.publish(roomId, { t: 'renewed', id: player.id, until });          // the others' copy of the hold would run out after 10 s otherwise
    return { ok: true, until };
  }

  // ---------------------------------------------------------------------------------------------------------------- leaving, closing, inviting

  /** The player is out of the room for good (they can get back in with a code or a link). A room with nobody left goes. */
  async leave(player: Player, roomId: string): Promise<{ ok: true } | ApiFailure> {
    const before = await this.memberRoom(player, roomId);
    if ('error' in before) return before;
    const done = await this.update(roomId, (r) => {
      r.members = r.members.filter((m) => m.id !== player.id);
      if (r.ownerId === player.id && r.members.length) r.ownerId = r.members[0].id;
      this.letGo(r, player.id);
      return r;
    });
    if ('error' in done) return done;
    if (!done.room.members.length) await this.cleanup(done.room, 'solved');
    else await this.publish(roomId, { t: 'left', id: player.id });
    return { ok: true };
  }

  /** A player who goes (or is sent) out of the room does not keep a piece in their hand, or the piece they had chosen. */
  private letGo(r: RoomRecord, id: string): void {
    const room = new JigsawRoom(r.settings, r.state);
    if (room.holder(this.d.clock.now())?.holder === id) room.submit(id, { t: 'release' }, this.d.clock.now());
    room.unreserve(id);
    r.state = room.state();
  }

  /**
   * The owner sends a player out, for good: the player's id is kept in the room, and neither the code nor the link (nor a new one) lets that player back in. (A guest who clears the
   * browser's storage is a new guest; that is the limit of what an id can do.) Their live connection ends within minutes, when the broker asks again whether they are a member; the
   * message below tells their game at once.
   */
  async removeMember(player: Player, roomId: string, who: string): Promise<{ ok: true } | ApiFailure> {
    const before = await this.memberRoom(player, roomId);
    if ('error' in before) return before;
    if (before.room.ownerId !== player.id) return fail('unauthorized');
    if (who === player.id) return fail('bad-request');                      // the owner leaves with `leave`, or ends the puzzle with `close`
    if (!before.room.members.some((m) => m.id === who)) return fail('not-found');
    const done = await this.update(roomId, (r) => {
      r.members = r.members.filter((m) => m.id !== who);
      r.knocks = r.knocks.filter((k) => k.id !== who);
      r.removed = [...new Set([...(r.removed ?? []), who])];
      this.letGo(r, who);
      return r;
    });
    if ('error' in done) return done;
    await this.publish(roomId, { t: 'removed', id: who });
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

  /** Clears out the rooms nobody has touched for a day (and the solved ones whose time is up), and the files that have run out of time. Returns how many went. */
  async sweep(): Promise<number> {
    const now = this.d.clock.now();
    let n = 0;
    for (const room of await this.d.store.allRooms()) {
      if (room.expiresAt <= now) {
        await this.cleanup(room, room.status === 'solved' ? 'solved' : 'expired');
        n++;
      }
    }
    for (const file of await this.d.store.allFiles()) {
      if (file.expiresAt <= now) {
        await this.removeFile(file.id);
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------------------------- the inside

  /** When a room goes if that is what it would be without the cap on its age: never later than the longest a room may live. */
  private expiry(room: RoomRecord, wanted: number): number {
    return Math.min(wanted, room.createdAt + this.d.limits.maxAgeMs);
  }

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

/** Does a file that starts with `head` look like a video of this kind? (Only the container's own marking: what is inside is for the player to find out.) */
export function looksLike(head: Uint8Array, type: string): boolean {
  const ascii = (from: number, text: string) => [...text].every((c, i) => head[from + i] === c.charCodeAt(0));
  if (type === 'video/mp4' || type === 'video/quicktime') return head.length >= 12 && ascii(4, 'ftyp');
  if (type === 'video/webm' || type === 'video/x-matroska') return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  return false;
}
