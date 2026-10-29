import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { liveClientId, parseLiveClientId, topics, type RoomMessage } from '../src/online/protocol';
import { DISCONNECT_S, makeAuthorizer, policyFor, REFRESH_S } from '../server/src/aws/authorizer';
import { DynamoPresence, DynamoStore } from '../server/src/aws/dynamo';
import { GuestTokens } from '../server/src/guest';
import { CognitoVerifier } from '../server/src/aws/jwt';
import { makePresenceHandler } from '../server/src/aws/presence';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, DAY, open, world } from './helpers/world';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_POOL';
const CLIENT = 'client123';

describe('the name of a connection', () => {
  it('says the room, the player and the connection, and nothing else is a name', () => {
    expect(parseLiveClientId(liveClientId('abcd2345', 'user-1_x', 'k3j'))).toEqual({ room: 'abcd2345', player: 'user-1_x', connection: 'k3j' });
    for (const bad of ['', 'room', 'a:b', 'a:b:c:d', 'a/b:c:d', 'a:b:c*', 'a:b#c:d', `${'r'.repeat(65)}:p:c`]) expect(parseLiveClientId(bad)).toBeUndefined();
  });
});

describe('CognitoVerifier', () => {
  const clock = { t: 1_700_000_000_000, now() { return this.t; } };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const keyPair = (kid: string) => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
  };
  const good = () => ({ sub: 'user-1', iss: ISSUER, aud: CLIENT, token_use: 'id', exp: clock.t / 1000 + 3600, email: 'ann@example.com' });
  const issue = (key: KeyObject, kid: string, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid }) => {
    const data = `${b64(header)}.${b64(claims)}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  };
  const setup = (keys = [keyPair('k1')]) => {
    const fetched: string[] = [];
    const verifier = new CognitoVerifier(ISSUER, CLIENT, async (url) => (fetched.push(url), { keys: keys.map((k) => k.jwk) }), clock);
    return { verifier, fetched, keys };
  };

  it('lets a token of the pool through, and gives its claims', async () => {
    const { verifier, keys } = setup();
    const claims = await verifier.verify(issue(keys[0].privateKey, 'k1', good()));
    expect(claims).toMatchObject({ sub: 'user-1', email: 'ann@example.com' });
  });

  it('turns away a token that is not whole, not ours, or not valid any more', async () => {
    const { verifier, keys } = setup();
    const k = keys[0];
    const other = keyPair('k1');
    const bad: Record<string, string> = {
      'signed by someone else': issue(other.privateKey, 'k1', good()),
      'for another app': issue(k.privateKey, 'k1', { ...good(), aud: 'someone-else' }),
      'from another pool': issue(k.privateKey, 'k1', { ...good(), iss: `${ISSUER}X` }),
      'an access token': issue(k.privateKey, 'k1', { ...good(), token_use: 'access' }),
      'run out': issue(k.privateKey, 'k1', { ...good(), exp: clock.t / 1000 - 1 }),
      'with no end': issue(k.privateKey, 'k1', { ...good(), exp: undefined }),
      'with an algorithm of its own choosing': `${b64({ alg: 'none', kid: 'k1' })}.${b64(good())}.`,
      'HS256': issue(k.privateKey, 'k1', good(), { alg: 'HS256', kid: 'k1' }),
      'with no key id': issue(k.privateKey, 'k1', good(), { alg: 'RS256' }),
      'cut short': 'abc.def',
      'not even JSON': 'a.b.c',
      'empty': '',
    };
    for (const [why, token] of Object.entries(bad)) expect(await verifier.verify(token), why).toBeUndefined();
  });

  it('asks the pool for its keys once, and not again for a key id it does not know until a minute has passed', async () => {
    const { verifier, fetched, keys } = setup();
    const token = issue(keys[0].privateKey, 'k1', good());
    await verifier.verify(token);
    await verifier.verify(token);
    expect(fetched).toEqual([`${ISSUER}/.well-known/jwks.json`]);
    const stranger = keyPair('k9');
    expect(await verifier.verify(issue(stranger.privateKey, 'k9', good()))).toBeUndefined();
    expect(await verifier.verify(issue(stranger.privateKey, 'k9', good()))).toBeUndefined();
    expect(fetched).toHaveLength(1);                                  // a made-up key id does not make it ask again
    clock.t += 61_000;
    await verifier.verify(issue(stranger.privateKey, 'k9', good()));
    expect(fetched).toHaveLength(2);                                  // a minute on, an unknown id is worth one more look
  });

  it('picks up a key that the pool has rotated in', async () => {
    const first = keyPair('k1');
    const second = keyPair('k2');
    let current = [first];
    const verifier = new CognitoVerifier(ISSUER, CLIENT, async () => ({ keys: current.map((k) => k.jwk) }), clock);
    expect(await verifier.verify(issue(first.privateKey, 'k1', { ...good(), exp: clock.t / 1000 + 9000 }))).toBeDefined();
    current = [first, second];
    clock.t += 61_000;
    expect(await verifier.verify(issue(second.privateKey, 'k2', { ...good(), exp: clock.t / 1000 + 9000 }))).toBeDefined();
  });
});

describe('the policy of a connection', () => {
  const arn = (kind: string, name: string) => `arn:${kind}/${name}`;
  const statements = JSON.parse(policyFor(arn as never, 'room1', 'ann')).Statement as { Action: string; Resource: string | string[] }[];
  const of = (action: string) => [statements.find((s) => s.Action === action)!.Resource].flat();

  it('lets a player connect under their own name in their own room, and nothing more', () => {
    expect(statements.map((s) => s.Action).sort()).toEqual(['iot:Connect', 'iot:Publish', 'iot:Receive', 'iot:Subscribe']);
    expect(of('iot:Connect')).toEqual(['arn:client/room1:ann:*']);
    expect(of('iot:Subscribe')).toEqual(['arn:topicfilter/puzzle/room1/events', 'arn:topicfilter/puzzle/room1/hand/+']);
    expect(of('iot:Receive')).toEqual(['arn:topic/puzzle/room1/events', 'arn:topic/puzzle/room1/hand/*']);
  });
  it('lets them say where the piece in their hand is, on their own topic only (and never on the room\'s events)', () => {
    expect(of('iot:Publish')).toEqual([`arn:topic/${topics.hand('room1', 'ann')}`]);
    expect(of('iot:Publish').join()).not.toContain('events');
  });
});

describe('the authorizer', () => {
  const claims = (sub: string) => ({ sub, email: `${sub}@example.com` });
  const arn = (kind: string, name: string) => `arn:aws:iot:us-east-1:111122223333:${kind}/${name}`;
  const setup = () => {
    const db = new FakeDynamo();
    const w = world({}, (clock) => new DynamoStore(db, 'table', clock));
    const verifier = { verify: async (token: string) => (token.startsWith('good-') ? claims(token.slice(5)) : undefined) };
    const guests = new GuestTokens(new Uint8Array(32).fill(3), w.clock);
    const authorize = makeAuthorizer({ verifier, guests, rooms: w.store as DynamoStore, arn: arn as never });
    return { w, authorize, guests };
  };
  const ask = (token: string, room: string) => ({ protocolData: { http: { queryString: `token=${encodeURIComponent(token)}&room=${encodeURIComponent(room)}` } } });

  it('lets a member in with a policy for that room, and asks again later', async () => {
    const { w, authorize } = setup();
    const made = await open(w, { id: 'ann', name: 'Ann' });
    const r = await authorize(ask('good-ann', made.roomId));
    expect(r.isAuthenticated).toBe(true);
    expect(r.refreshAfterInSeconds).toBe(REFRESH_S);
    expect(r.disconnectAfterInSeconds).toBe(DISCONNECT_S);
    expect(r.principalId).toMatch(/^[A-Za-z0-9]+$/);
    expect(r.policyDocuments).toEqual([policyFor(arn as never, made.roomId, 'ann')]);
    expect(r.policyDocuments[0]).toContain(`client/${made.roomId}:ann:*`);
  });

  it('turns away a player who is not in the room, whatever their token says, and tokens that are not good', async () => {
    const { w, authorize } = setup();
    const made = await open(w, ann);
    expect((await authorize(ask('good-bob', made.roomId))).isAuthenticated).toBe(false);
    expect((await authorize(ask('forged', made.roomId))).isAuthenticated).toBe(false);
    expect((await authorize(ask('', made.roomId))).isAuthenticated).toBe(false);
    expect((await authorize({})).isAuthenticated).toBe(false);
  });

  it('lets a guest in too, once they are in the room, with the same kind of policy under their own id', async () => {
    const { w, authorize, guests } = setup();
    const made = await open(w, ann);
    const g = await guests.issue();
    expect((await authorize(ask(g.token, made.roomId))).isAuthenticated).toBe(false);                 // not in the room yet
    const joined = await w.service.join({ id: g.id, name: 'Guest', guest: true }, { protocol: 1, code: made.invite.code, secret: made.invite.secret } as never);
    expect(joined.ok).toBe(true);
    const r = await authorize(ask(g.token, made.roomId));
    expect(r.isAuthenticated).toBe(true);
    expect(r.policyDocuments).toEqual([policyFor(arn as never, made.roomId, g.id)]);
    expect(r.principalId).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('turns away a guest token that was changed or has run out', async () => {
    const { w, authorize, guests } = setup();
    const made = await open(w, ann);
    const g = await guests.issue();
    await w.service.join({ id: g.id, name: 'Guest', guest: true }, { protocol: 1, code: made.invite.code, secret: made.invite.secret } as never);
    expect((await authorize(ask(`${g.token}x`, made.roomId))).isAuthenticated).toBe(false);
    expect((await authorize(ask('g1.forged.token', made.roomId))).isAuthenticated).toBe(false);
    w.clock.t += 100 * DAY;
    expect((await authorize(ask(g.token, made.roomId))).isAuthenticated).toBe(false);
  });

  it('gives times IoT accepts in every answer, a "no" as well (more than 5 minutes, less than a day)', async () => {
    const { w, authorize } = setup();
    const made = await open(w, ann);
    for (const r of [await authorize(ask('good-ann', made.roomId)), await authorize(ask('forged', made.roomId)), await authorize({})]) {
      expect(r.refreshAfterInSeconds).toBeGreaterThan(300);
      expect(r.refreshAfterInSeconds).toBeLessThan(86_400);
      expect(r.disconnectAfterInSeconds).toBeGreaterThan(300);
      expect(r.disconnectAfterInSeconds).toBeLessThanOrEqual(86_400);
    }
  });

  it('takes only a plain room id (no way to name another topic through it)', async () => {
    const { w, authorize } = setup();
    const made = await open(w, ann);
    for (const room of ['', '#', '+', `${made.roomId}/../x`, `${made.roomId}:ann`, `${made.roomId}*`, 'x'.repeat(65)]) expect((await authorize(ask('good-ann', room))).isAuthenticated, room).toBe(false);
    expect((await authorize(ask('good-ann', 'unknownroom'))).isAuthenticated).toBe(false);
  });

  it('lets a player out when the room is over, and a member who was added in', async () => {
    const { w, authorize } = setup();
    const made = await open(w, ann);
    const j = await w.service.join(bob, { protocol: 1, code: made.invite.code, secret: made.invite.secret } as never);
    expect(j.ok).toBe(true);
    expect((await authorize(ask('good-bob', made.roomId))).isAuthenticated).toBe(true);
    w.clock.t += 2 * DAY;
    expect((await authorize(ask('good-bob', made.roomId))).isAuthenticated).toBe(false);
  });
});

describe('who is online, from the broker\'s events', () => {
  const setup = () => {
    const db = new FakeDynamo();
    const w = world({}, (clock) => new DynamoStore(db, 'table', clock));
    const presence = new DynamoPresence(db, 'table', w.clock);
    const said: { topic: string; message: RoomMessage }[] = [];
    const handle = makePresenceHandler({ presence, rooms: w.store as DynamoStore, pubsub: { publish: async (topic, message) => void said.push({ topic, message: message as RoomMessage }) } });
    const event = (room: string, player: string, connection: string, eventType: string) => ({ clientId: liveClientId(room, player, connection), eventType });
    return { w, presence, said, handle, event };
  };

  it('says a player is online when they connect, and offline only when their last connection is gone', async () => {
    const { w, presence, said, handle, event } = setup();
    const { roomId } = await open(w, ann);
    await handle(event(roomId, 'ann', 'tab1', 'connected'));
    await handle(event(roomId, 'ann', 'tab2', 'connected'));
    expect(await presence.online(roomId)).toEqual(['ann']);
    await handle(event(roomId, 'ann', 'tab1', 'disconnected'));
    expect(await presence.online(roomId)).toEqual(['ann']);
    expect(said.filter((s) => !(s.message as { online: boolean }).online)).toEqual([]);
    await handle(event(roomId, 'ann', 'tab2', 'disconnected'));
    expect(await presence.online(roomId)).toEqual([]);
    expect(said.map((s) => [s.topic, s.message])).toEqual([
      [topics.events(roomId), { t: 'presence', id: 'ann', online: true }],
      [topics.events(roomId), { t: 'presence', id: 'ann', online: true }],
      [topics.events(roomId), { t: 'presence', id: 'ann', online: false }],
    ]);
  });

  it('keeps the players apart', async () => {
    const { w, presence, handle, event } = setup();
    const { roomId } = await open(w, ann);
    await handle(event(roomId, 'ann', 'a', 'connected'));
    await handle(event(roomId, 'bob', 'b', 'connected'));
    await handle(event(roomId, 'ann', 'a', 'disconnected'));
    expect(await presence.online(roomId)).toEqual(['bob']);
  });

  it('ignores what is not about a room of this deployment, or not about a game at all', async () => {
    const { w, presence, said, handle, event } = setup();
    const { roomId } = await open(w, ann);
    await handle(event('someoneelsesroom', 'ann', 'a', 'connected'));        // a room of another deployment in the same account
    await handle({ clientId: 'esp32-sensor-7', eventType: 'connected' });
    await handle({ clientId: liveClientId(roomId, 'ann', 'a'), eventType: 'subscribed' });
    await handle({});
    expect(said).toEqual([]);
    expect(await presence.online(roomId)).toEqual([]);
  });

  it('forgets an entry whose "disconnected" never came, after a while', async () => {
    const { w, presence, handle, event } = setup();
    const { roomId } = await open(w, ann);
    await handle(event(roomId, 'ann', 'a', 'connected'));
    w.clock.t += DynamoPresence.KEEP_MS + 2000;
    expect(await presence.online(roomId)).toEqual([]);
  });
});

describe('DynamoStore.membersOf', () => {
  it('lists who is in a room without reading the whole record, and nothing for a room that is gone or over', async () => {
    const db = new FakeDynamo();
    const w = world({}, (clock) => new DynamoStore(db, 'table', clock));
    const store = w.store as DynamoStore;
    const { roomId } = await open(w, ann);
    expect(await store.membersOf(roomId)).toEqual(['ann']);
    expect(await store.membersOf('nosuchroom')).toBeUndefined();
    w.clock.t += 2 * DAY;
    expect(await store.membersOf(roomId)).toBeUndefined();
  });
});
