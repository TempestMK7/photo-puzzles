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

Everything another player has to see is one of three operations (`JigsawOp`). A group is named by one of its **pieces**, not by its group number: the room is saved and loaded again between commands, which renumbers the groups, while piece numbers never change.

| op | meaning |
|---|---|
| `grab piece` | the group is picked up (goes to the front) |
| `drop piece dx dy rot tol` | the group is put down at that pose; with `tol` it then joins whatever it lies right against |
| `rotate piece tol` | a loose group is turned a quarter turn about its middle (a selected piece, not one in hand); with `tol` it then joins |

`applyOp(game, op)` applies one. The room applies it to its own board, and the same `op` goes out in the event, so every screen that applies it ends up with the same board
(group ids included: the bigger group keeps its id when two join). `tests/jigsawRoom.test.ts` plays whole games with three players and checks, after every event, that a copy of the
board that only applied the events equals the room's board.

Moving a piece **while it is in hand** is not an operation. It shows only on the holder's screen and, as hand messages, on the others'; the `drop` says where it ended. A piece turned
while in hand is the same: it only shows up as the `rot` of the drop.

A selection (the glow on a piece) stays on the player's own screen. Only a piece **in hand** is exclusive.

## One hand

The room keeps `lock = { holder, piece, until }`.

- `grab`: refused with `busy` (and who) while another player's lock is live (`until` is in the future). Otherwise the lock is taken for `LOCK_MS` (10 s).
- The holder renews it every `RENEW_INTERVAL_MS` (4 s) while the piece is in hand (`renew`). It does not change the board and is not an event.
- `drop`: only by the holder of that group; it ends the lock. `release`: lets go with no operation (an aborted drag).
- `rotate`: refused while someone else holds a piece, or while the player holds another one.
- A lock that ran out **belongs to nobody**: the next `grab` simply succeeds. No timer, no "player left" message is needed. The holder of an expired lock who comes back before
  anyone grabbed may still drop. Presence ("client disconnected") can free the lock sooner but is not needed for correctness.
- When someone else's `grab` event arrives, a screen forgets any hand pose it was showing for the previous holder and shows the group where the board has it.

### The piece a player has chosen

Besides the hand, every player may have **one piece reserved** (`reserved: [{ holder, piece, until }]` in the room's state, and the whole current list in every event, which a screen takes in place of what it had). It is the piece that a player picked up last or clicked on, and it is theirs until they click somewhere else (`unselect`), pick up another piece, or `RESERVE_MS` (15 s) pass since they last touched it; nobody has to renew it. While it is reserved no other player can `grab`, `select` or `rotate` it (`busy`, with the holder); the others see it in the holder's colour. `select` `{ piece }` reserves a piece without picking it up (nothing changes on the board); `release` and `drop` keep the reservation (and start the time again) unless the piece has become part of the picture; `unselect` lets it go. A player who leaves, or is sent out, loses it (no event: the others' copy runs out by itself). A room from before reservations has none. The hand is still one for the whole room.

When the last piece joins, the event says `solved` and the room refuses everything else (`ended`).

## Events, order, catching up

Every accepted command is one event `{ v, by, op?, lock, joins, groups, solved }`, and `v` goes up by exactly one. A screen that sees `v` skip, or comes back after being away, asks for the
whole state (`RoomState`, in the room descriptor) and starts from that. `groups` is how many groups the board has after the event: a screen that counts a different number (while none of its own
moves are on their way) has drifted and asks for the whole state too. A screen applies its own commands at once (so it feels immediate) and takes the room's answer as the truth;
a refusal means "ask for the state again".

A lock's `until` is on the server's clock. The descriptor carries `serverTime`; a game works out its clock's offset from it (`lockHeld`).

## Live messages (MQTT topics)

- `puzzle/{room}/events`: the server publishes `RoomMessage`s (an event, a player joined, left or was sent out (`removed`), a knock, solved, closed, `renewed` when the holder of a piece renews the hold, so that the others' copy of it does not run out, and `played` when the count of time spent on the puzzle starts or stops: it counts only while at least one player is connected, `solved` carries the total). Every member subscribes.
- `puzzle/{room}/hand/{player}`: the player in hand publishes a `HandMessage` (group, pose, a counter) about every `HAND_INTERVAL_MS` (100 ms), only while the piece moves.
  A member may publish only on their own topic and subscribe to `puzzle/{room}/#` of the rooms they belong to; the IoT authorizer builds that policy from the room's members.
  Others ignore hand messages from anyone who is not the current lock holder. Hand messages never change the board.

## Requests (HTTP, with the player's token)

Every request carries `protocol`; a server that no longer understands it answers `update-required`.

The token is an account's (a Cognito ID token) or a guest's. **A guest can join and play but cannot make a puzzle** (`account-required`).

- `POST /guest` `{ token? }` -> `{ token, id, expiresAt }`, with no sign-in: a token for a new guest, or (when the old one is shown and is still good) a new one for the same guest. A guest's id starts with `g`.
- `GET /me` -> `{ id, name, guest }`; `name` is nothing until the player has chosen one. `PUT /me` `{ name }` -> the same: the name the other players see (at most 24 characters, no control characters). `POST /me/delete` -> `{ ok }`: the player is forgotten. The puzzles they made end (and their pictures go), they leave the others (which go on with a new owner), their name and the record of puzzles made are deleted, and then the account itself in the user pool (nothing for a guest, who has none). `busy` means the account could not be deleted this time: everything else is done, and asking again finishes it.

- `POST /rooms` `CreateRoomRequest` -> the room id, a signed upload address for the picture, and the invite (`code`, `secret`, `link`). The request must say `consent: true`. The picture then goes by `PUT` to that address (JPEG or PNG, at most a few MB, and the size the puzzle was made for, or the room is thrown away); only then can anyone join (`not-ready` before). In the cloud the picture is also looked at by Amazon Rekognition before it is stored: a picture with explicit, violent, disturbing or hateful content is turned down (`rejected`, `422`: the room is thrown away, nothing is kept, the operator is told what was found), and if the look cannot be made the answer is `busy` and the same picture may be sent again (the game does that twice by itself).
- **A puzzle made from a video:** `CreateRoomRequest.video` `{ type, bytes, ms }` (`video/mp4` or `video/quicktime`: MP4 and MOV, which are what the check reads; the board's `width` and `height` are the video's). Switched off (`503` `video-off`) until the operator sets `videoRoomsPerWeek` above 0; over `videoBytes` (250 MB) or `videoMs` (2 minutes) is `413` `too-big`; the weekly count of videos is its own (`quota`, besides the picture puzzles' three). The answer's `upload` is `{ url, headers }`: the game `PUT`s the file **straight to storage** with exactly those headers (the address is signed for that size and kind; storage turns away any other). Then `POST /rooms/{id}/video` from the owner: the server checks the stored file is the size and kind that was said (else the room is thrown away) and starts Amazon Rekognition Video on **the whole file** (about ten cents a minute of video; a job id is kept in the room). The answer is `{ state: 'checking' }` while it goes on (a minute or two: the owner's game asks again every few seconds, sixty times in five minutes at most) and `{ state: 'ready' }` when it has passed, and only then can anyone join (`not-ready` before). A video with explicit, violent, disturbing or hateful content is `rejected` (`422`, the room is thrown away and the operator is told); one that the service cannot read (it reads **MP4 and MOV made with H.264**; HEVC from some phones fails) is `unreadable` (`422`); if the service cannot be asked the answer is `busy` and asking again is fine. The local server is sent the file itself at `PUT /media/{id}/video` and makes no check.
- **Where the video is:** the descriptor of a video puzzle has `playback` `{ pos, paused, at }` (the host's last word, `at` on the server's clock; `playbackNow` in `protocol.ts` says where it is now). The owner (the host) says it with `POST /rooms/{id}/playback` `{ pos, paused }` (when the video is played, paused or moved, and now and then; sixty a minute) and everyone hears `{ t: 'playback', pos, paused, at }` on the room's topic. If the owner leaves, the next owner is the host.
- **Limits per address:** `POST /guest` (a new guest), `POST /join` (after tries at a code that found nothing, per address and per player) and `POST /rooms` answer `429` `rate-limited` with `retryAt` (when the window ends) once an address has used up its share. See `DEFAULT_RATES` in `server/src/ratelimit.ts`. The local server has no limits.
- `POST /join` `{ code, secret? }` -> `RoomDescriptor`. With the secret (the link) the player is in at once. With only the code the room publishes a `knock` and a member answers.
- `GET /rooms` -> the player's rooms (`RoomSummary`). `GET /rooms/{id}` -> `RoomDescriptor`.
- `POST /rooms/{id}/command` `Command` -> `{ ok, event }` or a refusal. `POST /rooms/{id}/renew`.
- `POST /rooms/{id}/leave`, `/close` (owner), `/invite/regenerate` (owner), `/members/{id}/remove` (owner: sends a member out for good: that player's id is kept in the room and the code, a new code and the link all answer `403` `removed`), `/knock/{id}/answer`, `/report` (a member: `{ reason, note? }` with a reason of `illegal`, `adult`, `harassment`, `copyright` or `other` and a note of at most 300 characters; five an hour per player, then `429` `rate-limited`). A report is kept for 90 days with who was in the puzzle, and the operator is e-mailed (the alarm topic). Nothing happens to the puzzle by itself.
- **Banned players:** the operator can stop a player (`banned`, `403`): they leave every puzzle, the ones they made end, and every request but `/me` (and deleting their account) is refused. See the operator's function in `infra/README.md`.

Failures are `{ ok: false, error }` with one of the `ApiError` values.

## Trying it on this machine

`npm run server` starts the same `RoomService` that the cloud will run, on memory, at http://localhost:8787 (HTTP for the requests, a WebSocket at `/ws` in place of the cloud's publish/subscribe;
`PORT`, `WEB_BASE` and `FREE_ROOMS_PER_WEEK` change it). `npm run dev` then shows **Play with friends** on the main screen. There is no real sign-in: each browser tab is a player of its own
(`dev:<id>:<name>`), which is what makes two tabs two players; the panel can sign that identity out, and then the tab is a guest (`POST /guest`), which is how guests are tried without a sign-in service. Stopping the server forgets every room.

The server is built from interfaces (`server/src/types.ts`: store, media, publish/subscribe, presence, clock, random) so that the cloud can fill them with DynamoDB, S3 and IoT Core.
`RoomService` is every request as a method; `router.ts` turns an HTTP request into a call and has nothing of Node in it; `local.ts` is the Node part.

## Codes and links

A code is five digits. A link is `https://<domain>/#/join/<code>~<secret>`: it opens the web version and joins without a knock, and nothing after `#` is sent to a server. See
`parseInvite` and `inviteLink`. Typing a code alone knocks.

## Not decided here (Phase 1 and later)

- How the time shown for a puzzle is counted (it does not count towards best times).
- Whether hand messages should carry only the dragged group's pose or also the pointer.
- Other puzzle types: the operations and the room are Jigsaw's; the turn-based types will have their own.
