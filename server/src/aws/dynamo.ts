import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Clock, Presence, RoomRecord, Store } from '../types';

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
}

/** Who is connected to a room, kept as one item per player. The live side (see the IoT presence function) writes them; the service reads. */
export class DynamoPresence implements Presence {
  /** An entry that nobody takes back (a lost "disconnected") goes after this. */
  static readonly KEEP_MS = 2 * HOUR;

  constructor(
    private readonly db: Sender,
    private readonly table: string,
    private readonly clock: Clock,
  ) {}

  async online(roomId: string): Promise<string[]> {
    const { Items } = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :on)',
        FilterExpression: '#ttl > :now',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':pk': `ROOM#${roomId}`, ':on': 'ONLINE#', ':now': seconds(this.clock.now()) },
      }),
    );
    return (Items ?? []).map((it: { sk: string }) => (it.sk as string).slice('ONLINE#'.length));
  }

  async set(roomId: string, playerId: string, online: boolean): Promise<void> {
    const key = { pk: `ROOM#${roomId}`, sk: `ONLINE#${playerId}` };
    if (online) await this.db.send(new PutCommand({ TableName: this.table, Item: { ...key, ttl: seconds(this.clock.now() + DynamoPresence.KEEP_MS) } }));
    else await this.db.send(new DeleteCommand({ TableName: this.table, Key: key }));
  }
}

