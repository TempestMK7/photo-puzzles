import type { RoomState } from '../../src/core/jigsawRoom';
import type { AccountType, Member, Playback, RoomSettings, VideoType } from '../../src/online/protocol';

/**
 * What the room service needs from the world, as interfaces: the local server fills them with memory and a few Node modules, the AWS server will fill them with DynamoDB, S3
 * and IoT Core. The service itself (service.ts) has no other dependencies.
 */

export interface Player {
  id: string;
  name: string;
  /** Someone who joins with no account: they may join puzzles, not make them. */
  guest?: boolean;
  /** The token says this account is in the administrators' group (the admin page's): it may make a video puzzle that is not limited in size or looked at (for trying things out). */
  admin?: true;
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
  /** The host lets the players use hints and bombs here. */
  helpers?: true;
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
  /** The owner is an account whose pictures and videos are not looked at by the automatic check (the family's and the operator's: see `skipsTheCheck`). */
  unchecked?: true;
  /** The picture or video came from the stock library: the automatic look is stricter (see `strict` in aws/rekognition.ts). */
  strict?: true;
  /** A puzzle made from a video: what the file is, as the owner said when making it (the storage holds exactly that many bytes, of that kind). */
  video?: { type: VideoType; bytes: number; ms: number };
  /** Where the owner's video was, as the owner last said (a video puzzle only). */
  playback?: Playback;
  /** The automatic look at the video is going on (its job's id, and when it began): the room cannot be joined until it is done. */
  checking?: { jobId: string; at: number };
  /** The kept file (see `FileRecord`) that this puzzle's picture is a copy of: the picture the owner sent once it was checked, or the one the puzzle was made from again. Nothing if it is not kept. */
  fileId?: string;
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

/**
 * A picture or video that was sent and passed the check, kept after its puzzle is gone so that a puzzle can be made from it again without sending and checking it again. The file
 * itself is in the media storage (`Media.keepFile`); a puzzle gets a copy of its own, so that it ends as before. It is kept `fileKeepMs` after it was last used.
 */
export interface FileRecord {
  id: string;
  /** Who sent it. Nobody but them and the players who joined a puzzle made from it may make a puzzle from it (see `Store.addFileUser`). */
  ownerId: string;
  type: 'image' | 'video';
  /** What the file is, as it was stored (image/jpeg, image/png, video/mp4, ...). */
  mime: string;
  bytes: number;
  /** The size of the picture (or of each frame of the video): a puzzle made from the file has this size. */
  width: number;
  height: number;
  video?: { type: VideoType; bytes: number; ms: number };
  /** It was not looked at by the automatic check (an account of the family's or the operator's sent it): only such an account may make a puzzle from it, and the operator looks at it by hand. */
  unchecked?: true;
  createdAt: number;
  /** When a puzzle was last made from it (or it was sent). */
  usedAt: number;
  /** When it goes if no puzzle is made from it: `fileKeepMs` after `usedAt`. */
  expiresAt: number;
}

/**
 * What the service keeps about an account that is not a guest: its type, and the credits that starting puzzles costs (see `AccountType` in protocol.ts). It is made the first time the account
 * is asked about, as a free account with `freePhotoCredits`. Every account has both kinds of credits whatever its type (they are only spent, or shown, as the type says), so that
 * an account that is changed to another type keeps what it had.
 */
export interface AccountRecord {
  id: string;
  type: AccountType;
  photo: number;
  video: number;
  /** The day (UTC, YYYY-MM-DD) that `photoAds` and `videoAds` are counted for: the number of ads that gave credits that day. */
  adDay: string;
  photoAds: number;
  videoAds: number;
  /** Hints and bombs held (an account from before they existed has none of the fields: it is given the starting number the first time it is read). */
  hints?: number;
  bombs?: number;
  /** The day (UTC, YYYY-MM-DD) that `hintsEarned` is counted for: the hints that solved puzzles gave that day (a free account may earn so many a day). */
  hintDay?: string;
  hintsEarned?: number;
  createdAt: number;
  /** Counts up with every write, so that two writers cannot overwrite each other (a conditional write, as for a room). */
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
  /** The account of a player who has one (nothing for a guest, or an account that has not been asked about yet). */
  getAccount(playerId: string): Promise<AccountRecord | undefined>;
  /** Keeps what an ad was asked for (see `AdNonce`) until it has been watched; nothing is found once it has run out. */
  putAdNonce(nonce: AdNonce): Promise<void>;
  getAdNonce(nonce: string): Promise<AdNonce | undefined>;
  deleteAdNonce(nonce: string): Promise<void>;
  /** The ad network's numbers for the rewards it has reported (each is reported once, but may be reported again if the answer was lost). `until` (ms): when it may be forgotten. */
  hasAdTransaction(transactionId: string): Promise<boolean>;
  putAdTransaction(transactionId: string, until: number): Promise<void>;
  /** Writes the account if it is new (`rev` 0) or if the stored one still has `rev - 1`; false if someone else wrote in between. */
  putAccount(account: AccountRecord): Promise<boolean>;
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
  /** A kept file; nothing if there is none (one that has run out of time may still be here: the service looks). */
  getFile(id: string): Promise<FileRecord | undefined>;
  /** Writes a file (new, or with its time put forward). */
  putFile(file: FileRecord): Promise<void>;
  /** The file, with the record of who may use it. */
  deleteFile(id: string): Promise<void>;
  /** Says that the player may make a puzzle from the file (they joined a puzzle made from it). `until` (ms): after this the entry may be forgotten. */
  addFileUser(fileId: string, playerId: string, until: number): Promise<void>;
  hasFileUser(fileId: string, playerId: string): Promise<boolean>;
  /** The ids of the files a player sent. */
  filesOf(playerId: string): Promise<string[]>;
  /** Every file there is, for the operator to look through and for clearing out those that have run out of time. */
  allFiles(): Promise<FileRecord[]>;
  /** Everything kept about a player but their rooms (the name, the account and its credits): the rooms are left or ended first. */
  forgetPlayer(playerId: string): Promise<void>;
}

/** The automatic look at a picture before anyone else may see it. */
export interface Moderation {
  /** `label` says what was found (for the operator; the player is only told that the picture cannot be used). Throws if it could not be checked. */
  check(bytes: Uint8Array, type: string, strict?: boolean): Promise<{ ok: true } | { ok: false; label: string }>;
}

/** The automatic look at a whole video, which takes a minute or two: it is started, and asked about until it is done. */
export interface VideoModeration {
  /** Starts looking at the video stored for the room: the job's id, or `unreadable` if the service will not take it at all. Throws if it could not be started (nothing was done: it may be tried again). */
  start(roomId: string): Promise<{ jobId: string } | { unreadable: true }>;
  /** How the look is going. `unreadable`: the service cannot read this video. `label` says what was found, for the operator. Throws if the answer could not be had (ask again). */
  result(jobId: string, strict?: boolean): Promise<{ state: 'working' } | { state: 'unreadable' } | { state: 'done'; ok: true } | { state: 'done'; ok: false; label: string }>;
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
  /** Keeps a copy of what is stored for the room, as the file `fileId` (see `FileRecord`). */
  keepFile(roomId: string, fileId: string): Promise<void>;
  /** Gives the room (a new one) its own copy of a kept file; false if the file is not there. */
  useFile(fileId: string, roomId: string): Promise<boolean>;
  deleteFile(fileId: string): Promise<void>;
  /** A short-lived address of a kept file, for the operator to look at. */
  fileUrl(fileId: string): Promise<string>;
}

/**
 * What the game said it was going to show an ad for: a one-time number that the game gives the ad network with the ad (the network sends it back when the ad has been watched), so that
 * the reward that the network reports can be matched to the account that asked for it, and only to that one.
 */
export interface AdNonce {
  nonce: string;
  playerId: string;
  kind: 'photo' | 'video';
  expiresAt: number;
}

/**
 * What the check of a call from the ad network found. A call that is **not genuine** (not signed, signed with a key that is not the network's, or changed) says why. A genuine one
 * is the network's word whatever it says: it carries the reward if it is one that we can use, and otherwise why not (it is for another ad unit, it is old, it has not what a reward has).
 */
export type AdReport =
  | { genuine: false; reason: 'unsigned' | 'unknown-key' | 'bad-signature' }
  | { genuine: true; reward: { transactionId: string; customData: string; at: number } | null; why?: 'other-unit' | 'old' | 'incomplete' };

/** The ad network's word that a rewarded ad was watched: it calls the server, and this says whether the call is the network's (checking its signature) and what it says. */
export interface AdCallbacks {
  /** `rawQuery` is the query string exactly as it came (the network signed its text). */
  verify(rawQuery: string): Promise<AdReport>;
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
  /** 1: nobody can start a puzzle (joining and playing go on). */
  hostingPaused: number;
  /** The photo credits a new account starts with, and what an ad gives (photo credits to a free account, video credits to a paid one). */
  freePhotoCredits: number;
  adPhotoCredits: number;
  adVideoCredits: number;
  /** Ads that may be watched a day for photo credits and for video credits. */
  adsPerDay: number;
  videoAdsPerDay: number;
  /** 1: an ad is believed without being checked (for trying things out). */
  adsTrusted: number;
  /** The video credits a paid account is given for each payment period. */
  paidVideoCredits: number;
  /** The hints and bombs a new account starts with. */
  startHints: number;
  startBombs: number;
  /** The hints a free account can earn in a day. */
  freeHintsPerDay: number;
  idleMs: number;
  solvedKeepMs: number;
  /** A puzzle goes this long after it was made, whatever happens to it. */
  maxAgeMs: number;
  /** The largest picture accepted, in bytes. */
  pictureBytes: number;
  /** The largest and longest video. */
  videoBytes: number;
  videoMs: number;
  /** A file is kept this long after it was last used to make a puzzle. */
  fileKeepMs: number;
}
