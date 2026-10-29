# Live messages: AWS IoT Core or AppSync Events

Phase 2 of `online-play-plan.md` asked for a half-day spike before building on one of them. A spike means deploying both and measuring, which needs deploy rights that were not there when this was written, so this is a
**comparison from the documentation** (looked up in October 2026; check prices and limits again before relying on them), and a recommendation. Nothing was measured.

## What the game needs

Per room, up to 8 players. One of them holds a piece at a time and sends where it is about 10 times a second, only while it moves (`HAND_INTERVAL_MS`). Every committed move is published once. Messages are small
(under 1 KB, so one 5 KB meter unit). A player must hear only the rooms they are in, and may publish only their own hand. The server (Lambda) publishes the committed moves.

## Side by side

| | IoT Core (MQTT over WebSocket) | AppSync Events |
|---|---|---|
| Price of messages | $1 per million, metered per 5 KB | $1 per million "operations", metered per 5 KB |
| Price of connections | $0.08 per million connection-minutes; keep-alive pings are free | $0.08 per million connection-minutes; the page lists connect, subscribe and **ping** requests among the billed operations |
| Publishes per second, per connection | 100 (more are dropped) | 25 |
| Per account, default | 20,000 in and 20,000 out per second (adjustable); 500,000 connections | 10,000 events in and 1,000,000 out per second; 2,000 connects per second; 2,000 "request tokens" per second for publishes (all adjustable) |
| Subscriptions per connection | 50 | 200 |
| Who may do what | A **custom authorizer** (our Lambda) checks the sign-in token and returns an IAM policy that names the topics: subscribe to `puzzle/<room>/#` for rooms the player is in, publish only to `puzzle/<room>/hand/<player>` | Cognito user pool tokens directly, or a Lambda authorizer; channel namespaces with handlers (small JS) that can check or change a message |
| Knows that a player left | Lifecycle events (`disconnected`) can release a hold at once | Not that I found |
| Client | MQTT 3.1.1 over WebSocket: a library (tens of kB) or a small client of our own (connect, subscribe, publish at QoS 0, ping: about 150 lines) | Plain JSON over a WebSocket: no library |
| Publishing from Lambda | `iot-data` `Publish` | HTTP `POST` to the events endpoint |

## What it costs

The worst case for one room is someone dragging all the time: about 10 messages a second in, and each of the other 7 players receives it, so about 80 metered messages a second, 290,000 an hour: **about $0.30 per room-hour**
on either service. Real play is far below that (the hand is sent only while a piece moves), and committed moves are a handful a minute. A hundred rooms playing at once for an hour would be around $30 at that worst
case. Connection time is 8 cents per million minutes: a thousand players for an hour is half a cent. Idle, both cost nothing.

## Recommendation: IoT Core, behind the interfaces we already have

- Equal price, but IoT's pings are free, it allows four times the publishes per connection, and its **disconnect events** let a hold end the moment a phone drops out rather than after its 10-second expiry.
- Its authorization is the more exact fit: one policy per player that names the room topics, with no code running per message.
- AppSync Events is simpler to start (Cognito tokens straight in, no authorizer Lambda, no MQTT) and would be a fine second choice. What decided it was the lifecycle events and the headroom; neither is large.
- It is not a one-way door: the game talks to `Realtime` (`src/online/realtime.ts`) and the server to `PubSub` (`server/src/types.ts`). Switching is a new implementation of each, not a change of the rules.

**To settle once something is deployed** (two hours, not half a day): a round trip from a phone on mobile data to a laptop through IoT Core, the size of our MQTT client, and whether the custom authorizer is fast enough on a
cold start (it runs once per connection, not per message). If any of those looks bad, try AppSync Events the same way.
