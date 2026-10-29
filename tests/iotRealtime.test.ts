import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IotRealtime, type LiveAccount, type Membership, type SocketLike } from '../src/online/iotRealtime';
import { publish, Reader } from '../src/online/mqtt';
import { parseLiveClientId, topics } from '../src/online/protocol';
import type { RealtimeHandlers } from '../src/online/realtime';

class FakeSocket implements SocketLike {
  binaryType = '';
  sent: Uint8Array[] = [];
  isClosed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: Uint8Array): void {
    if (this.isClosed) throw new Error('closed');
    this.sent.push(data);
  }
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.onclose?.();
  }
  // the broker's side
  opened(): void {
    this.onopen?.();
  }
  receive(bytes: ArrayLike<number>): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
  accept(): void {
    this.receive([0x20, 2, 0, 0]);
  }
  granted(codes = [0, 0]): void {
    this.receive([0x90, 2 + codes.length, 0, 1, ...codes]);
  }
  say(topic: string, message: unknown): void {
    this.receive(publish(topic, new TextEncoder().encode(JSON.stringify(message))));
  }
  /** What the game sent, as packets (a CONNECT is told by its first byte). */
  packets() {
    return this.sent.map((b) => ({ type: b[0] >> 4, bytes: b }));
  }
  clientId(): string {
    const connect = this.sent.find((b) => b[0] === 0x10)!;
    const at = 2 + 6 + 4;                                                        // header, "MQTT", level, flags, keep-alive
    const n = (connect[at] << 8) | connect[at + 1];
    return new TextDecoder().decode(connect.subarray(at + 2, at + 2 + n));
  }
  filters(): string[] {
    const sub = this.sent.find((b) => b[0] === 0x82)!;
    const out: string[] = [];
    for (let i = 4; i < sub.length; ) {
      const n = (sub[i] << 8) | sub[i + 1];
      out.push(new TextDecoder().decode(sub.subarray(i + 2, i + 2 + n)));
      i += 2 + n + 1;
    }
    return out;
  }
}

const setup = (over: { token?: () => Promise<string | null>; who?: () => { id: string } | null; membership?: () => Promise<Membership> } = {}) => {
  const sockets: FakeSocket[] = [];
  let n = 0;
  const account: LiveAccount = { who: over.who ?? (() => ({ id: 'ann-1' })), token: over.token ?? (async () => `token-${++n}`) };
  const calls: string[] = [];
  const handlers: RealtimeHandlers = {
    onOpen: () => calls.push('open'),
    onClose: () => calls.push('close'),
    onRefused: () => calls.push('refused'),
    onMessage: (topic, message) => calls.push(`message ${topic} ${JSON.stringify(message)}`),
  };
  const membership = vi.fn(over.membership ?? (async () => 'unknown' as Membership));
  const realtime = new IotRealtime({ endpoint: 'iot.example.com', authorizer: 'auth-dev' }, account, membership, (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  });
  return { realtime, sockets, calls, handlers, membership };
};
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Opens a connection all the way to "subscribed". */
async function up(t: ReturnType<typeof setup>, room = 'room1') {
  const conn = t.realtime.connect(room, t.handlers);
  await tick();
  const s = t.sockets[t.sockets.length - 1];
  s.opened();
  s.accept();
  s.granted();
  return { conn, s };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connecting', () => {
  it('goes to the broker with the token, the room and the authorizer in the address, under its own name', async () => {
    const t = setup();
    t.realtime.connect('room1', t.handlers);
    await tick();
    const s = t.sockets[0];
    const url = new URL(s.url);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('iot.example.com');
    expect(url.pathname).toBe('/mqtt');
    expect(url.searchParams.get('x-amz-customauthorizer-name')).toBe('auth-dev');
    expect(url.searchParams.get('token')).toBe('token-1');
    expect(url.searchParams.get('room')).toBe('room1');
    expect(s.binaryType).toBe('arraybuffer');
    s.opened();
    expect(parseLiveClientId(s.clientId())).toMatchObject({ room: 'room1', player: 'ann-1' });
  });

  it('subscribes to the room\'s events and to everyone\'s hand, and says it is open only when that is done', async () => {
    const t = setup();
    t.realtime.connect('room1', t.handlers);
    await tick();
    const s = t.sockets[0];
    s.opened();
    s.accept();
    expect(s.filters()).toEqual([topics.events('room1'), topics.hands('room1')]);
    expect(t.calls).toEqual([]);
    s.granted();
    expect(t.calls).toEqual(['open']);
  });

  it('hands over what it hears, with the topic', async () => {
    const t = setup();
    const { s } = await up(t);
    s.say(topics.events('room1'), { t: 'presence', id: 'bob', online: true });
    s.say(topics.hand('room1', 'bob'), { piece: 3, n: 1 });
    expect(t.calls.slice(1)).toEqual([`message puzzle/room1/events {"t":"presence","id":"bob","online":true}`, `message puzzle/room1/hand/bob {"piece":3,"n":1}`]);
  });

  it('ignores a message that is not JSON, and takes packets that come in pieces', async () => {
    const t = setup();
    const { s } = await up(t);
    s.receive(publish('puzzle/room1/events', new TextEncoder().encode('not json')));
    const whole = publish('puzzle/room1/events', new TextEncoder().encode('{"a":1}'));
    s.receive(whole.subarray(0, 4));
    s.receive(whole.subarray(4));
    expect(t.calls).toEqual(['open', 'message puzzle/room1/events {"a":1}']);
  });
});

describe('saying where the piece in hand is', () => {
  it('publishes on the player\'s own hand topic, once connected', async () => {
    const t = setup();
    const conn = t.realtime.connect('room1', t.handlers);
    await tick();
    const s = t.sockets[0];
    conn.publishHand({ piece: 1, n: 1 } as never);                              // not connected yet: dropped
    s.opened();
    s.accept();
    s.granted();
    conn.publishHand({ piece: 2, n: 2 } as never);
    const sent = new Reader().push(s.sent[s.sent.length - 1]);
    expect(sent).toHaveLength(1);
    const p = sent[0];
    expect(p.kind === 'publish' && p.topic).toBe(topics.hand('room1', 'ann-1'));
    expect(p.kind === 'publish' && JSON.parse(new TextDecoder().decode(p.payload))).toEqual({ piece: 2, n: 2 });
    expect(s.packets().filter((x) => x.type === 3)).toHaveLength(1);
  });
});

describe('losing the connection', () => {
  it('says so, and connects again with a fresh token, after a wait that grows', async () => {
    const t = setup();
    const { s } = await up(t);
    s.close();
    expect(t.calls).toEqual(['open', 'close']);
    await tick(499);
    expect(t.sockets).toHaveLength(1);
    await tick(1);
    expect(t.sockets).toHaveLength(2);
    expect(new URL(t.sockets[1].url).searchParams.get('token')).toBe('token-2');
    t.sockets[1].close();                                                       // fails before it is up: the wait doubles
    await tick(999);
    expect(t.sockets).toHaveLength(2);
    await tick(1);
    expect(t.sockets).toHaveLength(3);
    t.sockets[2].opened();
    t.sockets[2].accept();
    t.sockets[2].granted();
    expect(t.calls.filter((c) => c === 'open')).toHaveLength(2);
  });

  it('never waits more than a few seconds', async () => {
    const t = setup();
    t.realtime.connect('room1', t.handlers);
    await tick();
    for (let i = 0; i < 8; i++) {
      t.sockets[t.sockets.length - 1].close();
      await tick(8000);
    }
    const before = t.sockets.length;
    t.sockets[before - 1].close();
    await tick(8000);
    expect(t.sockets).toHaveLength(before + 1);
  });

  it('takes a connection that says nothing for too long to be gone, and pings while it is quiet', async () => {
    const t = setup();
    const { s } = await up(t);
    await tick(15_000);
    expect(s.packets().filter((x) => x.type === 12)).toHaveLength(1);           // PINGREQ
    s.receive([0xd0, 0]);
    await tick(15_000);
    await tick(15_000);
    await tick(15_000);                                                         // 45 s of nothing since the answer
    expect(s.isClosed).toBe(true);
    expect(t.calls).toContain('close');
  });

  it('gives up on a connect that is never answered', async () => {
    const t = setup();
    t.realtime.connect('room1', t.handlers);
    await tick();
    t.sockets[0].opened();
    await tick(10_000);
    expect(t.sockets[0].isClosed).toBe(true);
  });

  it('treats a refused subscription like a lost connection', async () => {
    const t = setup();
    t.realtime.connect('room1', t.handlers);
    await tick();
    const s = t.sockets[0];
    s.opened();
    s.accept();
    s.granted([0, 0x80]);
    expect(s.isClosed).toBe(true);
    expect(t.calls).toEqual(['close']);
  });

  it('closes on a refusal to connect', async () => {
    const t = setup();
    t.realtime.connect('room1', t.handlers);
    await tick();
    t.sockets[0].opened();
    t.sockets[0].receive([0x20, 2, 0, 5]);
    expect(t.sockets[0].isClosed).toBe(true);
  });
});

describe('being turned away', () => {
  it('asks the API after two failures in a row, and says "refused" if the player is not in the room', async () => {
    const t = setup({ membership: async () => 'not-member' });
    t.realtime.connect('room1', t.handlers);
    await tick();
    t.sockets[0].close();                                                       // the broker drops it, like a lost network
    await tick(500);
    expect(t.calls).toEqual(['close']);
    expect(t.membership).not.toHaveBeenCalled();
    t.sockets[1].close();
    await tick(0);
    expect(t.membership).toHaveBeenCalledWith('room1');
    expect(t.calls).toEqual(['close', 'close', 'refused']);
    await tick(20_000);
    expect(t.sockets).toHaveLength(2);                                          // and it stops trying
  });

  it('keeps trying when the API cannot say, or says the player is in the room', async () => {
    for (const answer of ['unknown', 'member'] as const) {
      const t = setup({ membership: async () => answer });
      t.realtime.connect('room1', t.handlers);
      await tick();
      for (let i = 0; i < 4; i++) {
        t.sockets[t.sockets.length - 1].close();
        await tick(8000);
      }
      expect(t.calls).not.toContain('refused');
      expect(t.sockets.length).toBeGreaterThan(4);
    }
  });

  it('is refused at once when nobody is signed in', async () => {
    const t = setup({ token: async () => null });
    t.realtime.connect('room1', t.handlers);
    await tick();
    expect(t.calls).toEqual(['refused']);
    expect(t.sockets).toHaveLength(0);
  });
});

describe('closing', () => {
  it('says goodbye, and does not come back', async () => {
    const t = setup();
    const { conn, s } = await up(t);
    conn.close();
    expect(s.packets().some((x) => x.type === 14)).toBe(true);                  // DISCONNECT
    expect(s.isClosed).toBe(true);
    await tick(60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.calls).toEqual(['open']);                                          // nothing is said about a connection that was closed on purpose
  });

  it('does not open at all if it is closed while the token is still being fetched', async () => {
    let release!: (t: string) => void;
    const t = setup({ token: () => new Promise((r) => (release = r)) });
    const conn = t.realtime.connect('room1', t.handlers);
    conn.close();
    release('late');
    await tick();
    expect(t.sockets).toHaveLength(0);
  });
});
