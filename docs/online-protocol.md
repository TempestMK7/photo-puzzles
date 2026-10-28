# Online play: the protocol

What the game and the server say to each other when friends play one Jigsaw puzzle together. The types are in `src/online/protocol.ts`, the rules a room enforces are in
`src/core/jigsawRoom.ts` (which both the server and the tests run), and the plan this belongs to is `online-play-plan.md`. Version 1.

## What makes two screens show the same puzzle

A puzzle is the same puzzle for everyone when they start from the same **setup**: `{ kind, seed, width, height, opts }`, where `width` and `height` are the size of the picture
the server hands out (everyone downloads the same file, so everyone decodes the same size) and `opts` are the difficulty options the creator chose (pieces, placed, edges,
turning, snap). `buildJigsaw(setup)` in `src/core/jigsawSetup.ts` makes the pieces, their shapes and their starting places from that and nothing else. The game on a screen and
the server both call it. Checked in Phase 0:

- It does **not** depend on the screen. The table is measured in picture pixels (4 puzzle widths by 4 puzzle heights); the camera (zoom, pan, fit) is each player's own.
- Display options (light background, vibration, offset) are not part of the setup. Each player keeps their own.
- The generator is integer arithmetic (`mulberry32`) and the layout only uses `sqrt`, `round` and `floor`, so every browser and Node give the same result. `tests/jigsawRoom.test.ts`
  holds the hashes of five start states taken before the code was moved, so a change that alters a start state (which would also break saved puzzles and shared seeds) fails.
- One thing **did** depend on the screen: how close two pieces have to be to join (`tolerance`) depends on the zoom. It is now part of the operation (`tol`) and the room clamps it
  to between 0.2 and 0.5 of a piece, so the room decides, within what any screen could ask.
- A 1,000-piece puzzle's saved state is about 90 KB as JSON (more than first guessed; still far inside DynamoDB's 400 KB item). Writing the whole thing on every drop is fine at
  this size; storing only what changed is the way out if it ever costs too much.

## The board is changed by operations

Everything another player has to see is one of three operations (`JigsawOp`):

| op | meaning |
|---|---|
| `grab gid` | the group is picked up (goes to the front) |
| `drop gid dx dy rot tol` | the group is put down at that pose; with `tol` it then joins whatever it lies right against |
| `rotate gid tol` | a loose group is turned a quarter turn about its middle (a selected piece, not one in hand); with `tol` it then joins |

`applyOp(game, op)` applies one. The room applies it to its own board, and the same `op` goes out in the event, so every screen that applies it ends up with the same board
(group ids included: the bigger group keeps its id when two join). `tests/jigsawRoom.test.ts` plays whole games with three players and checks, after every event, that a copy of the
board that only applied the events equals the room's board.

Moving a piece **while it is in hand** is not an operation. It shows only on the holder's screen and, as hand messages, on the others'; the `drop` says where it ended. A piece turned
while in hand is the same: it only shows up as the `rot` of the drop.

A selection (the glow on a piece) stays on the player's own screen. Only a piece **in hand** is exclusive.

## One hand

The room keeps `lock = { holder, gid, until }`.

- `grab`: refused with `busy` (and who) while another player's lock is live (`until` is in the future). Otherwise the lock is taken for `LOCK_MS` (10 s).
- The holder renews it every `RENEW_INTERVAL_MS` (4 s) while the piece is in hand (`renew`). It does not change the board and is not an event.
- `drop`: only by the holder of that group; it ends the lock. `release`: lets go with no operation (an aborted drag).
- `rotate`: refused while someone else holds a piece, or while the player holds another one.
- A lock that ran out **belongs to nobody**: the next `grab` simply succeeds. No timer, no "player left" message is needed. The holder of an expired lock who comes back before
  anyone grabbed may still drop. Presence ("client disconnected") can free the lock sooner but is not needed for correctness.
- When someone else's `grab` event arrives, a screen forgets any hand pose it was showing for the previous holder and shows the group where the board has it.

When the last piece joins, the event says `solved` and the room refuses everything else (`ended`).

## Events, order, catching up

Every accepted command is one event `{ v, by, op?, lock, joins, solved }`, and `v` goes up by exactly one. A screen that sees `v` skip, or comes back after being away, asks for the
whole state (`RoomState`, in the room descriptor) and starts from that. A screen applies its own commands at once (so it feels immediate) and takes the room's answer as the truth;
a refusal means "ask for the state again".

A lock's `until` is on the server's clock. The descriptor carries `serverTime`; a game works out its clock's offset from it (`lockHeld`).

## Live messages (MQTT topics)

- `puzzle/{room}/events`: the server publishes `RoomMessage`s (an event, a player joined or left, a knock, solved, closed). Every member subscribes.
- `puzzle/{room}/hand/{player}`: the player in hand publishes a `HandMessage` (group, pose, a counter) about every `HAND_INTERVAL_MS` (100 ms), only while the piece moves.
  A member may publish only on their own topic and subscribe to `puzzle/{room}/#` of the rooms they belong to; the IoT authorizer builds that policy from the room's members.
  Others ignore hand messages from anyone who is not the current lock holder. Hand messages never change the board.

## Requests (HTTP, with the player's sign-in token)

Every request carries `protocol`; a server that no longer understands it answers `update-required`.

- `POST /rooms` `CreateRoomRequest` -> the room id, a signed upload address for the picture, and the invite (`code`, `secret`, `link`). The request must say `consent: true`.
- `POST /join` `{ code, secret? }` -> `RoomDescriptor`. With the secret (the link) the player is in at once. With only the code the room publishes a `knock` and a member answers.
- `GET /rooms` -> the player's rooms (`RoomSummary`). `GET /rooms/{id}` -> `RoomDescriptor`.
- `POST /rooms/{id}/command` `Command` -> `{ ok, event }` or a refusal. `POST /rooms/{id}/renew`.
- `POST /rooms/{id}/leave`, `/close` (owner), `/invite/regenerate` (owner), `/members/{id}/remove` (owner), `/knock/{id}/answer`.

Failures are `{ ok: false, error }` with one of the `ApiError` values.

## Codes and links

A code is five digits. A link is `https://<domain>/#/join/<code>~<secret>`: it opens the web version and joins without a knock, and nothing after `#` is sent to a server. See
`parseInvite` and `inviteLink`. Typing a code alone knocks.

## Not decided here (Phase 1 and later)

- How the time shown for a puzzle is counted (it does not count towards best times).
- Whether hand messages should carry only the dragged group's pose or also the pointer.
- Other puzzle types: the operations and the room are Jigsaw's; the turn-based types will have their own.
