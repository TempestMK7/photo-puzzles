import type { APIGatewayProxyEventV2WithJWTAuthorizer, DynamoDBStreamEvent } from 'aws-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import type { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { describe, expect, it, vi } from 'vitest';
import { JigsawRoom } from '../src/core/jigsawRoom';
import { PROTOCOL_VERSION } from '../src/online/protocol';
import { makeHandler, playerFrom, toReq, toResult } from '../server/src/aws/api';
import { clearPictures } from '../server/src/aws/cleanup';
import { DynamoPresence, DynamoStore } from '../server/src/aws/dynamo';
import { IotPubSub } from '../server/src/aws/iot';
import { mediaKey, S3Media } from '../server/src/aws/s3media';
import { createRouter } from '../server/src/router';
import { Signer } from '../server/src/signing';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, jpeg, open, request, world } from './helpers/world';

const dynamoWorld = (extra = {}) => {
  const db = new FakeDynamo();
  return { db, w: world(extra, (clock) => new DynamoStore(db, 'table', clock)) };
};

describe('DynamoStore', () => {
  it('writes a move as one conditional write, and only touches the codes and memberships when they change or are about to run out', async () => {
    const { db, w } = dynamoWorld();
    const made = await open(w);
    const [a] = [...new JigsawRoom((await w.store.getRoom(made.roomId))!.settings).board.game.groups.values()].filter((x) => !x.anchored);
    db.calls.length = 0;
    w.clock.t += 60_000;
    expect((await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'grab', piece: a.members[0] } })).ok).toBe(true);
    expect(db.calls.filter((c) => c === 'TransactWriteCommand')).toEqual([]);
    expect(db.calls.filter((c) => c === 'PutCommand')).toHaveLength(1);
    // a day on, the room's time has moved beyond what the code and the memberships were given: they are written again
    w.clock.t += DAY - 1000;
    db.calls.length = 0;
    await w.service.renew(ann, made.roomId);
    w.clock.t += DAY - 1000;
    await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'release' } });
    expect(db.calls).toContain('TransactWriteCommand');
  });

  it('keeps a whole 1,000-piece room in one item (400 KB at most)', async () => {
    const { db, w } = dynamoWorld();
    const made = await open(w, ann, request({ pieces: 1000 }));
    const item = db.items.get(`ROOM#${made.roomId}\u0000META`)!;
    expect(JSON.stringify(item).length).toBeLessThan(400 * 1024);
    expect(JSON.stringify(item).length).toBeGreaterThan(30_000);
    expect(item.ttl).toBe(Math.ceil((w.clock.t + DAY) / 1000));
  });

  it('refuses to write a room that someone else wrote in between, and writes nothing', async () => {
    const { db, w } = dynamoWorld();
    const made = await open(w);
    const first = (await w.store.getRoom(made.roomId))!;
    const stale = structuredClone(first);
    first.rev += 1;
    expect(await w.store.putRoom(first)).toBe(true);
    stale.rev += 1;
    stale.knocks = [{ id: 'x', name: 'X', status: 'pending' }];
    expect(await w.store.putRoom(stale)).toBe(false);
    expect((await w.store.getRoom(made.roomId))!.knocks).toEqual([]);
    expect(db.items.size).toBeGreaterThan(0);
  });

  it('knows a member from the list of the rooms of a player, and forgets one who left', async () => {
    const { db, w } = dynamoWorld();
    const made = await open(w);
    await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
    expect(await w.store.roomsOf('bob')).toEqual([made.roomId]);
    await w.service.leave(bob, made.roomId);
    expect(await w.store.roomsOf('bob')).toEqual([]);
    expect([...db.items.keys()].some((k) => k.startsWith('PLAYER#bob\u0000ROOM#'))).toBe(false);
  });

  it('does not count a room whose time has passed as one of the player\'s (its membership is still there for hours)', async () => {
    const { w } = dynamoWorld({ freeRoomsPerWeek: 50 });
    await open(w);
    expect(await w.store.roomsOf('ann')).toHaveLength(1);
    w.clock.t += DAY + 1000;
    expect(await w.store.roomsOf('ann')).toEqual([]);
    for (let i = 0; i < 5; i++) expect((await w.service.createRoom(ann, request())).ok).toBe(true);        // a stale one does not use up a place
  });

  it('claims a code once, and gives back one whose time has passed', async () => {
    const { w } = dynamoWorld();
    expect(await w.store.claimCode('12345', 'a')).toBe(true);
    expect(await w.store.claimCode('12345', 'b')).toBe(false);
    expect(await w.store.roomOfCode('12345')).toBe('a');
    w.clock.t += 2 * 3600 * 1000;                                          // a claim for a room that was never made runs out
    expect(await w.store.claimCode('12345', 'b')).toBe(true);
    await w.store.releaseCode('12345');
    expect(await w.store.roomOfCode('12345')).toBeUndefined();
  });

  it('counts the puzzles made in the week for the quota', async () => {
    const { w } = dynamoWorld();
    for (const t of [10_000, 20_000, 20_000, 900_000]) await w.store.addCreation('ann', t);
    await w.store.addCreation('bob', 30_000);
    expect((await w.store.creationsSince('ann', 15_000)).sort()).toEqual([20_000, 20_000, 900_000]);
    expect(await w.store.creationsSince('ann', 900_000)).toEqual([]);
  });

  it('lists every room in a scan', async () => {
    const { w } = dynamoWorld({ freeRoomsPerWeek: 50 });
    for (let i = 0; i < 4; i++) await open(w);
    expect(await w.store.allRooms()).toHaveLength(4);
  });
});

describe('DynamoPresence', () => {
  it('lists who is connected, and forgets those who left or whose entry ran out', async () => {
    const clock = { t: 5_000_000, now() { return this.t; } };
    const p = new DynamoPresence(new FakeDynamo(), 'table', clock);
    await p.set('room', 'ann', true);
    await p.set('room', 'bob', true);
    await p.set('other', 'cy', true);
    expect((await p.online('room')).sort()).toEqual(['ann', 'bob']);
    await p.set('room', 'ann', false);
    expect(await p.online('room')).toEqual(['bob']);
    clock.t += DynamoPresence.KEEP_MS + 2000;
    expect(await p.online('room')).toEqual([]);
  });
});

describe('S3Media', () => {
  const clock = { t: 1_000_000, now() { return this.t; } };
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const s3 = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => void sent.push({ name: c.constructor.name, input: c.input }) } as unknown as S3Client;
  const signer = new Signer(new Uint8Array(32).fill(1), clock);
  const media = new S3Media(s3, 'bucket', signer, 'https://api.test');

  it('sends the creator\'s picture to the API, with an address that is good for a put and only that', async () => {
    const url = new URL(await media.uploadUrl('room1'));
    expect(url.origin + url.pathname).toBe('https://api.test/media/room1');
    const [exp, sig] = [url.searchParams.get('exp'), url.searchParams.get('sig')];
    expect(await media.allows('room1', 'put', exp, sig)).toBe(true);
    expect(await media.allows('room1', 'get', exp, sig)).toBe(false);
    expect(await media.allows('room2', 'put', exp, sig)).toBe(false);
    clock.t += 11 * 60 * 1000;
    expect(await media.allows('room1', 'put', exp, sig)).toBe(false);
  });

  it('gives members a signed address of the object in S3 that runs out', async () => {
    const real = new S3Media(new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' } }), 'bucket', signer, 'https://api.test', 600);
    const url = new URL(await real.signedUrl('room1'));
    expect(url.host).toBe('bucket.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe(`/${mediaKey('room1')}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores and deletes under the room\'s key', async () => {
    await media.put('room1', new Uint8Array([1, 2, 3]), 'image/png');
    await media.delete('room1');
    expect(sent.map((s) => s.name)).toEqual(['PutObjectCommand', 'DeleteObjectCommand']);
    expect(sent[0].input).toMatchObject({ Bucket: 'bucket', Key: 'rooms/room1', ContentType: 'image/png' });
    expect(sent[1].input).toMatchObject({ Bucket: 'bucket', Key: 'rooms/room1' });
  });
});

describe('IotPubSub', () => {
  it('publishes JSON on the topic, at most once', async () => {
    const sent: { topic: string; qos: number; payload: Uint8Array }[] = [];
    const iot = { send: async (c: { input: (typeof sent)[number] }) => void sent.push(c.input) } as unknown as IoTDataPlaneClient;
    await new IotPubSub(iot).publish('puzzle/r1/events', { t: 'closed', reason: 'owner' });
    expect(sent[0].topic).toBe('puzzle/r1/events');
    expect(sent[0].qos).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(sent[0].payload))).toEqual({ t: 'closed', reason: 'owner' });
  });
});

describe('the API function', () => {
  const event = (o: { method?: string; path: string; query?: string; body?: string | Uint8Array; claims?: Record<string, unknown>; headers?: Record<string, string> }): APIGatewayProxyEventV2WithJWTAuthorizer => {
    const binary = o.body instanceof Uint8Array;
    return {
      rawPath: o.path,
      rawQueryString: o.query ?? '',
      headers: o.headers ?? {},
      isBase64Encoded: binary,
      body: binary ? Buffer.from(o.body as Uint8Array).toString('base64') : (o.body as string | undefined),
      requestContext: { http: { method: o.method ?? 'GET' }, authorizer: o.claims ? { jwt: { claims: o.claims, scopes: [] } } : undefined },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  };
  const setup = () => {
    const { w } = dynamoWorld();
    const handler = makeHandler(createRouter({ service: w.service, auth: { verify: async () => null }, media: w.media }));
    return { w, handler };
  };
  const claims = (sub: string, name?: string) => ({ sub, name, email: `${sub}@example.com` });

  it('takes the player from the claims of the token, with the e-mail to stand in for a name', () => {
    expect(playerFrom({ sub: 'abc-123', name: ' Ann ', email: 'ann@example.com' })).toEqual({ id: 'abc-123', name: 'Ann' });
    expect(playerFrom({ sub: 'abc-123', email: 'ann.lee@example.com' })).toEqual({ id: 'abc-123', name: 'ann.lee' });
    expect(playerFrom({ sub: 'abc-123' })).toEqual({ id: 'abc-123', name: 'Player' });
    expect(playerFrom({ sub: 'x'.repeat(30), name: 'N'.repeat(40) })!.name).toHaveLength(24);
    expect(playerFrom({})).toBeUndefined();
    expect(playerFrom({ sub: 'a#b' })).toBeUndefined();
    expect(playerFrom(undefined)).toBeUndefined();
  });

  it('turns an event into a request, and an answer into a result', () => {
    const req = toReq(event({ method: 'PUT', path: '/media/r1', query: 'exp=5&sig=ab', body: new Uint8Array([1, 2, 3]) }));
    expect(req).toMatchObject({ method: 'PUT', path: '/media/r1', player: undefined });
    expect(req.query.get('sig')).toBe('ab');
    expect([...req.body]).toEqual([1, 2, 3]);
    expect(toResult({ status: 200, body: { ok: true } })).toEqual({ statusCode: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } });
    expect(toResult({ status: 200, body: new Uint8Array([9]), type: 'image/png' })).toMatchObject({ isBase64Encoded: true, body: 'CQ==', headers: { 'content-type': 'image/png' } });
  });

  it('does nothing for a request without a signed-in player (the gateway lets none through, but the function does not rely on it)', async () => {
    const { handler } = setup();
    expect((await handler(event({ path: '/rooms' }))).statusCode).toBe(401);
    expect((await handler(event({ path: '/rooms', headers: { authorization: 'Bearer dev:ann:Ann' } }))).statusCode).toBe(401);
  });

  it('makes a puzzle, takes the picture through the API, lets another player in and lists it', async () => {
    const { w, handler } = setup();
    const made = await handler(
      event({ method: 'POST', path: '/rooms', body: JSON.stringify(request()), claims: claims('ann-1', 'Ann') }),
    );
    expect(made.statusCode).toBe(200);
    const m = JSON.parse(made.body as string) as { roomId: string; upload: { url: string }; invite: { code: string; secret: string } };
    const url = new URL(m.upload.url.replace('http://media.test', 'https://api.test'));
    const put = await handler(event({ method: 'PUT', path: url.pathname, query: url.search.slice(1), body: jpeg(400, 300) }));
    expect(put.statusCode).toBe(200);
    expect(w.media.has(m.roomId)).toBe(true);
    const joined = await handler(
      event({ method: 'POST', path: '/join', body: JSON.stringify({ protocol: PROTOCOL_VERSION, code: m.invite.code, secret: m.invite.secret }), claims: claims('bob-2', 'Bob') }),
    );
    expect(JSON.parse(joined.body as string)).toMatchObject({ ok: true, room: { id: m.roomId } });
    const list = JSON.parse((await handler(event({ path: '/rooms', claims: claims('bob-2') }))).body as string) as { rooms: { id: string; members: { name: string }[] }[] };
    expect(list.rooms.map((r) => r.id)).toEqual([m.roomId]);
    expect(list.rooms[0].members.map((x) => x.name)).toEqual(['Ann', 'Bob']);
  });

  it('refuses a picture sent to an address that was not signed, or is of another room', async () => {
    const { handler } = setup();
    expect((await handler(event({ method: 'PUT', path: '/media/r1', query: 'exp=99999999999999&sig=00', body: jpeg(400, 300) }))).statusCode).toBe(403);
    expect((await handler(event({ method: 'PUT', path: '/media/r1', body: jpeg(400, 300) }))).statusCode).toBe(403);
  });

  it('answers 500 with nothing of what went wrong when something throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = makeHandler(async () => {
      throw new Error('secret detail');
    });
    const res = await handler(event({ path: '/rooms', claims: claims('ann-1') }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret detail');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('the clean-up of pictures', () => {
  const record = (eventName: string, pk: string, sk: string) => ({ eventName, dynamodb: { OldImage: { pk: { S: pk }, sk: { S: sk } } } });
  const stream = (...r: object[]) => ({ Records: r }) as unknown as DynamoDBStreamEvent;

  it('deletes the picture of a room that was removed, and nothing for anything else', async () => {
    const removed: string[] = [];
    const n = await clearPictures(
      stream(
        record('REMOVE', 'ROOM#r1', 'META'),
        record('REMOVE', 'ROOM#r1', 'ONLINE#ann'),
        record('REMOVE', 'CODE#12345', 'CODE'),
        record('REMOVE', 'PLAYER#ann', 'ROOM#r1'),
        record('MODIFY', 'ROOM#r2', 'META'),
        record('INSERT', 'ROOM#r3', 'META'),
        record('REMOVE', 'ROOM#r4', 'META'),
      ),
      async (key) => void removed.push(key),
    );
    expect(removed).toEqual(['rooms/r1', 'rooms/r4']);
    expect(n).toBe(2);
  });

  it('fails the batch if a deletion fails, so that the stream tries it again', async () => {
    await expect(
      clearPictures(stream(record('REMOVE', 'ROOM#r1', 'META')), async () => {
        throw new Error('S3 is down');
      }),
    ).rejects.toThrow('S3 is down');
  });
});
