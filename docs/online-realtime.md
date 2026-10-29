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

## How it is wired (built, and checked against the real broker in dev)

**The connection.** A game opens a WebSocket to the account's IoT endpoint (`wss://<endpoint>/mqtt?x-amz-customauthorizer-name=puzzlevidio-<stage>&token=<Cognito ID token>&room=<room id>`, subprotocol `mqtt`) and
connects under the name `<room>:<player id>:<one per connection>` (`liveClientId` in `src/online/protocol.ts`). A browser cannot set headers on a WebSocket, which is why the token and the room are in the address;
the token lasts an hour. One connection per room: the game connects when it opens a room, which matches `Realtime.connect(roomId)`.

**Who may do what** (`server/src/aws/authorizer.ts`, a Lambda that IoT calls when a connection opens and again every 10 minutes while it stays). It checks the token itself (an account's: `jwt.ts`, RS256 against the pool's keys,
issuer, app client, "ID token", not expired; a guest's: `guest.ts`, our own signature, not expired), reads who is in the room (one `GetItem`), and answers with a policy for that room alone:

| | allowed |
|---|---|
| connect | the client name `<room>:<player>:*`, with the player the token says |
| subscribe / receive | `puzzle/<room>/events` and `puzzle/<room>/hand/+` |
| publish | `puzzle/<room>/hand/<player>`, the player's own hand, and nothing else (so nobody can speak as the server on `events`) |

A player who leaves (or is removed) loses the connection at the next check, and every connection is dropped after an hour; the game connects again with a fresh token.

**Who is online** (`presence.ts`). The broker publishes `$aws/events/presence/connected|disconnected/<client name>` for every connection in the account (on by default). A topic rule hands them to a function that
keeps one item per connection (`ONLINE#<player>#<connection>`, two hours at most if a "disconnected" is lost) and publishes `{ t: 'presence', ... }` on the room's events topic: for every connect, and for a
disconnect only when it was the player's last. The rule sees the connections of every deployment in the account (dev and the real one share a broker), so the function ignores names of rooms that its own table does not have.

**What the first real run showed** (a hand-written MQTT 3.1.1 client from Node, real Cognito tokens, the dev account):
- All of the above worked as designed: a member gets in; a player who is not in the room, a forged token and a connection under someone else's name do not; publishing as the server, publishing on another player's hand,
  listening to another room and to `puzzle/#` are all refused (the broker drops the connection); presence is written, said to the room, and two tabs of one player count as one.
- IoT turns an authorizer's answer down unless `refreshAfterInSeconds` and `disconnectAfterInSeconds` are more than 5 minutes, **in a "no" as well**: a first version answered a refusal with zeros and was rejected as
  invalid. There is a test for it now.
- A refusal looks like a WebSocket that closes (code 1005) before the CONNACK, the same as a lost network. The game cannot tell them apart from the connection alone: when it keeps failing it should ask the API for the room
  (which says 403 or 404) before it says "you are not in this room".
- The authorizer's warm answer takes about 50 ms (median of ten calls); the slowest was about 1 s, a cold start (about 340 ms) plus its first look at the pool's keys, and a connection pays that at most once.
  The presence function takes about 90 ms. Both use well under 150 MB.
- Signing is off on the authorizer (a browser cannot sign an address), so anyone can ask IoT to call it; the function gives nothing to a call without a good token, but each call costs a Lambda run, and a WAF does not
  stand in front of the broker. Keep an eye on the invocation count of the authorizer.

**The game's client** (`src/online/mqtt.ts` and `iotRealtime.ts`) added 9 kB to the page (3.5 kB gzipped): a hundred lines of MQTT 3.1.1 at QoS 0 instead of a library. The game's own client has been run against the real dev broker (from Node): connect, subscribe, presence, hands both ways, a dropped connection coming back with a fresh token, and a refusal told from a lost network.

**Still not measured:** a round trip from a phone on mobile data to a laptop, and the client in a browser (it uses the browser's `WebSocket` with the same subprotocol and a binary type of `arraybuffer`; only Node's has been tried). If either looks bad, AppSync Events is the second choice, as above.
