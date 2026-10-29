import { describe, expect, it } from 'vitest';
import { connect, DISCONNECT, PING, publish, Reader, subscribe } from '../src/online/mqtt';

const bytes = (...n: number[]) => new Uint8Array(n);
const ascii = (s: string) => [...new TextEncoder().encode(s)];

describe('what the game sends', () => {
  it('connects as a new session, with a keep-alive and a name', () => {
    expect([...connect('r:p:1', 30)]).toEqual([0x10, 17, 0, 4, ...ascii('MQTT'), 4, 2, 0, 30, 0, 5, ...ascii('r:p:1')]);
  });
  it('subscribes to topic filters at most once', () => {
    expect([...subscribe(1, ['a/b', 'a/+'])]).toEqual([0x82, 14, 0, 1, 0, 3, ...ascii('a/b'), 0, 0, 3, ...ascii('a/+'), 0]);
  });
  it('publishes at most once', () => {
    expect([...publish('t/x', bytes(1, 2, 3))]).toEqual([0x30, 8, 0, 3, ...ascii('t/x'), 1, 2, 3]);
  });
  it('pings and says goodbye', () => {
    expect([...PING]).toEqual([0xc0, 0]);
    expect([...DISCONNECT]).toEqual([0xe0, 0]);
  });
  it('writes the length of a long packet in as many bytes as it needs', () => {
    for (const [n, head] of [[127, [127]], [128, [128, 1]], [16383, [255, 127]], [16384, [128, 128, 1]]] as const) {
      const p = publish('t', new Uint8Array(n - 3));                      // 2 bytes of topic length and 1 of topic: the body is n bytes
      expect([...p.subarray(1, 1 + head.length)]).toEqual(head);
      expect(p.length).toBe(1 + head.length + n);
    }
  });
});

describe('what the game reads', () => {
  it('reads an answer to connecting, an answer to subscribing and a ping answer', () => {
    const r = new Reader();
    expect(r.push(bytes(0x20, 2, 0, 0))).toEqual([{ kind: 'connack', code: 0 }]);
    expect(r.push(bytes(0x20, 2, 0, 5))).toEqual([{ kind: 'connack', code: 5 }]);
    expect(r.push(bytes(0x90, 4, 0, 1, 0, 0x80))).toEqual([{ kind: 'suback', id: 1, codes: [0, 0x80] }]);
    expect(r.push(bytes(0xd0, 0))).toEqual([{ kind: 'pingresp' }]);
  });

  it('reads a message with its topic and its payload', () => {
    const [p] = new Reader().push(publish('puzzle/r/events', new TextEncoder().encode('{"t":"x"}')));
    expect(p.kind).toBe('publish');
    if (p.kind !== 'publish') return;
    expect(p.topic).toBe('puzzle/r/events');
    expect(new TextDecoder().decode(p.payload)).toBe('{"t":"x"}');
  });

  it('skips the packet number that comes before the payload at QoS 1', () => {
    const body = [0, 1, ...ascii('t'), 0, 7, 9, 9];
    const [p] = new Reader().push(bytes(0x32, body.length, ...body));
    expect(p.kind === 'publish' && [...p.payload]).toEqual([9, 9]);
  });

  it('puts together packets that come in pieces, and splits those that come together', () => {
    const one = publish('a/b', bytes(1, 2, 3, 4));
    const two = publish('a/c', bytes(5));
    const all = new Uint8Array([...one, ...two]);
    const r = new Reader();
    const got: string[] = [];
    for (let i = 0; i < all.length; i += 3) for (const p of r.push(all.subarray(i, i + 3))) got.push(p.kind === 'publish' ? p.topic : p.kind);
    expect(got).toEqual(['a/b', 'a/c']);
    expect(new Reader().push(all).map((p) => (p.kind === 'publish' ? p.topic : ''))).toEqual(['a/b', 'a/c']);
  });

  it('waits for the rest of a length that is cut in the middle', () => {
    const big = publish('t', new Uint8Array(300));
    const r = new Reader();
    expect(r.push(big.subarray(0, 2))).toEqual([]);                       // the first byte of a two-byte length
    expect(r.push(big.subarray(2, 5))).toEqual([]);
    expect(r.push(big.subarray(5))).toHaveLength(1);
  });

  it('gives up on a stream that cannot be MQTT', () => {
    expect(() => new Reader().push(bytes(0x30, 0x80, 0x80, 0x80, 0x80, 0x01))).toThrow(/length/);
    expect(() => new Reader().push(bytes(0x30, 0xff, 0xff, 0x7f))).toThrow(/too long/);
  });

  it('passes over packets it has no use for', () => {
    expect(new Reader().push(bytes(0x40, 2, 0, 1))).toEqual([{ kind: 'other', type: 4 }]);
  });
});
