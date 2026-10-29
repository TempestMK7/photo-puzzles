import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Clock, Presence, RateCounter, RoomRecord, Store } from '../types';

/** The part of the document client that is used, so that a test can put a fake in its place. */
export interface Sender {
  send(command: any): Promise<any>;
}

/**
 * One table for everything (the same layout as infra/lib/data-stack.ts says):
 *   ROOM#<id>     / META            the room: `body` is the whole record as JSON (a board of 1,000 pieces is about 90 KB as text, and far more as DynamoDB numbers)
 *   ROOM#<id>     / ONLINE#<player> a player who is connected to the room
 *   CODE#<digits> / CODE            a code and the room it opens
 *   PLAYER#<id>   / ROOM#<id>       a player's membership
 *   PLAYER#<id>   / CREATION#<ms>   a puzzle that was made, for the quota
 *   PLAYER#<id>   / PROFILE         the display name the player chose (with a `ttl` for a guest, who may not come back)
 *   RATE#<key>#<n> / COUNT          how many times something happened in one window of time (see DynamoRates)
 * `ttl` (seconds) is when DynamoDB may delete an item, up to two days late: nothing here relies on that, expiry is checked when an item is read.
 */
const roomKey = (id: string) => ({ pk: `ROOM#${id}`, sk: 'META' });
const codeKey = (code: string) => ({ pk: `CODE#${code}`, sk: 'CODE' });
const memberKey = (player: string, room: string) => ({ pk: `PLAYER#${player}`, sk: `ROOM#${room}` });
const pad = (ms: number) => String(Math.max(0, ms)).padStart(15, '0');

const seconds = (ms: number) => Math.ceil(ms / 1000);
const HOUR = 3600 * 1000;
/** The code and the memberships of a room outlive the room by up to this much, so that they are not written again for every move. */
const SLACK = 6 * HOUR;
/** A code that was claimed for a room that was never made goes after this. */
const CLAIM_MS = HOUR;
/** The quota looks back a week; the records stay a day longer. */
const CREATION_KEEP_MS = 8 * 24 * HOUR;

const named = (e: unknown, name: string): boolean => (e as { name?: string })?.name === name;

interface Stored {
  members: string[];
  itemsTtl: number;
  rev: number;
  code: string;
}

export class DynamoStore implements Store {
  constructor(
    private readonly db: Sender,
    private readonly table: string,
    private readonly clock: Clock,
  ) {}

  async getRoom(id: string): Promise<RoomRecord | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: roomKey(id), ConsistentRead: true }));
    return Item ? (JSON.parse(Item.body as string) as RoomRecord) : undefined;
  }

  /**
   * Who is in a room, for the live side to check before it lets a player listen to it (reading the whole record, which can be 100 KB, would be a waste). Nothing if there is
   * no such room or it has run out.
   */
  async membersOf(roomId: string): Promise<string[] | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({ TableName: this.table, Key: roomKey(roomId), ConsistentRead: true, ProjectionExpression: '#m, #e', ExpressionAttributeNames: { '#m': 'members', '#e': 'expiresAt' } }),
    );
    if (!Item || (Item.expiresAt as number) <= this.clock.now()) return undefined;
    return Item.members as string[];
  }

  async putRoom(room: RoomRecord): Promise<boolean> {
    const members = room.members.map((m) => m.id);
    let prev: Stored | undefined;
    if (room.rev > 0) {
      const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: roomKey(room.id), ConsistentRead: true, ProjectionExpression: 'members, itemsTtl, #rev, code', ExpressionAttributeNames: { '#rev': 'rev' } }));
      if (!Item || Item.rev !== room.rev - 1) return false;
      prev = Item as Stored;
    }
    const ttl = seconds(room.expiresAt);
    const removed = prev ? prev.members.filter((m) => !members.includes(m)) : [];
    const added = prev ? members.filter((m) => !prev!.members.includes(m)) : members;
    // the items that hang on the room only need touching when they change or when they are about to run out before the room does
    const refresh = !prev || added.length > 0 || removed.length > 0 || prev.code !== room.code || ttl > prev.itemsTtl;
    const itemsTtl = refresh ? ttl + seconds(SLACK) : prev!.itemsTtl;
    const item = { ...roomKey(room.id), body: JSON.stringify(room), rev: room.rev, members, code: room.code, itemsTtl, expiresAt: room.expiresAt, ttl };
    const put = {
      TableName: this.table,
      Item: item,
      ConditionExpression: prev ? '#rev = :prev' : 'attribute_not_exists(pk)',
      ...(prev ? { ExpressionAttributeNames: { '#rev': 'rev' }, ExpressionAttributeValues: { ':prev': room.rev - 1 } } : {}),
    };
    try {
      if (!refresh) {
        await this.db.send(new PutCommand(put));
        return true;
      }
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: put },
            {
              Update: {
                TableName: this.table,
                Key: codeKey(room.code),
                UpdateExpression: 'SET #ttl = :ttl',
                ConditionExpression: 'roomId = :room',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':ttl': itemsTtl, ':room': room.id },
              },
            },
            ...members.map((m) => ({ Put: { TableName: this.table, Item: { ...memberKey(m, room.id), ttl: itemsTtl } } })),
            ...removed.map((m) => ({ Delete: { TableName: this.table, Key: memberKey(m, room.id) } })),
          ],
        }),
      );
      return true;
    } catch (e) {
      if (named(e, 'ConditionalCheckFailedException')) return false;
      if (named(e, 'TransactionCanceledException')) {
        const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return false;                // someone else wrote the room in between
        if (reasons[1]?.Code === 'ConditionalCheckFailed') throw new Error(`The code ${room.code} is not the room's`);
      }
      throw e;
    }
  }

  async deleteRoom(id: string): Promise<void> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: roomKey(id), ConsistentRead: true, ProjectionExpression: 'members' }));
    // the memberships first: if this stops half way, the room is still there to be deleted again
    for (const m of (Item?.members as string[] | undefined) ?? []) await this.db.send(new DeleteCommand({ TableName: this.table, Key: memberKey(m, id) }));
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: roomKey(id) }));
  }

  async claimCode(code: string, roomId: string): Promise<boolean> {
    const now = this.clock.now();
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...codeKey(code), roomId, ttl: seconds(now + CLAIM_MS) },
          ConditionExpression: 'attribute_not_exists(pk) OR #ttl < :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': seconds(now) },
        }),
      );
      return true;
    } catch (e) {
      if (named(e, 'ConditionalCheckFailedException')) return false;
      throw e;
    }
  }

  async roomOfCode(code: string): Promise<string | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: codeKey(code), ConsistentRead: true }));
    // an item whose time has passed but that DynamoDB has not removed yet still answers: the room it names is looked at by the service, which clears it away if it has expired
    return Item?.roomId as string | undefined;
  }

  async releaseCode(code: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: codeKey(code) }));
  }

  async roomsOf(playerId: string): Promise<string[]> {
    const ids: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :room)',
          ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':room': 'ROOM#' },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of page.Items ?? []) ids.push((it.sk as string).slice('ROOM#'.length));
      start = page.LastEvaluatedKey;
    } while (start);
    if (!ids.length) return [];
    // the memberships outlive their rooms by a few hours: only a room that is still there and not out of time counts
    const now = this.clock.now();
    const got = await this.db.send(
      new BatchGetCommand({ RequestItems: { [this.table]: { Keys: ids.map(roomKey), ProjectionExpression: 'pk, expiresAt' } } }),
    );
    const alive = new Set<string>();
    for (const it of (got.Responses?.[this.table] as { pk: string; expiresAt: number }[] | undefined) ?? []) if (it.expiresAt > now) alive.add(it.pk.slice('ROOM#'.length));
    return ids.filter((id) => alive.has(id));
  }

  /** Every room. This reads the whole table: it is for the local tests and for looking around, not for the cloud (the table's own expiry and the lookups do that work). */
  async allRooms(): Promise<RoomRecord[]> {
    const rooms: RoomRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new ScanCommand({ TableName: this.table, FilterExpression: 'sk = :meta', ExpressionAttributeValues: { ':meta': 'META' }, ExclusiveStartKey: start }),
      );
      for (const it of page.Items ?? []) rooms.push(JSON.parse(it.body as string) as RoomRecord);
      start = page.LastEvaluatedKey;
    } while (start);
    return rooms;
  }

  async creationsSince(playerId: string, since: number): Promise<number[]> {
    const times: number[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':from': `CREATION#${pad(since + 1)}`, ':to': `CREATION#${pad(Number.MAX_SAFE_INTEGER)}#~` },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of page.Items ?? []) times.push(Number((it.sk as string).slice('CREATION#'.length, 'CREATION#'.length + 15)));
      start = page.LastEvaluatedKey;
    } while (start);
    return times;
  }

  async addCreation(playerId: string, at: number): Promise<void> {
    // two puzzles in the same millisecond are possible only in a test, but they should not be one
    const tag = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `PLAYER#${playerId}`, sk: `CREATION#${pad(at)}#${tag}`, ttl: seconds(at + CREATION_KEEP_MS) } }));
  }

  async getName(playerId: string): Promise<string | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `PLAYER#${playerId}`, sk: 'PROFILE' } }));
    // an entry that has run out may still be there for a day or two (DynamoDB deletes late): it is not looked at
    if (!Item || (typeof Item.ttl === 'number' && Item.ttl <= seconds(this.clock.now()))) return undefined;
    return Item.name as string;
  }

  async setName(playerId: string, name: string, until?: number): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `PLAYER#${playerId}`, sk: 'PROFILE', name, ...(until === undefined ? {} : { ttl: seconds(until) }) } }));
  }

  async forgetPlayer(playerId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `PLAYER#${playerId}`, sk: 'PROFILE' } }));
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :creation)',
          ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':creation': 'CREATION#' },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of page.Items ?? []) await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: it.pk, sk: it.sk } }));
      start = page.LastEvaluatedKey;
    } while (start);
  }
}

/**
 * Counts for the limits on how often an address or a player may do something: one item per key and window of time (`RATE#<key>#<window number>`), added to with one atomic update, and
 * left for DynamoDB to delete (`ttl`) a window and a bit later. Nothing reads an old window, so the late deletion is harmless.
 */
export class DynamoRates implements RateCounter {
  constructor(
    private readonly db: Sender,
    private readonly table: string,
    private readonly clock: Clock,
  ) {}

  private key(key: string, windowMs: number) {
    const n = Math.floor(this.clock.now() / windowMs);
    return { key: { pk: `RATE#${key}#${n}`, sk: 'COUNT' }, ttl: seconds((n + 2) * windowMs) };
  }

  async add(key: string, windowMs: number): Promise<number> {
    const { key: Key, ttl } = this.key(key, windowMs);
    const out = await this.db.send(
      new UpdateCommand({ TableName: this.table, Key, UpdateExpression: 'ADD #n :one SET #ttl = :ttl', ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':ttl': ttl }, ReturnValues: 'UPDATED_NEW' }),
    );
    return out.Attributes?.n as number;
  }

  async count(key: string, windowMs: number): Promise<number> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: this.key(key, windowMs).key, ConsistentRead: true }));
    return (Item?.n as number | undefined) ?? 0;
  }
}

/**
 * Who is connected to a room, kept as one item per connection (`ONLINE#<player>#<connection>`: a player can have the room open in two places). The live side (the IoT presence
 * function) writes them; the service reads. A player is online while any of their connections is.
 */
export class DynamoPresence implements Presence {
  /** An entry that nobody takes back (a lost "disconnected") goes after this. */
  static readonly KEEP_MS = 2 * HOUR;

  constructor(
    private readonly db: Sender,
    private readonly table: string,
    private readonly clock: Clock,
  ) {}

  private async entries(roomId: string, prefix: string): Promise<{ sk: string }[]> {
    const { Items } = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :on)',
        FilterExpression: '#ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':pk': `ROOM#${roomId}`, ':on': prefix, ':now': seconds(this.clock.now()) },
      }),
    );
    return Items ?? [];
  }

  async online(roomId: string): Promise<string[]> {
    const items = await this.entries(roomId, 'ONLINE#');
    return [...new Set(items.map((it) => it.sk.slice('ONLINE#'.length).split('#')[0]))];
  }

  async connected(roomId: string, playerId: string, connection: string): Promise<void> {
    const item = { pk: `ROOM#${roomId}`, sk: `ONLINE#${playerId}#${connection}`, ttl: seconds(this.clock.now() + DynamoPresence.KEEP_MS) };
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  /** True if that was the player's last connection to the room (so they are not online any more). */
  async disconnected(roomId: string, playerId: string, connection: string): Promise<boolean> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `ROOM#${roomId}`, sk: `ONLINE#${playerId}#${connection}` } }));
    // read after the delete, and consistently: of two connections that end together, the one that deletes last sees none left and says so
    return (await this.entries(roomId, `ONLINE#${playerId}#`)).length === 0;
  }
}

