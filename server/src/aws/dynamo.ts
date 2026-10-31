import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { AccountRecord, AdNonce, Ban, Clock, FileRecord, Presence, RateCounter, Report, RoomRecord, Store } from '../types';

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
 *   PLAYER#<id>   / ACCOUNT         the account's type and credits (`body` is the record as JSON; `rev` makes a write conditional, as for a room)
 *   PLAYER#<id>   / PROFILE         the display name the player chose (with a `ttl` for a guest, who may not come back)
 *   FILE#<id>     / FILE            a kept picture or video (`body` is the record as JSON; `ttl` is when it runs out)
 *   FILE#<id>     / USER#<player>   a player who may make a puzzle from the file (they joined a puzzle made from it)
 *   PLAYER#<id>   / FILE#<id>       a file the player sent
 *   FILES         / <ms>#<id>       every kept file, in the order they were sent (to list them). The last three have a `ttl` a little after the file's own, put forward each time the file is used
 *   AD#<nonce>    / NONCE           what an ad was asked for, until it is watched (`body` is the record as JSON; with a `ttl`)
 *   ADTX#<id>     / TX              a reward that the ad network reported (with a `ttl`: the network may report one again for a while)
 *   REPORTS       / <ms>#<tag>      a report of a puzzle (with a `ttl`)
 *   BANS          / <player>        a player who may not play online (no `ttl`)
 *   RATE#<key>#<n> / COUNT          how many times something happened in one window of time (see DynamoRates)
 * `ttl` (seconds) is when DynamoDB may delete an item, up to two days late: nothing here relies on that, expiry is checked when an item is read.
 */
const roomKey = (id: string) => ({ pk: `ROOM#${id}`, sk: 'META' });
const codeKey = (code: string) => ({ pk: `CODE#${code}`, sk: 'CODE' });
const accountKey = (player: string) => ({ pk: `PLAYER#${player}`, sk: 'ACCOUNT' });
const memberKey = (player: string, room: string) => ({ pk: `PLAYER#${player}`, sk: `ROOM#${room}` });
const fileItem = (id: string) => ({ pk: `FILE#${id}`, sk: 'FILE' });
const fileUserKey = (id: string, player: string) => ({ pk: `FILE#${id}`, sk: `USER#${player}` });
const ownerFileKey = (player: string, id: string) => ({ pk: `PLAYER#${player}`, sk: `FILE#${id}` });
const pad = (ms: number) => String(Math.max(0, ms)).padStart(15, '0');

const seconds = (ms: number) => Math.ceil(ms / 1000);
const HOUR = 3600 * 1000;
/** The code and the memberships of a room outlive the room by up to this much, so that they are not written again for every move. */
const SLACK = 6 * HOUR;
/** A code that was claimed for a room that was never made goes after this. */
const CLAIM_MS = HOUR;
/** What hangs on a kept file (who may use it, the lists it is in) outlives the file by this much (and is put forward when the file is used). */
const FILE_SLACK_MS = 2 * 24 * HOUR;
/** A report is kept this long: long enough to be looked at, and to be found again if the same puzzle or player is reported later. */
const REPORT_KEEP_MS = 90 * 24 * HOUR;

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

  async putAdNonce(nonce: AdNonce): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `AD#${nonce.nonce}`, sk: 'NONCE', body: JSON.stringify(nonce), ttl: seconds(nonce.expiresAt) } }));
  }

  async getAdNonce(nonce: string): Promise<AdNonce | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `AD#${nonce}`, sk: 'NONCE' }, ConsistentRead: true }));
    return Item ? (JSON.parse(Item.body as string) as AdNonce) : undefined;      // (the service looks at the time: the table may keep an item that has run out for a day or two)
  }

  async deleteAdNonce(nonce: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `AD#${nonce}`, sk: 'NONCE' } }));
  }

  async hasAdTransaction(transactionId: string): Promise<boolean> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `ADTX#${transactionId}`, sk: 'TX' }, ConsistentRead: true }));
    return !!Item;
  }

  async putAdTransaction(transactionId: string, until: number): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `ADTX#${transactionId}`, sk: 'TX', ttl: seconds(until) } }));
  }

  async getAccount(playerId: string): Promise<AccountRecord | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: accountKey(playerId), ConsistentRead: true }));
    return Item ? (JSON.parse(Item.body as string) as AccountRecord) : undefined;
  }

  async putAccount(account: AccountRecord): Promise<boolean> {
    const item = { ...accountKey(account.id), body: JSON.stringify(account), rev: account.rev };
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: account.rev > 0 ? '#rev = :prev' : 'attribute_not_exists(pk)',
          ...(account.rev > 0 ? { ExpressionAttributeNames: { '#rev': 'rev' }, ExpressionAttributeValues: { ':prev': account.rev - 1 } } : {}),
        }),
      );
      return true;
    } catch (e) {
      if (named(e, 'ConditionalCheckFailedException')) return false;                // someone else wrote the account in between
      throw e;
    }
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

  async addReport(report: Report): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: 'REPORTS', sk: report.id, ...report, ttl: seconds(report.at + REPORT_KEEP_MS) } }));
  }

  async reportsSince(since: number): Promise<Report[]> {
    const found: Report[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': 'REPORTS', ':from': pad(since), ':to': `${pad(Number.MAX_SAFE_INTEGER)}~` },
          ExclusiveStartKey: start,
        }),
      );
      for (const it of page.Items ?? []) found.push({ id: it.sk, at: it.at, roomId: it.roomId, ownerId: it.ownerId, reporterId: it.reporterId, members: it.members, reason: it.reason, note: it.note });
      start = page.LastEvaluatedKey;
    } while (start);
    return found.sort((a, b) => b.at - a.at);
  }

  async ban(ban: Ban): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: 'BANS', sk: ban.playerId, at: ban.at, reason: ban.reason } }));
  }

  async unban(playerId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'BANS', sk: playerId } }));
  }

  async getBan(playerId: string): Promise<Ban | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: 'BANS', sk: playerId } }));
    return Item ? { playerId, at: Item.at as number, reason: Item.reason as string } : undefined;
  }

  async bans(): Promise<Ban[]> {
    const found: Ban[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      // the ids are letters, digits, dashes and underscores: all between "-" and "~"
      const page = await this.db.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to', ExpressionAttributeValues: { ':pk': 'BANS', ':from': '-', ':to': '~' }, ExclusiveStartKey: start }),
      );
      for (const it of page.Items ?? []) found.push({ playerId: it.sk as string, at: it.at as number, reason: it.reason as string });
      start = page.LastEvaluatedKey;
    } while (start);
    return found;
  }

  async getFile(id: string): Promise<FileRecord | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: fileItem(id), ConsistentRead: true }));
    return Item ? (JSON.parse(Item.body as string) as FileRecord) : undefined;
  }

  async putFile(file: FileRecord): Promise<void> {
    // what hangs on the file first: if this stops half way, the file is not there to be used, and what was written goes by itself
    const ttl = seconds(file.expiresAt + FILE_SLACK_MS);
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...ownerFileKey(file.ownerId, file.id), ttl } }));
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: 'FILES', sk: `${pad(file.createdAt)}#${file.id}`, id: file.id, ttl } }));
    // the players who may use it: their entries are put forward with the file (they would otherwise run out while the file is still kept)
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :user)', ExpressionAttributeValues: { ':pk': `FILE#${file.id}`, ':user': 'USER#' }, ExclusiveStartKey: start }),
      );
      for (const it of page.Items ?? []) await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: it.pk, sk: it.sk, ttl } }));
      start = page.LastEvaluatedKey;
    } while (start);
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...fileItem(file.id), body: JSON.stringify(file), expiresAt: file.expiresAt, ttl: seconds(file.expiresAt) } }));
  }

  async deleteFile(id: string): Promise<void> {
    const file = await this.getFile(id);
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :user)', ExpressionAttributeValues: { ':pk': `FILE#${id}`, ':user': 'USER#' }, ExclusiveStartKey: start }),
      );
      for (const it of page.Items ?? []) await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: it.pk, sk: it.sk } }));
      start = page.LastEvaluatedKey;
    } while (start);
    if (file) {
      await this.db.send(new DeleteCommand({ TableName: this.table, Key: ownerFileKey(file.ownerId, id) }));
      await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'FILES', sk: `${pad(file.createdAt)}#${id}` } }));
    }
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: fileItem(id) }));
  }

  async addFileUser(fileId: string, playerId: string, until: number): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...fileUserKey(fileId, playerId), ttl: seconds(until) } }));
  }

  async hasFileUser(fileId: string, playerId: string): Promise<boolean> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.table, Key: fileUserKey(fileId, playerId), ConsistentRead: true }));
    return !!Item && !(typeof Item.ttl === 'number' && Item.ttl <= seconds(this.clock.now()));
  }

  async filesOf(playerId: string): Promise<string[]> {
    const ids: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :file)', ExpressionAttributeValues: { ':pk': `PLAYER#${playerId}`, ':file': 'FILE#' }, ExclusiveStartKey: start }),
      );
      for (const it of page.Items ?? []) ids.push((it.sk as string).slice('FILE#'.length));
      start = page.LastEvaluatedKey;
    } while (start);
    return ids;
  }

  /** Every kept file: the list of their ids is read (it is small: an id each) and then the records, a hundred at a time. */
  async allFiles(): Promise<FileRecord[]> {
    const ids: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to', ExpressionAttributeValues: { ':pk': 'FILES', ':from': '0', ':to': '~' }, ExclusiveStartKey: start }),
      );
      for (const it of page.Items ?? []) ids.push(it.id as string);
      start = page.LastEvaluatedKey;
    } while (start);
    const files: FileRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const got = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: ids.slice(i, i + 100).map(fileItem), ConsistentRead: true } } }));
      for (const it of (got.Responses?.[this.table] as { body: string }[] | undefined) ?? []) files.push(JSON.parse(it.body) as FileRecord);
    }
    return files;
  }

  async forgetPlayer(playerId: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `PLAYER#${playerId}`, sk: 'PROFILE' } }));
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: accountKey(playerId) }));
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

