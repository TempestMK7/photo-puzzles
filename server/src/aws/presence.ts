import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DescribeEndpointCommand, IoTClient } from '@aws-sdk/client-iot';
import { IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { parseLiveClientId, topics, type RoomMessage } from '../../../src/online/protocol';
import { systemClock } from '../memory';
import { setActive } from '../played';
import type { Clock, PubSub } from '../types';
import { DynamoPresence, DynamoStore } from './dynamo';
import { IotPubSub } from './iot';

/**
 * Who is connected, from the broker's own lifecycle events: a topic rule hands every "connected" and "disconnected" of the account to this function. The name a game connects under
 * (see `liveClientId`) says the room and the player; the function keeps one item per connection and tells the room when its player comes or goes. It also starts and stops the
 * room's count of time played (see `played.ts`): it starts when someone connects to a room that nobody was connected to, and stops when the last one has gone.
 */

export interface LifecycleEvent {
  clientId?: string;
  eventType?: string;
}

export interface PresenceDeps {
  presence: Pick<DynamoPresence, 'connected' | 'disconnected' | 'online'>;
  /** Only the rooms of this deployment count: the rule sees the events of every deployment in the account (dev and the real one share a broker). */
  rooms: Pick<DynamoStore, 'membersOf' | 'getRoom' | 'putRoom'>;
  pubsub: PubSub;
  clock: Clock;
}

export function makePresenceHandler(d: PresenceDeps) {
  return async (event: LifecycleEvent): Promise<void> => {
    const name = parseLiveClientId(event.clientId ?? '');
    if (!name || (event.eventType !== 'connected' && event.eventType !== 'disconnected')) return;
    if (!(await d.rooms.membersOf(name.room))) return;
    const say = (online: boolean) => d.pubsub.publish(topics.events(name.room), { t: 'presence', id: name.player, online } satisfies RoomMessage);
    const active = { store: d.rooms, pubsub: d.pubsub, clock: d.clock };
    if (event.eventType === 'connected') {
      const nobody = (await d.presence.online(name.room)).length === 0;
      await d.presence.connected(name.room, name.player, name.connection);
      await setActive(active, name.room, true, nobody);
      // said for every connection, and not only the first: two that begin together would each think the other was first, and the message does no harm twice
      await say(true);
    } else if (await d.presence.disconnected(name.room, name.player, name.connection)) {
      if ((await d.presence.online(name.room)).length === 0) await setActive(active, name.room, false);
      await say(false);
    }
  };
}

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

let run: Promise<ReturnType<typeof makePresenceHandler>> | undefined;

async function build(): Promise<ReturnType<typeof makePresenceHandler>> {
  const endpoint = (await new IoTClient({}).send(new DescribeEndpointCommand({ endpointType: 'iot:Data-ATS' }))).endpointAddress;
  if (!endpoint) throw new Error('IoT has no endpoint');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const table = need('TABLE_NAME');
  return makePresenceHandler({
    presence: new DynamoPresence(db, table, systemClock),
    rooms: new DynamoStore(db, table, systemClock),
    pubsub: new IotPubSub(new IoTDataPlaneClient({ endpoint: `https://${endpoint}` })),
    clock: systemClock,
  });
}

export const handler = async (event: LifecycleEvent): Promise<void> => {
  run ??= build().catch((e) => {
    run = undefined;                       // try again at the next event
    throw e;
  });
  return (await run)(event);
};
