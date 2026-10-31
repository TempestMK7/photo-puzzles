// What the admin page (src/admin/) and the admin routes of the API (server/src/adminweb.ts) say to each other. No browser or Node dependencies, like protocol.ts.

/** The Cognito group whose members may use the admin page. */
export const ADMIN_GROUP = 'admins';

/** An account, as the admin page lists it (the user pool's record joined with what the service knows). */
export interface AdminPlayer {
  /** The `sub` of the account's tokens: what puzzles, reports and bans call the player. */
  id: string;
  email: string;
  /** The display name the player chose here (empty if they never did). */
  name: string;
  created: number;
  /** The user pool's word for it (CONFIRMED, UNCONFIRMED, FORCE_CHANGE_PASSWORD, ...). */
  status: string;
  enabled: boolean;
  banned: boolean;
}

/** A puzzle that exists now, as the admin page lists it. */
export interface AdminRoomSummary {
  id: string;
  owner: { id: string; name: string };
  members: { id: string; name: string; online: boolean }[];
  pieces: number;
  status: 'open' | 'solved';
  /** The picture has arrived and been checked: only then can anyone join. */
  ready: boolean;
  createdAt: number;
  expiresAt: number;
  /** The time spent on it while someone was connected (see server/src/played.ts). */
  playedMs: number;
}

/** One puzzle, to look at: who is in it, and a short-lived address of its picture. */
export interface AdminRoomDetail {
  id: string;
  ownerId: string;
  members: { id: string; name: string }[];
  status: 'open' | 'solved';
  ready: boolean;
  createdAt: number;
  expiresAt: number;
  pieces: number;
  picture: string | null;
  /** A puzzle made from a video: `picture` is then the address of the video. */
  video?: { type: string; ms: number; bytes: number };
}

export interface AdminReport {
  id: string;
  at: number;
  roomId: string;
  ownerId: string;
  reporterId: string;
  members: string[];
  reason: string;
  note: string;
}

export interface AdminBan {
  playerId: string;
  at: number;
  reason: string;
}

/** A place the functions write their logs to (`label` is the function's name, like Api or Presence). */
export interface AdminLogGroup {
  name: string;
  label: string;
}

export interface AdminLogEvent {
  /** ms since 1970. */
  t: number;
  message: string;
}

export const LOG_MINUTES_MAX = 24 * 60;
export const LOG_FILTER_MAX = 100;
export const LOG_EVENTS_MAX = 200;
