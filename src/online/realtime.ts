import type { HandMessage } from './protocol';

/** What a connection to a room tells the game. */
export interface RealtimeHandlers {
  /** The connection is up and the room's messages are coming (also after a lost connection came back). */
  onOpen(): void;
  /** The connection is down; it keeps trying to come back by itself. */
  onClose(): void;
  /** The server will not let this player listen to this room. */
  onRefused(): void;
  onMessage(topic: string, message: unknown): void;
}

export interface Connection {
  /** Says where the piece in hand is (to the other players, not to the server's rules). */
  publishHand(message: HandMessage): void;
  close(): void;
}

/** The live side of a room. The local server and the cloud each have their own way to do it; the game only sees this. */
export interface Realtime {
  connect(roomId: string, handlers: RealtimeHandlers): Connection;
}

/** The local server's way: one WebSocket that says which room it is in and then hears everything published for it. */
export class WsRealtime implements Realtime {
  constructor(
    private readonly base: string,
    private readonly token: () => Promise<string | null> | string | null,
  ) {}

  connect(roomId: string, handlers: RealtimeHandlers): Connection {
    let ws: WebSocket | null = null;
    let closed = false;
    let wait = 500;
    let timer = 0;
    const open = async (): Promise<void> => {
      const token = await this.token();
      if (closed) return;
      if (!token) {
        closed = true;
        handlers.onRefused();
        return;
      }
      const socket = new WebSocket(`${this.base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
      ws = socket;
      socket.onopen = () => socket.send(JSON.stringify({ t: 'sub', room: roomId }));
      socket.onmessage = (e) => {
        let m: { t?: string; topic?: string; msg?: unknown };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.t === 'subscribed') {
          wait = 500;
          handlers.onOpen();
        } else if (m.t === 'refused') {
          closed = true;
          socket.close();
          handlers.onRefused();
        } else if (typeof m.topic === 'string') handlers.onMessage(m.topic, m.msg);
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (closed) return;
        handlers.onClose();
        timer = window.setTimeout(() => void open(), wait);          // back off, but never for long: a friend is waiting
        wait = Math.min(8000, wait * 2);
      };
      socket.onerror = () => socket.close();
    };
    void open();
    return {
      publishHand: (message) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'hand', room: roomId, msg: message }));
      },
      close: () => {
        closed = true;
        window.clearTimeout(timer);
        ws?.close();
      },
    };
  }
}
