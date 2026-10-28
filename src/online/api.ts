import type {
  ApiFailure,
  CommandResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  Invite,
  JoinRequest,
  JoinResponse,
  RoomDescriptor,
  RoomSummary,
} from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import type { Command } from '../core/jigsawRoom';

/** The server could not be reached at all (no connection, or a site that refuses the page). */
export interface Offline {
  ok: false;
  error: 'offline';
}

export interface Identity {
  id: string;
  name: string;
  /** What goes in the `Authorization` header. */
  token: string;
}

/** The requests the game makes of the server. A class apart from the rest so that a test can put a fake in its place. */
export interface RoomApi {
  getRoom(id: string): Promise<{ ok: true; room: RoomDescriptor } | ApiFailure | Offline>;
  command(id: string, command: Command): Promise<CommandResponse | Offline>;
  renew(id: string): Promise<{ ok: true; until: number } | ApiFailure | Offline>;
}

export class OnlineApi implements RoomApi {
  constructor(
    private readonly base: string,
    private readonly identity: () => Identity | null,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | Offline> {
    const who = this.identity();
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...(who ? { Authorization: `Bearer ${who.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await res.json()) as T;
    } catch {
      return { ok: false, error: 'offline' };
    }
  }

  createRoom(req: Omit<CreateRoomRequest, 'protocol'>): Promise<CreateRoomResponse | ApiFailure | Offline> {
    return this.call('POST', '/rooms', { protocol: PROTOCOL_VERSION, ...req });
  }

  /** Sends the picture to the address the server gave. */
  async upload(url: string, picture: Blob): Promise<{ ok: true } | ApiFailure | Offline> {
    try {
      const res = await fetch(url, { method: 'PUT', body: picture });
      return (await res.json()) as { ok: true } | ApiFailure;
    } catch {
      return { ok: false, error: 'offline' };
    }
  }

  join(req: Omit<JoinRequest, 'protocol'>): Promise<JoinResponse | Offline> {
    return this.call('POST', '/join', { protocol: PROTOCOL_VERSION, ...req });
  }

  getRoom(id: string): Promise<{ ok: true; room: RoomDescriptor } | ApiFailure | Offline> {
    return this.call('GET', `/rooms/${encodeURIComponent(id)}`);
  }

  list(): Promise<{ ok: true; rooms: RoomSummary[] } | ApiFailure | Offline> {
    return this.call('GET', '/rooms');
  }

  command(id: string, command: Command): Promise<CommandResponse | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/command`, { protocol: PROTOCOL_VERSION, command });
  }

  renew(id: string): Promise<{ ok: true; until: number } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/renew`, {});
  }

  leave(id: string): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/leave`, {});
  }

  close(id: string): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/close`, {});
  }

  newInvite(id: string): Promise<{ ok: true; invite: Invite } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/invite`, {});
  }

  answerKnock(id: string, who: string, allow: boolean): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/knock/${encodeURIComponent(who)}`, { allow });
  }
}
