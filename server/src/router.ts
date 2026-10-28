import type { CommandRequest, CreateRoomRequest, JoinRequest, ApiError } from '../../src/online/protocol';
import type { MemoryMedia } from './memory';
import type { RoomService } from './service';
import type { Auth, Player } from './types';

/** One request, in the terms of any web server (a Node one now, API Gateway and Lambda later). */
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The `Authorization` header, if any. */
  authorization?: string;
  body: Uint8Array;
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

export function createRouter(d: { service: RoomService; auth: Auth; media: MemoryMedia }): (req: Req) => Promise<Res> {
  const { service, auth, media } = d;
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
        const file = media.get(id);
        return file ? { status: 200, body: file.bytes, type: file.type } : { status: 404, body: { ok: false, error: 'not-found' } };
      }
      return { status: 405, body: { ok: false, error: 'bad-request' } };
    }

    const token = /^Bearer (.+)$/.exec(req.authorization ?? '')?.[1];
    const player = token ? await auth.verify(token) : null;
    if (!player) return { status: 401, body: { ok: false, error: 'unauthorized' } };

    if (parts[0] === 'join' && req.method === 'POST') {
      const body = json<JoinRequest>(req);
      return body ? reply(await service.join(player, body)) : bad;
    }
    if (parts[0] !== 'rooms') return { status: 404, body: { ok: false, error: 'not-found' } };
    if (parts.length === 1) {
      if (req.method === 'POST') {
        const body = json<CreateRoomRequest>(req);
        return body ? reply(await service.createRoom(player, body)) : bad;
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
        case 'knock': {
          const body = json<{ allow: boolean }>(req);
          return body && parts[3] ? reply(await service.answerKnock(player, id, parts[3], body.allow === true)) : bad;
        }
      }
    }
    return { status: 404, body: { ok: false, error: 'not-found' } };
  };
}
