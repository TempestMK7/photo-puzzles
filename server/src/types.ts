import type { RoomState } from '../../src/core/jigsawRoom';
import type { Member, RoomSettings } from '../../src/online/protocol';

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
}

export interface Media {
  /** A short-lived address the creator uploads the picture to. */
  uploadUrl(roomId: string): Promise<string>;
  /** A short-lived address of the picture, for members. */
  signedUrl(roomId: string): Promise<string>;
  put(roomId: string, bytes: Uint8Array, type: string): Promise<void>;
  delete(roomId: string): Promise<void>;
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
  /** The largest picture accepted, in bytes. */
  pictureBytes: number;
}
