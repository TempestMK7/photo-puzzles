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
} as const;

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
  /** A short-lived address of the picture, for members only. */
  url: string;
  type: 'image';
  /** The id of the picture in the library of the player who made the puzzle, so that this player's game knows it already has it. */
  sourceId?: string;
}

/** Everything a game needs to start playing a room, and to catch up again after it lost touch. */
export interface RoomDescriptor {
  id: string;
  protocol: number;
  settings: RoomSettings;
  media: Media;
  owner: string;
  members: Member[];
  state: RoomState;
  /** The server's clock when this was made, in ms: a lock's `until` is on that clock, and the game works out how far its own is off. */
  serverTime: number;
  /** When the room goes if nobody touches it. */
  expiresAt: number;
  status: 'open' | 'solved';
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
  | 'busy'
  | 'not-holder'
  | 'no-group'
  | 'ended';

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
}

export interface CreateRoomResponse {
  ok: true;
  roomId: string;
  /** Where to upload the picture to (a signed address), and what to send: the picture, as image/jpeg. */
  upload: { url: string };
  invite: Invite;
}

export interface Invite {
  /** Five digits. */
  code: string;
  /** Joins without a knock; goes in the link. */
  secret: string;
  link: string;
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

/** Where the piece in hand is right now. It is not part of the board: it only moves the piece on the screens of the others until a `drop` says where it ended. */
export interface HandMessage {
  gid: number;
  dx: number;
  dy: number;
  rot: number;
  /** Counts up, so that a late message is not taken for a newer one. */
  n: number;
}

export type RoomMessage =
  | ({ t: 'event' } & RoomEvent)
  | { t: 'joined'; member: Member }
  | { t: 'left'; id: string }
  /** Someone asked to join with the code and a member has to say yes or no. */
  | { t: 'knock'; id: string; name: string }
  | { t: 'solved'; at: number }
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
