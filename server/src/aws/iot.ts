import { PublishCommand, type IoTDataPlaneClient } from '@aws-sdk/client-iot-data-plane';
import type { PubSub } from '../types';

const enc = new TextEncoder();

/** What is published for a room reaches everyone who is subscribed to its topic (IoT Core's broker does the fan-out). */
export class IotPubSub implements PubSub {
  constructor(private readonly iot: IoTDataPlaneClient) {}

  async publish(topic: string, message: unknown): Promise<void> {
    // QoS 0: a player who missed a message sees a gap in the version numbers and asks for the whole room again
    await this.iot.send(new PublishCommand({ topic, qos: 0, payload: enc.encode(JSON.stringify(message)) }));
  }
}
