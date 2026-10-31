import { ADMIN_GROUP, LOG_EVENTS_MAX, LOG_FILTER_MAX, LOG_MINUTES_MAX, type AdminLogEvent, type AdminLogGroup, type AdminPlayer } from '../../src/online/adminProtocol';
import type { RoomService } from './service';

/**
 * The admin page's side of the API: what the operator can look at (the players that have accounts, the puzzles that exist, the reports, the logs) and the few things they can do
 * about it (end a puzzle, ban or unban a player). The gateway has checked the token already; every request is checked again here for the admin group, so that a signed-in
 * player who is not an administrator gets nothing. Plain data in and out, so that it can be tested without AWS (aws/adminweb.ts is what gives it the real directory and logs).
 */

/** The user pool's list of accounts. */
export interface Directory {
  listUsers(next?: string): Promise<{ users: DirectoryUser[]; next?: string }>;
}

export interface DirectoryUser {
  id: string;
  email: string;
  created: number;
  status: string;
  enabled: boolean;
}

/** The functions' logs. */
export interface LogSource {
  groups(): Promise<AdminLogGroup[]>;
  /** The events of a log group since `since` (ms) that match `filter` (CloudWatch's filter syntax; empty: all), newest first, at most `limit`. */
  events(group: string, since: number, filter: string, limit: number): Promise<AdminLogEvent[]>;
}

export interface AdminWebReq {
  method: string;
  /** Without a trailing slash. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** The groups the token says the account is in (see `parseGroups`). */
  groups: string[];
}

export interface AdminWebRes {
  status: number;
  body: { ok: boolean; [key: string]: unknown };
}

/** The `cognito:groups` claim as the gateway hands it over: a string like `[admins]` or `[admins editors]` (or the bare name), or already a list. */
export function parseGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter((g): g is string => typeof g === 'string');
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

const ID = /^[\w-]{1,128}$/;
const isId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);
const no = (status: number, error: string): AdminWebRes => ({ status, body: { ok: false, error } });
const ok = (body: Record<string, unknown> = {}): AdminWebRes => ({ status: 200, body: { ok: true, ...body } });

export function makeAdminWeb(d: { service: RoomService; directory: Directory; logs: LogSource; now(): number }) {
  const { service } = d;
  return async (req: AdminWebReq): Promise<AdminWebRes> => {
    if (!req.groups.includes(ADMIN_GROUP)) return no(403, 'unauthorized');
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const path = req.path.replace(/\/+$/, '');
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    let m: RegExpExecArray | null;

    if (get && path === '/admin/me') return ok();

    if (get && path === '/admin/players') {
      const page = await d.directory.listUsers(req.query.get('next') || undefined);
      const names = await service.adminNames(page.users.map((u) => u.id));
      const banned = new Set((await service.adminBans()).map((b) => b.playerId));
      const players: AdminPlayer[] = page.users.map((u) => ({ ...u, name: names.get(u.id) ?? '', banned: banned.has(u.id) }));
      return ok({ players, next: page.next ?? null });
    }

    if (get && path === '/admin/rooms') return ok({ rooms: await service.adminRooms() });

    if (get && (m = /^\/admin\/room\/([\w-]{1,128})$/.exec(path))) {
      const room = await service.adminRoom(m[1]);
      return room ? ok({ room }) : no(404, 'not-found');
    }
    if (post && (m = /^\/admin\/room\/([\w-]{1,128})\/remove$/.exec(path))) return (await service.adminRemoveRoom(m[1])) ? ok() : no(404, 'not-found');

    // the pictures and videos that the server keeps: newest first, a page at a time (`next` of one page is `before` of the next)
    if (get && path === '/admin/files') {
      const before = req.query.get('before') ?? undefined;
      if (before !== undefined && !/^\d{15}#[\w-]{1,64}$/.test(before)) return no(400, 'before');
      return ok({ ...(await service.adminFiles(before)) });
    }
    if (post && (m = /^\/admin\/file\/([\w-]{1,128})\/remove$/.exec(path))) return (await service.adminRemoveFile(m[1])) ? ok() : no(404, 'not-found');

    if (get && path === '/admin/reports') {
      const days = Number(req.query.get('days') ?? 30);
      if (!Number.isFinite(days) || days <= 0 || days > 90) return no(400, 'days');
      return ok({ reports: await service.adminReports(days) });
    }

    if (get && path === '/admin/bans') return ok({ bans: await service.adminBans() });
    if (post && path === '/admin/ban') {
      if (!isId(body.id)) return no(400, 'id');
      await service.adminBan(body.id, typeof body.reason === 'string' ? body.reason : '');
      return ok();
    }
    if (post && path === '/admin/unban') {
      if (!isId(body.id)) return no(400, 'id');
      await service.adminUnban(body.id);
      return ok();
    }

    if (get && path === '/admin/logs/groups') return ok({ groups: await d.logs.groups() });
    if (get && path === '/admin/logs') {
      const group = req.query.get('group') ?? '';
      const minutes = Number(req.query.get('minutes') ?? 60);
      const filter = (req.query.get('filter') ?? '').trim();
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > LOG_MINUTES_MAX) return no(400, 'minutes');
      if (filter.length > LOG_FILTER_MAX) return no(400, 'filter');
      // only a group that the functions of this deployment write to (the list is the one the page offers)
      if (!(await d.logs.groups()).some((g) => g.name === group)) return no(400, 'group');
      return ok({ events: await d.logs.events(group, d.now() - minutes * 60_000, filter, LOG_EVENTS_MAX) });
    }

    return no(404, 'not-found');
  };
}
