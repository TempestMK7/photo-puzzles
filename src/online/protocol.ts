import type { Command, Lock, RoomEvent, RoomState } from '../core/jigsawRoom';
import type { JigsawSetup } from '../core/jigsawSetup';

/**
 * What the game and the server say to each other when friends play one puzzle together (see docs/online-protocol.md). Types and small helpers only: nothing here talks to a
 * network, so the game, the server and the tests can all import it.
 */

/** Goes up whenever a change would make an old game and a new server misunderstand each other. A game with an older number is told to update. */
export const PROTOCOL_VERSION = 1;

/** Defaults. The server reads the real limits from its configuration (per kind of puzzle and per kind of player), so that they can change without a new game. */
export const DEFAULT_LIMITS = {
  /** Jigsaw pieces in an online puzzle. */
  jigsawPieces: 1000,
  playersPerRoom: 8,
  activeRoomsPerPlayer: 5,
  /** Online puzzles a free player may create per rolling week. */
  freeRoomsPerWeek: 3,
  /** A puzzle nobody has touched for this long is gone, with its picture and its codes. */
  idleMs: 24 * 3600 * 1000,
  /** After a puzzle is solved, how long it stays for those who are still watching. */
  solvedKeepMs: 3600 * 1000,
  /** The longest a puzzle lives, however much it is played: a puzzle that is moved every day would otherwise never go (and its picture would stay on the server for ever). */
  maxAgeMs: 30 * 24 * 3600 * 1000,
  /** Puzzles made from a video that a player may create per rolling week. 0 switches them off (they are off until the operator sets it: they cost storage, bandwidth and a look at the video). */
  videoRoomsPerWeek: 0,
  /** The largest video, in bytes, and the longest, in ms (two minutes of a phone's video is about 150 to 250 MB). */
  videoBytes: 250_000_000,
  videoMs: 120_000,
  /** A picture or video that has been uploaded and checked is kept this long after it was last used to make a puzzle, so that its owner (and anyone who joined a puzzle made from it) can make another from it without sending it again. */
  fileKeepMs: 7 * 24 * 3600 * 1000,
  /** The longest a file is kept however often it is used (it then has to be sent, and checked, again). */
  fileMaxAgeMs: 30 * 24 * 3600 * 1000,
} as const;

/**
 * The kinds of video file an online puzzle may be made from: MP4 and MOV, because those are what Amazon's check of a whole video reads (and only with H.264 inside: a file that the check
 * cannot read is refused with `unreadable`). WebM and MKV play on your own screen but cannot be checked, so they cannot be shared.
 */
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];

/** How often the player who holds a piece says where it is, and how often a hold is renewed. */
export const HAND_INTERVAL_MS = 100;
export const RENEW_INTERVAL_MS = 4000;

// ------------------------------------------------------------------------------------------------------------------------------- what a room is

export interface RoomSettings extends JigsawSetup {
  kind: 'jigsaw';
}

export interface Member {
  /** The account's id. */
  id: string;
  name: string;
  /** An index into a palette the game has, so that everyone sees each player in the same colour. */
  color: number;
}

export interface Media {
  /** A short-lived address of the picture (or video), for members only. */
  url: string;
  type: 'image' | 'video';
  /** For a video: the kind of file, and how long and large it is. */
  video?: { type: VideoType; ms: number; bytes: number };
  /** The id of the picture in the library of the player who made the puzzle, so that this player's game knows it already has it. */
  sourceId?: string;
  /** The server's id of the file (see `CreateRoomRequest.fileId`): a player who keeps this picture keeps the id with it, and can make a puzzle of their own from it without sending it again. Nothing for a puzzle whose file is not kept. */
  fileId?: string;
}

/** Everything a game needs to start playing a room, and to catch up again after it lost touch. */
export interface RoomDescriptor {
  id: string;
  protocol: number;
  settings: RoomSettings;
  media: Media;
  owner: string;
  members: Member[];
  /** The ids of the members connected right now. */
  online: string[];
  /** The time spent on the puzzle while someone was connected: `ms` was counted, and a stretch that began at `since` (the server's clock) is going on. Once solved, `solvedMs` is the total. */
  played?: { ms: number; since: number | null };
  solvedMs?: number;
  /** Players who knocked (joined with the code alone) and wait for a member to say yes or no: one who comes after they knocked still sees them. */
  knocks?: { id: string; name: string }[];
  state: RoomState;
  /** The server's clock when this was made, in ms: a lock's `until` is on that clock, and the game works out how far its own is off. */
  serverTime: number;
  /** When the room goes if nobody touches it. */
  expiresAt: number;
  status: 'open' | 'solved';
  /** A video puzzle: where the owner's video was when `at` (the server's clock) came: see `playbackNow`. */
  playback?: Playback;
}

/**
 * Where the video of a puzzle is, as the owner (the host) last said: at `pos` seconds, and `paused` or playing, as of `at` (the server's clock, in ms). A player who joins starts there, and
 * one who asks to sync with the host is taken there again.
 */
export interface Playback {
  pos: number;
  paused: boolean;
  at: number;
}

/** Where the video should be now (in seconds, within a video that is `duration` long and loops), by the server's clock `now`: a playing video moves on since `at`. */
export function playbackNow(p: Playback, now: number, duration: number): number {
  if (!(duration > 0)) return Math.max(0, p.pos);
  const pos = p.paused ? p.pos : p.pos + Math.max(0, now - p.at) / 1000;
  return ((pos % duration) + duration) % duration;
}

// ------------------------------------------------------------------------------------------------------------------------------- requests

export type ApiError =
  | 'update-required'
  | 'unauthorized'
  | 'bad-request'
  | 'not-found'
  | 'expired'
  | 'quota'
  | 'limit'
  | 'full'
  | 'rate-limited'
  /** Joining by code waits for a member to say yes. */
  | 'knock-pending'
  | 'knock-denied'
  /** The owner sent this player out of the puzzle: neither the code nor the link lets them back in. */
  | 'removed'
  /** The picture has not arrived yet. */
  | 'not-ready'
  | 'busy'
  | 'not-holder'
  | 'no-group'
  | 'ended'
  /** Making a puzzle needs an account; joining one does not. */
  | 'account-required'
  /** The operator has stopped this player from playing online. */
  | 'banned'
  /** The automatic check of the picture turned it down. */
  | 'rejected'
  /** Making new puzzles is switched off for now (the operator's limit is 0); joining and playing go on. */
  | 'paused'
  /** Puzzles made from a video are switched off for now (their limit is 0). */
  | 'video-off'
  /** The video is longer or larger than the limits allow. */
  | 'too-big'
  /** The automatic check could not read the video (it reads MP4 and MOV made with H.264). */
  | 'unreadable'
  /** The library of stock pictures and videos cannot be used right now (it is not set up, or its provider does not answer). */
  | 'stock-off'
  /** The file that a puzzle was to be made from is not held any more (it was kept for a week after it was last used), or is not the size the puzzle says: send it again. */
  | 'file-gone';

// ------------------------------------------------------------------------------------------------------------------------------- stock pictures and videos

export type StockType = 'photo' | 'video';

/** The sites that the stock library takes pictures and videos from. */
export type StockSite = 'pexels' | 'pixabay';
export const STOCK_SITES: readonly StockSite[] = ['pexels', 'pixabay'];
export const STOCK_NAMES: Record<StockSite, string> = { pexels: 'Pexels', pixabay: 'Pixabay' };
export const STOCK_HOMES: Record<StockSite, string> = { pexels: 'https://www.pexels.com/', pixabay: 'https://pixabay.com/' };

/** One picture or video of the stock library, as the server found it. Every address is one of its site's own (the page checks that before it fetches anything). */
export interface StockItem {
  id: string;
  /** Which site it is from (its id is that site's). */
  source: StockSite;
  type: StockType;
  title: string;
  /** Who made it, and where to see them and the picture on its site (shown with the picture: the sites ask for that). */
  by: string;
  byUrl: string;
  url: string;
  /** A small picture for the list, what to show in the big preview (a picture, or a small video), and the file to put in the library. */
  thumb: string;
  preview: string;
  file: string;
  fileType: string;
  width: number;
  height: number;
  /** Seconds, for a video. */
  duration: number;
}

export interface StockResponse {
  ok: true;
  items: StockItem[];
  page: number;
  /** There is a next page. */
  more: boolean;
  /** The site these come from, and the sites that this server can search (the page offers a choice when there are two). */
  source: StockSite;
  sources: StockSite[];
}

/** An address on a stock site's own servers (https, a host that is the site's domain or below it): nothing else is passed on to the game. */
export function stockUrl(site: StockSite, v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  const domain = `${site}.com`;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && (u.hostname === domain || u.hostname.endsWith(`.${domain}`)) ? u.href : null;
  } catch {
    return null;
  }
}

export const pexelsUrl = (v: unknown): string | null => stockUrl('pexels', v);
export const pixabayUrl = (v: unknown): string | null => stockUrl('pixabay', v);

export interface ApiFailure {
  ok: false;
  error: ApiError;
  /** For `busy`: who holds the piece. For `quota`: when the next puzzle can be made (ms). For `update-required`: the version the server wants. */
  holder?: string;
  retryAt?: number;
  protocol?: number;
}

export interface CreateRoomRequest {
  protocol: number;
  settings: RoomSettings;
  sourceId?: string;
  /** The player has said yes to the picture leaving the device. */
  consent: true;
  /** A puzzle made from a video: what the file is (the board's `width` and `height` are the video's). The video goes straight to storage (`upload`), then the owner's game asks for it to be checked (`VideoCheckResponse`). */
  video?: { type: VideoType; bytes: number; ms: number };
  /** The picture or video is one of the stock library's (the game says so): it gets the stricter automatic look, which also turns down nudity that is not explicit. */
  stock?: true;
  /**
   * Make the puzzle from a file the server holds already (the `fileId` of an earlier puzzle's picture) instead of sending one: nothing is uploaded or checked again, and the file is kept for another
   * week. Only the player who sent the file, or one who joined a puzzle made from it, may (`unauthorized` otherwise); a file that is gone is `file-gone`, and the game then sends it as usual.
   * `settings.width` and `height` must be the file's.
   */
  fileId?: string;
}

export interface CreateRoomResponse {
  ok: true;
  roomId: string;
  /** Where to upload the picture to (a signed address), and what to send: the picture, as image/jpeg. For a video: where to PUT the file, with these headers, and nothing else (the size and type were given above). Nothing when the puzzle was made from a `fileId`: it is ready to be joined. */
  upload?: { url: string; headers?: Record<string, string> };
  invite: Invite;
}

export interface Invite {
  /** Five digits. */
  code: string;
  /** Joins without a knock; goes in the link. */
  secret: string;
  link: string;
}

/**
 * The answer to "the video is up, check it" (and to asking again): the whole video is looked at by Amazon's service, which takes a minute or two, so the owner's game asks every few seconds
 * until it says `ready`. A video that is turned down is `rejected` (as a picture is), one the check cannot read is `unreadable`.
 */
export interface VideoCheckResponse {
  ok: true;
  state: 'checking' | 'ready';
}

/** The host says where the video is (the owner's game, when they play, pause or move it, and now and then while it plays). */
export interface PlaybackRequest {
  pos: number;
  paused: boolean;
}

export interface JoinRequest {
  protocol: number;
  code: string;
  secret?: string;
}

export type JoinResponse = { ok: true; room: RoomDescriptor } | ApiFailure;

export interface CommandRequest {
  protocol: number;
  command: Command;
}

export type CommandResponse = { ok: true; event: RoomEvent } | ApiFailure;

/** One line of "my online puzzles". */
export interface RoomSummary {
  id: string;
  settings: Pick<RoomSettings, 'kind'> & { opts: Record<string, number> };
  owner: string;
  members: Member[];
  online: number;
  status: 'open' | 'solved';
  expiresAt: number;
}

// ------------------------------------------------------------------------------------------------------------------------------- live

/** The topics of a room. */
export const topics = {
  /** The server publishes every `RoomMessage` here; every member listens. */
  events: (room: string) => `puzzle/${room}/events`,
  /** The player who holds a piece publishes `HandMessage`s here, and only on their own topic. Everyone else listens to `hands`. */
  hand: (room: string, player: string) => `puzzle/${room}/hand/${player}`,
  hands: (room: string) => `puzzle/${room}/hand/+`,
} as const;

/** What a player is called to the others: at most this many characters. */
export const NAME_MAX = 24;

/** A display name as it is kept: no control or direction-changing characters, spaces squeezed together, cut to `NAME_MAX`; nothing if nothing is left. */
export function cleanName(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, '').replace(/\s+/g, ' ').trim();
  const cut = Array.from(t).slice(0, NAME_MAX).join('').trim();
  return cut || null;
}

/** Why a player reports a puzzle (the picture is what is usually wrong with one). */
export const REPORT_REASONS = [
  { id: 'illegal', label: 'Something illegal' },
  { id: 'adult', label: 'Sexual or violent pictures' },
  { id: 'harassment', label: 'Harassment or hate' },
  { id: 'copyright', label: 'A picture that belongs to someone else' },
  { id: 'other', label: 'Something else' },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]['id'];
export const NOTE_MAX = 300;

export interface ReportRequest {
  reason: ReportReason;
  /** What the player wants the operator to know. */
  note?: string;
}

/** A note as it is kept: no control or direction-changing characters (line breaks stay as spaces), cut to `NOTE_MAX`; empty if nothing is left. */
export function cleanNote(text: unknown): string {
  if (typeof text !== 'string') return '';
  const t = text.replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, NOTE_MAX).join('').trim();
}

/** What the server says about the player who asks: `name` is nothing until they have chosen one. */
export interface MeResponse {
  ok: true;
  id: string;
  name: string | null;
  guest: boolean;
}

/** A guest's token: someone who joins puzzles without an account. The same token (and so the same player) is asked for again before it runs out. */
export interface GuestResponse {
  ok: true;
  token: string;
  id: string;
  /** When the token runs out (ms). */
  expiresAt: number;
}

/**
 * The name a game gives its connection to a room's broker: `<room>:<player>:<one connection>`. The cloud's policy only lets a player connect under a name that starts with their own
 * room and id (so it is checked, not trusted), and the function that tells who is online reads the room and the player back from the name. The last part is different for every
 * connection, so that two tabs of one player do not throw each other out.
 */
export const liveClientId = (room: string, player: string, connection: string): string => `${room}:${player}:${connection}`;

export function parseLiveClientId(clientId: string): { room: string; player: string; connection: string } | undefined {
  const m = /^([\w-]{1,64}):([\w-]{1,128}):([\w-]{1,32})$/.exec(clientId);
  return m ? { room: m[1], player: m[2], connection: m[3] } : undefined;
}

/** Where the piece in hand is right now. It is not part of the board: it only moves the piece on the screens of the others until a `drop` says where it ended. */
export interface HandMessage {
  /** A piece of the group in hand. */
  piece: number;
  dx: number;
  dy: number;
  rot: number;
  /** The sorting tray the group is over (the pose is then in the tray's space); left out for the table. */
  tray?: number;
  /** Counts up, so that a late message is not taken for a newer one. */
  n: number;
}

export type RoomMessage =
  | ({ t: 'event' } & RoomEvent)
  | { t: 'joined'; member: Member }
  | { t: 'left'; id: string }
  /** The owner sent a member out (the member's own game goes back to the main screen). */
  | { t: 'removed'; id: string }
  /** The player who holds a piece still does: the hold now lasts until `until` (the server's clock). Without it the others would think a long hold had run out. */
  | { t: 'renewed'; id: string; until: number }
  /** A member's game connected to the room or lost it. */
  | { t: 'presence'; id: string; online: boolean }
  /** Someone asked to join with the code and a member has to say yes or no. */
  | { t: 'knock'; id: string; name: string }
  /** The count of time spent on the puzzle started or stopped (someone connected to a room with nobody in it, or the last one left). */
  | { t: 'played'; ms: number; since: number | null }
  /** The host played, paused or moved the video (see `Playback`). */
  | ({ t: 'playback' } & Playback)
  | { t: 'solved'; at: number; ms?: number }
  /** The room is over (closed by its owner, or gone), so the game goes back to the main screen. */
  | { t: 'closed'; reason: 'owner' | 'expired' | 'solved' };

/** The lock as the game should read it: held now, on the game's own clock (`offset` = server clock minus the game's clock). */
export function lockHeld(lock: Lock | null, now: number, offset: number): boolean {
  return !!lock && lock.until > now + offset;
}

// ------------------------------------------------------------------------------------------------------------------------------- codes and links

export const CODE_LENGTH = 5;
const SECRET_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Five digits, typed with or without spaces or dashes. */
export function normalizeCode(text: string): string | null {
  const digits = text.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(digits) ? digits : null;
}

/** A random secret for a link, from a source of random bytes (the server's). */
export function secretFrom(random: Uint8Array): string {
  let s = '';
  for (const b of random) s += SECRET_ALPHABET[b % SECRET_ALPHABET.length];
  return s;
}

export function isSecret(text: string): boolean {
  return /^[a-z2-9]{16,64}$/.test(text) && [...text].every((c) => SECRET_ALPHABET.includes(c));
}

/** The link that opens the web version at `base` and joins: everything after the `#` stays in the browser and never reaches a server log. */
export function inviteLink(base: string, code: string, secret: string): string {
  return `${base.replace(/\/+$/, '')}/#/join/${code}~${secret}`;
}

/** A code, or a code with its secret, or a whole link: what a player pasted into the "join" box (or what the page was opened with). */
export function parseInvite(text: string): { code: string; secret?: string } | null {
  const t = text.trim();
  const m = /#\/join\/([^/?#\s]+)/.exec(t);
  const body = m ? decodeURIComponent(m[1]) : t;
  const [rawCode, secret, ...rest] = body.split('~');
  const code = normalizeCode(rawCode);
  if (!code || rest.length || (secret !== undefined && !isSecret(secret))) return null;
  return secret === undefined ? { code } : { code, secret };
}
