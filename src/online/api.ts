import type {
  ApiError,
  ApiFailure,
  CommandResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  Invite,
  JoinRequest,
  JoinResponse,
  MeResponse,
  PlaybackRequest,
  ReportRequest,
  RoomDescriptor,
  RoomSummary,
} from './protocol';
import { PROTOCOL_VERSION } from './protocol';
import type { Command } from '../core/jigsawRoom';

/** The server could not be reached at all (no connection, or a site that refuses the page), or it does not know who is asking any more (`sign-in`: the sign-in has run out). */
export interface Offline {
  ok: false;
  error: 'offline' | 'sign-in';
}

/** Every way a request can come back refused or not at all. */
export type CallError = ApiError | Offline['error'];

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
  /** The host says where the video is (a puzzle made from a video). */
  setPlayback?(id: string, req: PlaybackRequest): Promise<{ ok: true } | ApiFailure | Offline>;
}

export class OnlineApi implements RoomApi {
  constructor(
    private readonly base: string,
    /** What to send as the token: nothing when nobody is signed in. */
    private readonly token: () => Promise<string | null> | string | null,
    /** Called when the server does not know the token any more (a guest's, whose key changed, say). */
    private readonly signInLost?: () => void,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | Offline> {
    try {
      const token = await this.token();
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // the gateway says 401 (with a body of its own) when the token is not good: the player has to sign in again
      if (res.status === 401) {
        this.signInLost?.();
        return { ok: false, error: 'sign-in' };
      }
      return (await res.json()) as T;
    } catch {
      return { ok: false, error: 'offline' };
    }
  }

  /** What the server knows about the player: the name they chose, if they have. */
  me(): Promise<MeResponse | ApiFailure | Offline> {
    return this.call('GET', '/me');
  }

  setName(name: string): Promise<MeResponse | ApiFailure | Offline> {
    return this.call('PUT', '/me', { name });
  }

  /** Ends the puzzles the player made, takes them out of the others, and deletes their name and their account. */
  deleteAccount(): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', '/me/delete', {});
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

  /**
   * Sends the video straight to storage, at the address the server gave and with the headers it said (the address is signed for exactly this file). Calls `progress` with how much has
   * gone (0 to 1) now and then. A request object is used because `fetch` cannot say how far an upload has got.
   */
  uploadVideo(url: string, headers: Record<string, string>, video: Blob, progress: (fraction: number) => void): Promise<{ ok: true } | ApiFailure | Offline> {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
      x.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total);
      x.onerror = () => resolve({ ok: false, error: 'offline' });
      x.onload = () => resolve(x.status >= 200 && x.status < 300 ? { ok: true } : { ok: false, error: x.status === 403 ? 'unauthorized' : 'bad-request' });
      x.send(video);
    });
  }

  /** The video is up: a few of its pictures (JPEGs, base64) for the server to look at, and then the puzzle can be joined. */
  finishVideo(id: string, frames: string[]): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/video`, { frames });
  }

  setPlayback(id: string, req: PlaybackRequest): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/playback`, req);
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

  /** Tells the operator that the puzzle is a problem. */
  report(id: string, req: ReportRequest): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/report`, req);
  }

  /** The owner sends a player out of the puzzle. */
  removeMember(id: string, who: string): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(who)}/remove`, {});
  }

  answerKnock(id: string, who: string, allow: boolean): Promise<{ ok: true } | ApiFailure | Offline> {
    return this.call('POST', `/rooms/${encodeURIComponent(id)}/knock/${encodeURIComponent(who)}`, { allow });
  }
}
