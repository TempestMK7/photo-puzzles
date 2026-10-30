import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_LIMITS, topics, type RoomMessage } from '../../src/online/protocol';
import { GuestTokens, TokenAuth } from './guest';
import { MemoryMedia, MemoryPubSub, MemoryStore, SystemRandom, systemClock } from './memory';
import { setActive } from './played';
import { createRouter, DevAuth } from './router';
import { RoomService } from './service';
import type { Player, Presence, PubSub } from './types';

/**
 * The online server on this machine: `npm run server`. The same RoomService the cloud will run, with memory for storage (everything is forgotten when it stops), an HTTP
 * door for the requests and a WebSocket in place of the cloud's publish/subscribe. For trying two browser tabs against each other; there is no real sign-in.
 */

const PORT = Number(process.env.PORT ?? 8787);
const WEB_BASE = process.env.WEB_BASE ?? 'http://localhost:5173';
const ORIGIN = `http://localhost:${PORT}`;
// a free player may make three a week; on this machine that would get in the way
const FREE_ROOMS = Number(process.env.FREE_ROOMS_PER_WEEK ?? 50);

/** Who is listening to which room. This stands in for the cloud's publish/subscribe: one message for a room goes to every connection in it. */
class Hub implements PubSub, Presence {
  private rooms = new Map<string, Map<WebSocket, Player>>();
  private pubsub = new MemoryPubSub();

  async publish(topic: string, message: unknown): Promise<void> {
    await this.pubsub.publish(topic, message);
    const room = /^puzzle\/([^/]+)\//.exec(topic)?.[1];
    if (room) this.send(room, topic, message);
  }

  online(roomId: string): string[] {
    return [...new Set([...(this.rooms.get(roomId)?.values() ?? [])].map((p) => p.id))];
  }

  join(room: string, ws: WebSocket, player: Player): boolean {
    const set = this.rooms.get(room) ?? new Map<WebSocket, Player>();
    this.rooms.set(room, set);
    const first = ![...set.values()].some((p) => p.id === player.id);
    set.set(ws, player);
    return first;
  }

  /** The connection is gone: true if it was the player's last one in a room (the room it was in is given back). */
  leave(ws: WebSocket): { room: string; player: Player; last: boolean }[] {
    const out: { room: string; player: Player; last: boolean }[] = [];
    for (const [room, set] of this.rooms) {
      const player = set.get(ws);
      if (!player) continue;
      set.delete(ws);
      out.push({ room, player, last: ![...set.values()].some((p) => p.id === player.id) });
      if (!set.size) this.rooms.delete(room);
    }
    return out;
  }

  isIn(room: string, ws: WebSocket): boolean {
    return !!this.rooms.get(room)?.has(ws);
  }

  /** Sends to everyone in the room, or to everyone but `except`. */
  send(room: string, topic: string, msg: unknown, except?: WebSocket): void {
    const text = JSON.stringify({ topic, msg });
    for (const ws of this.rooms.get(room)?.keys() ?? []) if (ws !== except && ws.readyState === ws.OPEN) ws.send(text);
  }
}

const hub = new Hub();
const store = new MemoryStore();
const media = new MemoryMedia(ORIGIN, new Uint8Array(randomBytes(32)), systemClock);
const service = new RoomService({
  store,
  media,
  pubsub: hub,
  presence: hub,
  clock: systemClock,
  random: new SystemRandom(),
  limits: { ...DEFAULT_LIMITS, freeRoomsPerWeek: FREE_ROOMS, pictureBytes: 8_000_000 },
  webBase: WEB_BASE,
});
// real guests as in the cloud (signed tokens, a key made when the server starts); the accounts are the made-up ones
const guests = new GuestTokens(new Uint8Array(randomBytes(32)), systemClock);
const auth = new TokenAuth(guests, new DevAuth());
const route = createRouter({ service, auth, media, guests });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size <= 10_000_000) chunks.push(c);
  });
  req.on('end', () => {
    void (async () => {
      const url = new URL(req.url ?? '/', ORIGIN);
      const out =
        size > 10_000_000
          ? { status: 413, body: { ok: false, error: 'bad-request' }, type: undefined }
          : await route({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, authorization: req.headers.authorization, body: new Uint8Array(Buffer.concat(chunks)) });
      if (out.body instanceof Uint8Array) res.writeHead(out.status, { ...CORS, 'Content-Type': out.type ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=60' }).end(Buffer.from(out.body));
      else res.writeHead(out.status, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(out.body));
    })().catch((e) => {
      console.error(e);
      res.writeHead(500, CORS).end(JSON.stringify({ ok: false, error: 'bad-request' }));
    });
  });
});

// the live side: a game connects, signs in, says which rooms it is in, and then hears each one's messages and may say where the piece in its hand is
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url ?? '', ORIGIN).searchParams.get('token') ?? '';
  const signedIn = auth.verify(token);
  ws.on('message', (data) => {
    void (async () => {
      const player = await signedIn;
      if (!player) return ws.close(4401);
      let m: { t?: string; room?: string; msg?: unknown };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof m.room !== 'string') return;
      if (m.t === 'sub') {
        if (!(await service.isMember(player, m.room))) return ws.send(JSON.stringify({ t: 'refused', room: m.room }));
        const nobody = hub.online(m.room).length === 0;
        const first = hub.join(m.room, ws, player);
        ws.send(JSON.stringify({ t: 'subscribed', room: m.room }));
        await setActive({ store, pubsub: hub, clock: systemClock }, m.room, true, nobody);          // the count of time played starts with the first one in
        if (first) await hub.publish(topics.events(m.room), { t: 'presence', id: player.id, online: true } satisfies RoomMessage);
      } else if (m.t === 'hand' && hub.isIn(m.room, ws)) {
        // a player may only speak on their own hand topic, like the cloud's policy will make sure
        hub.send(m.room, topics.hand(m.room, player.id), m.msg, ws);
      }
    })().catch((e) => console.error(e));
  });
  ws.on('close', () => {
    for (const { room, player, last } of hub.leave(ws)) {
      if (!last) continue;
      void (async () => {
        if (!hub.online(room).length) await setActive({ store, pubsub: hub, clock: systemClock }, room, false);
        await hub.publish(topics.events(room), { t: 'presence', id: player.id, online: false } satisfies RoomMessage);
      })().catch((e) => console.error(e));
    }
  });
});

setInterval(() => void service.sweep().catch((e) => console.error(e)), 60_000).unref();

server.listen(PORT, () => {
  console.log(`Online server on ${ORIGIN}  (the game is expected at ${WEB_BASE}; ${FREE_ROOMS} free puzzles a week)`);
  console.log('Nothing is kept: stopping the server forgets every room.');
});
