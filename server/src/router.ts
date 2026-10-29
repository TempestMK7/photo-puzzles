import type { CommandRequest, CreateRoomRequest, JoinRequest, ApiError } from '../../src/online/protocol';
import type { RoomService } from './service';
import { clientKey, type RateLimiter } from './ratelimit';
import type { Auth, Player } from './types';

/** One request, in the terms of any web server (a Node one now, API Gateway and Lambda later). */
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The `Authorization` header, if any. */
  authorization?: string;
  body: Uint8Array;
  /** The address the request came from, as the gateway saw it (for the limits on how often it may do things). */
  ip?: string;
  /** Already signed in (the cloud's gateway checks the token before the request gets here): no `Authorization` header is looked at then. */
  player?: Player;
}

export interface Res {
  status: number;
  /** Sent as JSON, unless it is bytes (a picture). */
  body: unknown;
  type?: string;
}

const STATUS: Record<ApiError, number> = {
  'update-required': 426,
  unauthorized: 403,
  'bad-request': 400,
  'not-found': 404,
  expired: 410,
  quota: 429,
  limit: 409,
  full: 409,
  'rate-limited': 429,
  'knock-pending': 202,
  'knock-denied': 403,
  'not-ready': 409,
  busy: 409,
  'not-holder': 409,
  'no-group': 409,
  ended: 409,
  'account-required': 403,
};

const MAX_JSON = 64 * 1024;

/** A development sign-in: `dev:<id>:<name>`. There is no password: this is for the machine it runs on. Real sign-in (Cognito) replaces it. */
export class DevAuth implements Auth {
  async verify(token: string): Promise<Player | null> {
    const m = /^dev:([a-z0-9_-]{3,40}):(.{1,80})$/i.exec(token);
    if (!m) return null;
    try {
      const name = decodeURIComponent(m[2]).trim().slice(0, 24);
      return name ? { id: m[1], name } : null;
    } catch {
      return null;
    }
  }
}

/** What the router needs to know about pictures: whether an address is one the service made. The local server also serves the pictures itself; the cloud's pictures come from S3. */
export interface MediaGate {
  allows(roomId: string, what: 'put' | 'get', exp: string | null, sig: string | null): Promise<boolean>;
  get?(roomId: string): { bytes: Uint8Array; type: string } | undefined;
}

/** Whoever asks for a guest token gets one: that is the whole point (a guest has no account). Asking again with a token that is still good gives a new one for the same guest. */
export interface GuestGate {
  issue(id?: string): Promise<{ token: string; id: string; expiresAt: number }>;
  verify(token: string): Promise<string | null>;
}

export function createRouter(d: { service: RoomService; auth: Auth; media: MediaGate; guests?: GuestGate; limiter?: RateLimiter }): (req: Req) => Promise<Res> {
  const { service, auth, media, guests, limiter } = d;
  const reply = (r: { ok: boolean; error?: ApiError }): Res => ({ status: r.ok ? 200 : STATUS[r.error!] ?? 400, body: r });
  const json = <T>(req: Req): T | null => {
    if (req.body.length > MAX_JSON) return null;
    try {
      return JSON.parse(new TextDecoder().decode(req.body)) as T;
    } catch {
      return null;
    }
  };
  const bad: Res = { status: 400, body: { ok: false, error: 'bad-request' } };
  const slow = (windowMs: number): Res => ({ status: 429, body: { ok: false, error: 'rate-limited', retryAt: limiter!.retryAt(windowMs) } });

  return async (req) => {
    const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent);

    // pictures: the address itself says who may (it is signed and runs out), so there is no sign-in
    if (parts[0] === 'media' && parts.length === 2) {
      const [, id] = parts;
      if (req.method === 'PUT') {
        if (!(await media.allows(id, 'put', req.query.get('exp'), req.query.get('sig')))) return { status: 403, body: { ok: false, error: 'unauthorized' } };
        return reply(await service.finishUpload(id, req.body));
      }
      if (req.method === 'GET') {
        if (!(await media.allows(id, 'get', req.query.get('exp'), req.query.get('sig')))) return { status: 403, body: { ok: false, error: 'unauthorized' } };
        const file = media.get?.(id);
        return file ? { status: 200, body: file.bytes, type: file.type } : { status: 404, body: { ok: false, error: 'not-found' } };
      }
      return { status: 405, body: { ok: false, error: 'bad-request' } };
    }

    // a guest token, for someone with no account (and, with a token that is still good, a fresh one for the same guest)
    if (parts[0] === 'guest' && parts.length === 1 && req.method === 'POST') {
      if (!guests) return { status: 404, body: { ok: false, error: 'not-found' } };
      const known = json<{ token?: unknown }>(req)?.token;
      const id = typeof known === 'string' ? await guests.verify(known) : null;
      // a new guest costs us nothing to make and nothing to the one who asks, so how many an address may make is limited (renewing one is not)
      if (!id && limiter && !(await limiter.take(`guest#${clientKey(req.ip)}`, limiter.rates.newGuests.perIp, limiter.rates.newGuests.windowMs))) return slow(limiter.rates.newGuests.windowMs);
      return { status: 200, body: { ok: true, ...(await guests.issue(id ?? undefined)) } };
    }

    const token = /^Bearer (.+)$/.exec(req.authorization ?? '')?.[1];
    const player = req.player ?? (token ? await auth.verify(token) : null);
    if (!player) return { status: 401, body: { ok: false, error: 'unauthorized' } };

    if (parts[0] === 'me' && parts[1] === 'delete' && parts.length === 2 && req.method === 'POST') return reply(await service.deleteAccount(player));
    if (parts[0] === 'me' && parts.length === 1) {
      if (req.method === 'GET') return reply(await service.profile(player));
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = json<{ name?: unknown }>(req);
        return body ? reply(await service.setProfile(player, body.name)) : bad;
      }
    }
    if (parts[0] === 'join' && req.method === 'POST') {
      const body = json<JoinRequest>(req);
      if (!body) return bad;
      if (!limiter) return reply(await service.join(player, body));
      // a code is five digits, so a script could try them all: tries that found nothing are counted, per address and per player, and when either has used up its share the next try is turned away
      const { perIp, perPlayer, windowMs } = limiter.rates.failedJoins;
      const ipKey = `join#${clientKey(req.ip)}`;
      const playerKey = `join#${player.id}`;
      if ((await limiter.spent(ipKey, perIp, windowMs)) || (await limiter.spent(playerKey, perPlayer, windowMs))) return slow(windowMs);
      const res = await service.join(player, body);
      if (!res.ok && (res.error === 'not-found' || res.error === 'bad-request')) await Promise.all([limiter.strike(ipKey, windowMs), limiter.strike(playerKey, windowMs)]);
      return reply(res);
    }
    if (parts[0] !== 'rooms') return { status: 404, body: { ok: false, error: 'not-found' } };
    if (parts.length === 1) {
      if (req.method === 'POST') {
        const body = json<CreateRoomRequest>(req);
        if (!body) return bad;
        if (limiter && !(await limiter.take(`create#${clientKey(req.ip)}`, limiter.rates.creations.perIp, limiter.rates.creations.windowMs))) return slow(limiter.rates.creations.windowMs);
        return reply(await service.createRoom(player, body));
      }
      if (req.method === 'GET') return reply(await service.listRooms(player));
    }
    const id = parts[1];
    if (parts.length === 2 && req.method === 'GET') return reply(await service.getRoom(player, id));
    if (req.method === 'POST' && parts.length >= 3) {
      switch (parts[2]) {
        case 'command': {
          const body = json<CommandRequest>(req);
          return body ? reply(await service.command(player, id, body)) : bad;
        }
        case 'renew':
          return reply(await service.renew(player, id));
        case 'leave':
          return reply(await service.leave(player, id));
        case 'close':
          return reply(await service.close(player, id));
        case 'invite':
          return reply(await service.regenerateInvite(player, id));
        case 'members':
          return parts[3] && parts[4] === 'remove' ? reply(await service.removeMember(player, id, parts[3])) : { status: 404, body: { ok: false, error: 'not-found' } };
        case 'knock': {
          const body = json<{ allow: boolean }>(req);
          return body && parts[3] ? reply(await service.answerKnock(player, id, parts[3], body.allow === true)) : bad;
        }
      }
    }
    return { status: 404, body: { ok: false, error: 'not-found' } };
  };
}
