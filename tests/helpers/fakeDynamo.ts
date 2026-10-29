import type { Sender } from '../../server/src/aws/dynamo';

/**
 * A DynamoDB with just what `DynamoStore` asks of it, in memory, so that the store can be run through the same tests as the memory one. It reads the few shapes of expression
 * the store writes and **throws on any other**, and it keeps the rules of the real thing that matter here: an item is at most 400 KB, a transaction may not touch an item twice
 * and is all or nothing, a query or scan comes in pages, results of a query are in order of the sort key.
 */
type Item = Record<string, unknown>;
type Values = Record<string, unknown>;

interface Expr {
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Values;
}

const error = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(name), { name }, extra);

export class FakeDynamo implements Sender {
  items = new Map<string, Item>();
  /** How many items a query or scan returns before it says there is more. */
  pageSize = 3;
  /** What was asked, by kind: for tests that check how much work something takes. */
  calls: string[] = [];

  private id = (key: Item) => `${key.pk}\u0000${key.sk}`;

  private name(e: Expr, n: string): string {
    return n.startsWith('#') ? (e.ExpressionAttributeNames?.[n] ?? (() => { throw new Error(`no name ${n}`); })()) : n;
  }

  private value(e: Expr, v: string): unknown {
    if (!v.startsWith(':') || !(v in (e.ExpressionAttributeValues ?? {}))) throw new Error(`no value ${v}`);
    return e.ExpressionAttributeValues![v];
  }

  /** `attribute_not_exists(x)`, or `<name> = | < | > <value>`, joined by ` OR `. */
  private holds(cond: string | undefined, item: Item | undefined, e: Expr): boolean {
    if (!cond) return true;
    return cond.split(' OR ').some((clause) => {
      let m = /^attribute_not_exists\((\w+)\)$/.exec(clause);
      if (m) return !item || !(m[1] in item);
      m = /^(#?\w+) (=|<|>) (:\w+)$/.exec(clause);
      if (!m) throw new Error(`condition not understood: ${clause}`);
      const have = item?.[this.name(e, m[1])] as number | string | undefined;
      const want = this.value(e, m[3]) as number | string;
      if (have === undefined) return false;
      return m[2] === '=' ? have === want : m[2] === '<' ? have < want : have > want;
    });
  }

  private check(item: Item) {
    if (JSON.stringify(item).length > 400 * 1024) throw error('ValidationException', { message: 'Item size has exceeded the maximum allowed size' });
  }

  private put(input: { Item: Item; ConditionExpression?: string } & Expr) {
    const key = this.id(input.Item);
    if (!this.holds(input.ConditionExpression, this.items.get(key), input)) throw error('ConditionalCheckFailedException');
    this.check(input.Item);
    this.items.set(key, structuredClone(input.Item));
  }

  private update(input: { Key: Item; UpdateExpression: string; ConditionExpression?: string } & Expr) {
    const key = this.id(input.Key);
    const item = this.items.get(key);
    if (!this.holds(input.ConditionExpression, item, input)) throw error('ConditionalCheckFailedException');
    // like the real thing, an update makes the item if there is none
    const set = /^SET (#?\w+) = (:\w+)$/.exec(input.UpdateExpression);
    if (set) {
      const next = { ...(item ?? input.Key), [this.name(input, set[1])]: this.value(input, set[2]) };
      this.items.set(key, next);
      return next;
    }
    // a counter: `ADD n :one SET ttl = :ttl`
    const add = /^ADD (#?\w+) (:\w+) SET (#?\w+) = (:\w+)$/.exec(input.UpdateExpression);
    if (!add) throw new Error(`update not understood: ${input.UpdateExpression}`);
    const n = this.name(input, add[1]);
    const next = { ...(item ?? input.Key), [n]: ((item?.[n] as number | undefined) ?? 0) + (this.value(input, add[2]) as number), [this.name(input, add[3])]: this.value(input, add[4]) };
    this.items.set(key, next);
    return next;
  }

  private delete(input: { Key: Item }) {
    this.items.delete(this.id(input.Key));
  }

  /** The items a key condition picks out, in order of the sort key. */
  private matching(input: { KeyConditionExpression: string } & Expr): Item[] {
    const pk = /^pk = (:\w+)/.exec(input.KeyConditionExpression);
    const begins = /AND begins_with\(sk, (:\w+)\)$/.exec(input.KeyConditionExpression);
    const between = /AND sk BETWEEN (:\w+) AND (:\w+)$/.exec(input.KeyConditionExpression);
    if (!pk || (!begins && !between)) throw new Error(`key condition not understood: ${input.KeyConditionExpression}`);
    const p = this.value(input, pk[1]);
    return [...this.items.values()]
      .filter((it) => it.pk === p)
      .filter((it) => {
        const sk = it.sk as string;
        if (begins) return sk.startsWith(this.value(input, begins[1]) as string);
        return sk >= (this.value(input, between![1]) as string) && sk <= (this.value(input, between![2]) as string);
      })
      .sort((a, b) => ((a.sk as string) < (b.sk as string) ? -1 : 1));
  }

  private page(all: Item[], start: Item | undefined, filter: (it: Item) => boolean) {
    const from = start ? all.findIndex((it) => this.id(it) === this.id(start)) + 1 : 0;
    const slice = all.slice(from, from + this.pageSize);
    const more = from + this.pageSize < all.length;
    return { Items: slice.filter(filter).map((it) => structuredClone(it)), LastEvaluatedKey: more ? { pk: slice[slice.length - 1].pk, sk: slice[slice.length - 1].sk } : undefined };
  }

  async send(command: { constructor: { name: string }; input: never }): Promise<unknown> {
    const kind = command.constructor.name;
    this.calls.push(kind);
    const input = command.input as any;
    switch (kind) {
      case 'GetCommand': {
        const item = this.items.get(this.id(input.Key));
        return { Item: item && structuredClone(item) };
      }
      case 'PutCommand':
        this.put(input);
        return {};
      case 'UpdateCommand': {
        const next = this.update(input);
        if (input.ReturnValues && input.ReturnValues !== 'UPDATED_NEW') throw new Error(`ReturnValues not understood: ${input.ReturnValues}`);
        return input.ReturnValues ? { Attributes: structuredClone(next) } : {};
      }
      case 'DeleteCommand':
        this.delete(input);
        return {};
      case 'BatchGetCommand': {
        const [table, req] = Object.entries(input.RequestItems)[0] as [string, { Keys: Item[] }];
        if (req.Keys.length > 100) throw error('ValidationException');
        return { Responses: { [table]: req.Keys.map((k) => this.items.get(this.id(k))).filter(Boolean).map((it) => structuredClone(it)) } };
      }
      case 'QueryCommand': {
        let filter = (_: Item) => true;
        if (input.FilterExpression) {
          const f = input.FilterExpression as string;
          filter = (it) => this.holds(f, it, input);
        }
        return this.page(this.matching(input), input.ExclusiveStartKey, filter);
      }
      case 'ScanCommand': {
        const all = [...this.items.values()];
        return this.page(all, input.ExclusiveStartKey, (it) => this.holds(/^sk = (:\w+)$/.test(input.FilterExpression) ? input.FilterExpression : (() => { throw new Error('scan filter'); })(), it, input));
      }
      case 'TransactWriteCommand': {
        type Op = { Put?: { Item: Item }; Update?: { Key: Item }; Delete?: { Key: Item } };
        const ops = input.TransactItems as Op[];
        const keys = ops.map((o) => this.id(o.Put?.Item ?? o.Update?.Key ?? o.Delete!.Key));
        if (new Set(keys).size !== keys.length) throw error('ValidationException', { message: 'Transaction request cannot include multiple operations on one item' });
        if (ops.length > 100) throw error('ValidationException');
        const reasons = ops.map((o, i) => {
          const one = (o.Put ?? o.Update ?? o.Delete) as unknown as { ConditionExpression?: string } & Expr;
          return { Code: this.holds(one.ConditionExpression, this.items.get(keys[i]), one) ? 'None' : 'ConditionalCheckFailed' };
        });
        if (reasons.some((r) => r.Code !== 'None')) throw error('TransactionCanceledException', { CancellationReasons: reasons });
        const saved = new Map(this.items);
        try {
          for (const o of ops) {
            if (o.Put) this.put({ ...o.Put, ConditionExpression: undefined });
            else if (o.Update) this.update({ ...(o.Update as unknown as Parameters<FakeDynamo['update']>[0]), ConditionExpression: undefined });
            else this.delete(o.Delete!);
          }
        } catch (e) {
          this.items = saved;
          throw e;
        }
        return {};
      }
      default:
        throw new Error(`command not understood: ${kind}`);
    }
  }
}
