import { connect, DISCONNECT, PING, publish, Reader, subscribe } from './mqtt';
import { liveClientId, topics } from './protocol';
import type { Connection, Realtime, RealtimeHandlers } from './realtime';

/** Where the broker is, and the name of the authorizer that checks who may connect (`infra/lib/live-stack.ts`). */
export interface LiveConfig {
  endpoint: string;
  authorizer: string;
}

/** What the connection needs to know about the player. */
export interface LiveAccount {
  who(): { id: string } | null;
  token(): Promise<string | null>;
}

/** Whether the player is in the room, as the API says (the broker only closes the connection, which looks like any other failure). */
export type Membership = 'member' | 'not-member' | 'unknown';

/** The part of a WebSocket that is used, so that a test can put a fake in its place. */
export interface SocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  // the events are not looked into, so a WebSocket (whose handlers take one) fits as well as a test's fake (whose do not)
  onopen: ((e: any) => void) | null;
  onmessage: ((e: any) => void) | null;
  onclose: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
}

const KEEP_ALIVE_S = 30;
/** A ping this often keeps the connection from looking idle to phones and routers; if nothing at all is heard for `SILENT_MS` the connection is taken to be gone. */
const PING_MS = 15_000;
const SILENT_MS = 45_000;
/** From opening a socket to being subscribed. */
const SETUP_MS = 10_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const bytesOf = (data: unknown): Uint8Array | null => (data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null);

const randomPart = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

/**
 * The cloud's way to the live side of a room: MQTT over a WebSocket to AWS IoT Core. The player's token and the room go in the address, and the broker's authorizer lets in only a member of
 * the room, under a name that starts with the room and the player's id (see `liveClientId`). Once it is in, it is subscribed to the room's events and to everyone's hand, and may publish
 * only its own. A connection that is lost is opened again by itself, with a fresh token, after a wait that grows to a few seconds.
 */
export class IotRealtime implements Realtime {
  constructor(
    private readonly config: LiveConfig,
    private readonly account: LiveAccount,
    private readonly membership: (roomId: string) => Promise<Membership>,
    private readonly socket: (url: string) => SocketLike = (url) => new WebSocket(url, 'mqtt'),
  ) {}

  connect(roomId: string, handlers: RealtimeHandlers): Connection {
    let closed = false;
    let session = 0;
    let wait = 500;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ws: SocketLike | null = null;
    let up = false;
    let me = '';
    let stop: () => void = () => undefined;

    const lost = (reached: boolean): void => {
      if (reached) failures = 0;
      else failures++;
      handlers.onClose();
      void (async () => {
        // The broker closes the connection of a player who is not in the room, which looks like a lost network. After a few tries in a row, the API is asked which of the two it is.
        if (failures === 2 || (failures > 2 && failures % 5 === 0)) {
          if ((await this.membership(roomId)) === 'not-member' && !closed) {
            closed = true;
            handlers.onRefused();
            return;
          }
        }
        if (closed) return;
        retry = setTimeout(() => void open(), wait);
        wait = Math.min(8000, wait * 2);                                         // back off, but never for long: a friend is waiting
      })();
    };

    const open = async (): Promise<void> => {
      const mine = ++session;
      const token = await this.account.token();
      const who = this.account.who();
      if (closed || mine !== session) return;
      if (!token || !who) {
        closed = true;
        handlers.onRefused();
        return;
      }
      me = who.id;
      const url = `wss://${this.config.endpoint}/mqtt?x-amz-customauthorizer-name=${encodeURIComponent(this.config.authorizer)}&token=${encodeURIComponent(token)}&room=${encodeURIComponent(roomId)}`;
      const socket = this.socket(url);
      socket.binaryType = 'arraybuffer';
      ws = socket;
      up = false;
      const reader = new Reader();
      let stage: 'connecting' | 'subscribing' | 'up' = 'connecting';
      let heard = Date.now();
      let pinger: ReturnType<typeof setInterval> | undefined;
      let setup: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        clearInterval(pinger);
        clearTimeout(setup);
      };
      stop = () => {
        cleanup();
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        try {
          socket.send(DISCONNECT);
        } catch {
          /* already gone */
        }
        socket.close();
      };
      const give = (): void => {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      };
      setup = setTimeout(give, SETUP_MS);
      socket.onopen = () => socket.send(connect(liveClientId(roomId, who.id, randomPart()), KEEP_ALIVE_S));
      socket.onerror = give;
      socket.onclose = () => {
        cleanup();
        if (ws === socket) ws = null;
        const reached = stage === 'up';
        up = false;
        if (!closed && mine === session) lost(reached);
      };
      socket.onmessage = (e) => {
        const data = bytesOf(e.data);
        if (!data) return;
        heard = Date.now();
        let packets;
        try {
          packets = reader.push(data);
        } catch {
          give();
          return;
        }
        for (const p of packets) {
          if (p.kind === 'connack') {
            if (p.code !== 0) return give();
            stage = 'subscribing';
            socket.send(subscribe(1, [topics.events(roomId), topics.hands(roomId)]));
          } else if (p.kind === 'suback') {
            if (p.codes.length === 0 || p.codes.some((c) => c >= 0x80)) return give();
            stage = 'up';
            up = true;
            wait = 500;
            failures = 0;
            clearTimeout(setup);
            pinger = setInterval(() => {
              if (Date.now() - heard >= SILENT_MS) give();
              else socket.send(PING);
            }, PING_MS);
            handlers.onOpen();
          } else if (p.kind === 'publish') {
            let message: unknown;
            try {
              message = JSON.parse(dec.decode(p.payload));
            } catch {
              continue;                                                          // not ours: nothing to say about it
            }
            handlers.onMessage(p.topic, message);
          }
        }
      };
    };
    void open();

    return {
      publishHand: (message) => {
        if (ws && up) ws.send(publish(topics.hand(roomId, me), enc.encode(JSON.stringify(message))));
      },
      close: () => {
        closed = true;
        session++;
        clearTimeout(retry);
        up = false;
        stop();
        ws = null;
      },
    };
  }
}
