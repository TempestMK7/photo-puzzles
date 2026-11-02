import type { AdRequest, AdStartRequest, AwardRequest, RewardRequest, CommandRequest, CreateRoomRequest, ItemRequest, JoinRequest, ApiError, PlaybackRequest, ReportRequest } from '../../src/online/protocol';
import type { RoomService } from './service';
import { clientKey, type RateLimiter } from './ratelimit';
import { stockSitesOf, type StockProviders } from './stock';
import type { Auth, Player } from './types';

/** One request, in the terms of any web server (a Node one now, API Gateway and Lambda later). */
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The `Authorization` header, if any. */
  authorization?: string;
  body: Uint8Array;
  /** The query string exactly as it came (not taken apart: the ad network signs its text). */
  rawQuery?: string;
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
  'no-credits': 402,
  'plan-required': 403,
  'ad-refused': 409,
  'ads-off': 503,
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
  banned: 403,
  removed: 403,
  rejected: 422,
  paused: 503,
  'too-big': 413,
  unreadable: 422,
  'stock-off': 503,
  'file-gone': 410,
  'helpers-off': 403,
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

export function createRouter(d: { service: RoomService; auth: Auth; media: MediaGate; guests?: GuestGate; limiter?: RateLimiter; stock?: StockProviders }): (req: Req) => Promise<Res> {
  const { service, auth, media, guests, limiter, stock } = d;
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
    // the local server is sent a video itself; the cloud's creator sends it to the storage (`Media.videoUpload`)
    if (parts[0] === 'media' && parts.length === 3 && parts[2] === 'video' && req.method === 'PUT') {
      if (!(await media.allows(parts[1], 'put', req.query.get('exp'), req.query.get('sig')))) return { status: 403, body: { ok: false, error: 'unauthorized' } };
      return reply(await service.storeVideo(parts[1], req.body));
    }
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

    // the ad network tells the server that a rewarded ad was watched (signed by the network: there is no sign-in)
    if (parts[0] === 'credits' && parts[1] === 'ad' && parts[2] === 'callback' && parts.length === 3 && req.method === 'GET') {
      return (await service.adCallback(req.rawQuery ?? '')) ? { status: 200, body: { ok: true } } : { status: 403, body: { ok: false, error: 'unauthorized' } };
    }

    // the library of stock pictures and videos: open to everyone (the game's single-player side has no sign-in), so how often an address may ask is limited, and the provider's own limit is shared by all
    if (parts[0] === 'stock' && parts[1] === 'search' && parts.length === 2 && req.method === 'GET') {
      const sites = stock ? stockSitesOf(stock) : [];
      if (!stock || !sites.length) return { status: 503, body: { ok: false, error: 'stock-off' } };
      if (limiter && !(await limiter.take(`stock#${clientKey(req.ip)}`, limiter.rates.stockSearch.perIp, limiter.rates.stockSearch.windowMs))) return slow(limiter.rates.stockSearch.windowMs);
      const site = sites.find((s) => s === req.query.get('source')) ?? sites[0];        // (one that is not here is not an error: the first one that is is used)
      const up = limiter?.rates.stockUpstream[site];
      const found = await stock[site]!.search(req.query.get('q') ?? '', req.query.get('type') === 'video' ? 'video' : 'photo', Number(req.query.get('page') ?? 1), up ? () => limiter!.take(`stock#upstream#${site}`, up.total, up.windowMs) : undefined);
      if (found === 'busy') return slow(up!.windowMs);
      return found ? { status: 200, body: { ...found, source: site, sources: sites } } : { status: 503, body: { ok: false, error: 'stock-off' } };
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
    // a player whom the operator has stopped can still see and delete what is theirs (above), and nothing else
    if (await service.isBanned(player.id)) return { status: 403, body: { ok: false, error: 'banned' } };
    // a rewarded ad that was watched in a mobile app: credits for it, if the account is owed them (the account decides: see `claimAd`)
    if (parts[0] === 'credits' && parts[1] === 'ad' && parts[2] === 'start' && parts.length === 3 && req.method === 'POST') {
      const body = json<AdStartRequest>(req);
      return body ? reply(await service.adStart(player, body)) : bad;
    }
    // hints and bombs: one is taken before a puzzle played alone places anything, and the hints of a puzzle played alone are added when it is solved
    if (parts[0] === 'items' && parts[1] === 'use' && parts.length === 2 && req.method === 'POST') {
      const body = json<ItemRequest>(req);
      return body ? reply(await service.useItem(player, body)) : bad;
    }
    if (parts[0] === 'items' && parts[1] === 'reward' && parts.length === 2 && req.method === 'POST') {
      const body = json<RewardRequest>(req);
      return body ? reply(await service.rewardHelp(player, body)) : bad;
    }
    if (parts[0] === 'items' && parts[1] === 'award' && parts.length === 2 && req.method === 'POST') {
      const body = json<AwardRequest>(req);
      return body ? reply(await service.awardSolved(player, body)) : bad;
    }
    if (parts[0] === 'credits' && parts[1] === 'ad' && parts.length === 2 && req.method === 'POST') {
      const body = json<AdRequest>(req);
      return body ? reply(await service.claimAd(player, body)) : bad;
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
        case 'video':
          // the video is up: start the check (once) and say how it is going; the game asks again every few seconds
          if (limiter && !(await limiter.take(`videocheck#${player.id}`, limiter.rates.videoCheck.perPlayer, limiter.rates.videoCheck.windowMs))) return slow(limiter.rates.videoCheck.windowMs);
          return reply(await service.checkVideo(player, id));
        case 'playback': {
          const body = json<PlaybackRequest>(req);
          if (!body) return bad;
          // the host's game says it when something changes, and now and then: not faster than that
          if (limiter && !(await limiter.take(`playback#${player.id}`, limiter.rates.playback.perPlayer, limiter.rates.playback.windowMs))) return slow(limiter.rates.playback.windowMs);
          return reply(await service.setPlayback(player, id, body));
        }
        case 'renew':
          return reply(await service.renew(player, id));
        case 'leave':
          return reply(await service.leave(player, id));
        case 'close':
          return reply(await service.close(player, id));
        case 'report': {
          const body = json<ReportRequest>(req);
          if (!body) return bad;
          // a report costs the operator time: one player may send a few an hour
          if (limiter && !(await limiter.take(`report#${player.id}`, limiter.rates.reports.perPlayer, limiter.rates.reports.windowMs))) return slow(limiter.rates.reports.windowMs);
          return reply(await service.report(player, id, body));
        }
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
