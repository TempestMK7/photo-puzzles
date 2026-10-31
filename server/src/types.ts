import type { RoomState } from '../../src/core/jigsawRoom';
import type { Member, Playback, RoomSettings, VideoType } from '../../src/online/protocol';

/**
 * What the room service needs from the world, as interfaces: the local server fills them with memory and a few Node modules, the AWS server will fill them with DynamoDB, S3
 * and IoT Core. The service itself (service.ts) has no other dependencies.
 */

export interface Player {
  id: string;
  name: string;
  /** Someone who joins with no account: they may join puzzles, not make them. */
  guest?: boolean;
}

/** Turns what a request carries into a player; `null`: not signed in. */
export interface Auth {
  verify(token: string): Promise<Player | null>;
}

export interface Knock {
  id: string;
  name: string;
  status: 'pending' | 'allowed' | 'denied';
}

/** A room as it is stored. */
export interface RoomRecord {
  id: string;
  settings: RoomSettings;
  sourceId?: string;
  ownerId: string;
  members: Member[];
  code: string;
  /** Hash of the link's secret. */
  secretHash: string;
  knocks: Knock[];
  /** The time spent on the puzzle while someone was connected (see `played.ts`); `solvedMs` is the total once it is solved. */
  played?: { ms: number; since: number | null };
  solvedMs?: number;
  /** Players the owner sent out: they cannot join again, with the code, a new code or the link (older rooms have none). */
  removed?: string[];
  /** A puzzle made from a video: what the file is, as the owner said when making it (the storage holds exactly that many bytes, of that kind). */
  video?: { type: VideoType; bytes: number; ms: number };
  /** Where the owner's video was, as the owner last said (a video puzzle only). */
  playback?: Playback;
  /** The automatic look at the video is going on (its job's id, and when it began): the room cannot be joined until it is done. */
  checking?: { jobId: string; at: number };
  /** The picture has arrived and been checked: only then can anyone join. */
  ready: boolean;
  status: 'open' | 'solved';
  createdAt: number;
  /** When the room goes if nobody touches it. */
  expiresAt: number;
  state: RoomState;
  /** Counts up with every write, so that two writers cannot overwrite each other (a conditional write). */
  rev: number;
}

/** A player's report of a puzzle, with who was in it at the time (the puzzle may be gone by the time anyone looks). */
export interface Report {
  /** Sorts by time; unique. */
  id: string;
  at: number;
  roomId: string;
  ownerId: string;
  reporterId: string;
  members: string[];
  reason: string;
  note: string;
}

export interface Ban {
  playerId: string;
  at: number;
  reason: string;
}

export interface Store {
  getRoom(id: string): Promise<RoomRecord | undefined>;
  /** Writes the room if it is new (`rev` 0) or if the stored one still has `rev - 1`; false if someone else wrote in between. */
  putRoom(room: RoomRecord): Promise<boolean>;
  deleteRoom(id: string): Promise<void>;
  /** Claims a code for a room; false if it is taken. */
  claimCode(code: string, roomId: string): Promise<boolean>;
  roomOfCode(code: string): Promise<string | undefined>;
  releaseCode(code: string): Promise<void>;
  /** The ids of the rooms a player is in. */
  roomsOf(playerId: string): Promise<string[]>;
  /** Every room, for clearing out those that have expired. */
  allRooms(): Promise<RoomRecord[]>;
  /** The times (ms) at which a player created puzzles since `since`, for the quota. */
  creationsSince(playerId: string, since: number): Promise<number[]>;
  addCreation(playerId: string, at: number): Promise<void>;
  /** The display name a player chose (nothing if they have not). */
  getName(playerId: string): Promise<string | undefined>;
  /** `until` (ms): when it may be forgotten, for a guest, who may not come back. */
  setName(playerId: string, name: string, until?: number): Promise<void>;
  /** Keeps what a player told the operator about a puzzle. */
  addReport(report: Report): Promise<void>;
  /** The reports since `since`, newest first. */
  reportsSince(since: number): Promise<Report[]>;
  /** Stops a player from playing online (it outlives their account: a ban is only an id). */
  ban(ban: Ban): Promise<void>;
  unban(playerId: string): Promise<void>;
  getBan(playerId: string): Promise<Ban | undefined>;
  bans(): Promise<Ban[]>;
  /** Everything kept about a player but their rooms (the name, the record of puzzles made): the rooms are left or ended first. */
  forgetPlayer(playerId: string): Promise<void>;
}

/** The automatic look at a picture before anyone else may see it. */
export interface Moderation {
  /** `label` says what was found (for the operator; the player is only told that the picture cannot be used). Throws if it could not be checked. */
  check(bytes: Uint8Array, type: string): Promise<{ ok: true } | { ok: false; label: string }>;
}

/** The automatic look at a whole video, which takes a minute or two: it is started, and asked about until it is done. */
export interface VideoModeration {
  /** Starts looking at the video stored for the room: the job's id, or `unreadable` if the service will not take it at all. Throws if it could not be started (nothing was done: it may be tried again). */
  start(roomId: string): Promise<{ jobId: string } | { unreadable: true }>;
  /** How the look is going. `unreadable`: the service cannot read this video. `label` says what was found, for the operator. Throws if the answer could not be had (ask again). */
  result(jobId: string): Promise<{ state: 'working' } | { state: 'unreadable' } | { state: 'done'; ok: true } | { state: 'done'; ok: false; label: string }>;
}

/** The sign-in service, which can be told to forget an account (Cognito in the cloud; the local server has none). */
export interface Accounts {
  delete(playerId: string): Promise<void>;
}

/** Counts things per key in fixed windows of time (for the limits on how often an address or a player may do something). */
export interface RateCounter {
  /** Counts one more in the current window and says how many there are now. */
  add(key: string, windowMs: number): Promise<number>;
  /** How many there are in the current window so far. */
  count(key: string, windowMs: number): Promise<number>;
}

export interface Media {
  /** A short-lived address the creator uploads the picture to. */
  uploadUrl(roomId: string): Promise<string>;
  /** A short-lived address of the picture, for members. */
  signedUrl(roomId: string): Promise<string>;
  put(roomId: string, bytes: Uint8Array, type: string): Promise<void>;
  delete(roomId: string): Promise<void>;
  /** Where the creator sends a video of this kind and size, straight to storage (the headers go with it: the storage turns away a file of another size or kind). */
  videoUpload(roomId: string, type: string, bytes: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** What is stored for the room: how large, and the first `peek` bytes (to tell what the file is); nothing if there is nothing. */
  inspect(roomId: string, peek: number): Promise<{ bytes: number; head: Uint8Array } | undefined>;
}

/** The live side: every member of a room hears what is published for it. */
export interface PubSub {
  publish(topic: string, message: unknown): Promise<void>;
}

export interface Presence {
  /** The ids of the members connected to a room right now. */
  online(roomId: string): string[] | Promise<string[]>;
}

export interface Clock {
  now(): number;
}

export interface Random {
  bytes(n: number): Uint8Array;
  /** An integer in [0, n). */
  below(n: number): number;
}

export interface Limits {
  jigsawPieces: number;
  playersPerRoom: number;
  activeRoomsPerPlayer: number;
  freeRoomsPerWeek: number;
  idleMs: number;
  solvedKeepMs: number;
  /** A puzzle goes this long after it was made, whatever happens to it. */
  maxAgeMs: number;
  /** The largest picture accepted, in bytes. */
  pictureBytes: number;
  /** Video puzzles a player may make a week (0: switched off), and the largest and longest video. */
  videoRoomsPerWeek: number;
  videoBytes: number;
  videoMs: number;
}
