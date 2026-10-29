/**
 * The little of MQTT 3.1.1 that the game needs to talk to the broker (AWS IoT Core) over a WebSocket: connect, subscribe, publish, ping, and reading what comes back. Everything is
 * at QoS 0: a message that is lost is noticed through the version numbers of the room's events (and the player asks for the whole room again), and a lost hand position does not matter.
 * It is about a hundred lines instead of a library of tens of kilobytes.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** No packet the game expects is anywhere near this: a longer one is a broken stream. */
const MAX_PACKET = 256 * 1024;

const text = (s: string): number[] => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};

/** The "remaining length" of a packet: seven bits at a time, the top bit says there is more. */
function length(n: number): number[] {
  const out: number[] = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 128;
    out.push(digit);
  } while (n > 0);
  return out;
}

function packet(first: number, body: ArrayLike<number>): Uint8Array {
  const head = [first, ...length(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** A new session (nothing kept from before), the given keep-alive in seconds. */
export const connect = (clientId: string, keepAliveSeconds: number): Uint8Array =>
  packet(0x10, [...text('MQTT'), 4, 0x02, keepAliveSeconds >> 8, keepAliveSeconds & 255, ...text(clientId)]);

export function subscribe(id: number, filters: string[]): Uint8Array {
  const body = [id >> 8, id & 255];
  for (const f of filters) body.push(...text(f), 0);                    // 0: at most once
  return packet(0x82, body);
}

export function publish(topic: string, payload: Uint8Array): Uint8Array {
  const head = text(topic);
  const body = new Uint8Array(head.length + payload.length);
  body.set(head);
  body.set(payload, head.length);
  return packet(0x30, body);
}

export const PING = new Uint8Array([0xc0, 0]);
export const DISCONNECT = new Uint8Array([0xe0, 0]);

export type Packet =
  | { kind: 'connack'; code: number }
  | { kind: 'suback'; id: number; codes: number[] }
  | { kind: 'publish'; topic: string; payload: Uint8Array }
  | { kind: 'pingresp' }
  | { kind: 'other'; type: number };

/** Turns the bytes that arrive (in pieces of any size, several packets in one piece, or one packet in several) into packets. Throws when the stream cannot be MQTT. */
export class Reader {
  private buf = new Uint8Array(0);

  push(bytes: Uint8Array): Packet[] {
    const joined = new Uint8Array(this.buf.length + bytes.length);
    joined.set(this.buf);
    joined.set(bytes, this.buf.length);
    this.buf = joined;
    const out: Packet[] = [];
    for (;;) {
      const got = this.next();
      if (!got) return out;
      out.push(got);
    }
  }

  private next(): Packet | null {
    const b = this.buf;
    if (b.length < 2) return null;
    let len = 0;
    let mult = 1;
    let i = 1;
    for (;;) {
      if (i > 4) throw new Error('not MQTT: the length of a packet has more than four bytes');
      if (i >= b.length) return null;                                    // the length itself is not all here yet
      const digit = b[i++];
      len += (digit & 127) * mult;
      mult *= 128;
      if (!(digit & 128)) break;
    }
    if (len > MAX_PACKET) throw new Error('not MQTT: a packet that is too long');
    if (b.length < i + len) return null;
    const first = b[0];
    const body = b.subarray(i, i + len);
    this.buf = b.slice(i + len);
    return decode(first, body);
  }
}

function decode(first: number, body: Uint8Array): Packet {
  const type = first >> 4;
  if (type === 2) return { kind: 'connack', code: body[1] ?? 255 };
  if (type === 9) return { kind: 'suback', id: ((body[0] ?? 0) << 8) | (body[1] ?? 0), codes: [...body.subarray(2)] };
  if (type === 13) return { kind: 'pingresp' };
  if (type === 3) {
    const qos = (first >> 1) & 3;
    const n = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
    const topic = dec.decode(body.subarray(2, 2 + n));
    return { kind: 'publish', topic, payload: body.slice(2 + n + (qos > 0 ? 2 : 0)) };      // at QoS 1 and 2 a packet number comes before the payload
  }
  return { kind: 'other', type };
}
