# Online play: the protocol

What the game and the server say to each other when friends play one puzzle together: a Jigsaw, or Tile Swap, Overlap or Strips. The types are in `src/online/protocol.ts`, the rules a room enforces are in
`src/core/jigsawRoom.ts` and `src/core/boardRoom.ts` (which both the server and the tests run), and the plan this belongs to is `online-play-plan.md`. Version 2 (1 had Jigsaw rooms only: a game that
old would take a room of another kind for a Jigsaw, so the server tells it to update).

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

Everything another player has to see is one of these operations (`JigsawOp`; the tray ones are under "Sorting trays" below). A group is named by one of its **pieces**, not by its group number: the room is saved and loaded again between commands, which renumbers the groups, while piece numbers never change.

| op | meaning |
|---|---|
| `grab piece` | the group is picked up (goes to the front) |
| `drop piece dx dy rot tol` | the group is put down at that pose; with `tol` it then joins whatever it lies right against |
| `rotate piece tol` | a loose group is turned a quarter turn about its middle (a selected piece, not one in hand); with `tol` it then joins |
| `hint piece` | the group the piece belongs to goes where it belongs in the picture and stays there (refused with `busy` while another player has chosen it, `no-group` if it is in the picture already) |
| `bomb x y` | every group with a piece whose cell lies within a piece's width of the point (picture pixels from the picture's top left) goes in the picture, whoever has a hand on it (a hold on a group that was placed is let go); `no-group` when none was left |

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

## Sorting trays

A puzzle has up to `TRAY_MAX` (10) sorting trays, a list shared by everybody (`game.trays`, ids in list order; a new puzzle has one). A group lies in a tray (`Group.tray` = the tray's id) or on the table (`-1`); a group in a tray is out of the board, and a piece that belongs to the picture cannot be put in one. Groups that lie in the **same tray** join each other exactly as they do on the table (the same offsets, the same tolerance: the poses are in the tray's space, which is measured in the same picture pixels); a group in a tray never joins one on the table, nor one in another tray, and the joined group stays in the tray.

| op | meaning |
|---|---|
| `trayAdd` | adds a tray (refused when there are 10); the room's event gives it the next id, so every screen ends up with the same ids |
| `trayRemove tray` | takes a tray away; refused (`bad`) unless it is empty |
| `drop piece dx dy rot tol tray` | with `tray` the pose is in that tray's own space (below); the group's middle must lie inside it; with `tol` it then joins what it lies right against in that tray |

**One space for every screen.** A tray is a fixed logical rectangle, `traySize(cols, size)` in picture pixels (origin at its top left, a group's pose `dx dy rot` is as on the table). The rectangle is 2:1 and about as big as 10 pieces across or 0.7 of the puzzle's width, whichever is more. Each screen fits that rectangle into a panel (`trayView` in `src/core/trays.ts`) that is as large as the tray allows within half the width and half the height of the canvas (landscape) or the full width and half the height (portrait), beside the 46 px bar of trays and under a 34 px header. The panel is cut to the tray's shape, so there are no empty bars in it. Only the scale and the size of the panel differ between screens, never the positions, so a piece lies at the same place of the tray on a phone and on a wide monitor. Which tray is open is each screen's own business (nothing is sent); a piece that is moved around in a tray is shown to the others like one on the table (hand messages carry `tray`), and a `drop` into or out of a tray is an event like any other.

## Events, order, catching up

Every accepted command is one event `{ v, by, op?, lock, joins, groups, solved }`, and `v` goes up by exactly one. A screen that sees `v` skip, or comes back after being away, asks for the
whole state (`RoomState`, in the room descriptor) and starts from that. `groups` is how many groups the board has after the event: a screen that counts a different number (while none of its own
moves are on their way) has drifted and asks for the whole state too. A screen applies its own commands at once (so it feels immediate) and takes the room's answer as the truth;
a refusal means "ask for the state again".

A lock's `until` is on the server's clock. The descriptor carries `serverTime`; a game works out its clock's offset from it (`lockHeld`).

## Tile Swap, Overlap and Strips

`RoomSettings.kind` says which puzzle a room has (`jigsaw`, `focus`, `overlap` or `strips`); the rest of `settings` is the same: `{ seed, width, height, opts }`, and `opts` holds what the size sets as plain numbers
(Tile Swap `pieces`; Overlap `total` and `stacks`; Strips `cells`, `length` and `tabs`) with the puzzle's own options (`irregular`; `turned`, `windows`, `placed`; `placed`). `buildBoard(setup)` in `src/core/boardRoom.ts`
makes the board from that and nothing else, as `buildJigsaw` does for a Jigsaw; the server refuses (`bad-request`) a size it will not keep (over `jigsawPieces` pieces or cells is `limit`) and a picture that cannot be cut.

**Nobody holds a piece.** These puzzles have no hand, no lock and no reservation (`lock` is always `null`, `reserved` empty, `renew` is `not-holder`, and there are no hand messages): everybody may move anything at any time,
and a piece that is being dragged is on its player's screen only. What a player does when they put something down is one operation (`BoardOp`), applied at once on their own screen and sent as a command:

| op | puzzle | meaning |
|---|---|---|
| `swap a b` | Tile Swap | pieces `a` and `b` trade places (neither may be in its own place) |
| `put piece x y` | Overlap | the piece is put down with its centre on cell (x, y): it stays if that is its place and it is turned right (else it is back on its stack, and nothing is sent) |
| `turn piece` | Overlap | a quarter turn |
| `toStack piece stack` | Overlap | the piece goes on top of another stack |
| `cycle stack dir` | Overlap | the top piece of a stack goes to the bottom (`1`) or the bottom one to the top (`-1`) |
| `place strip x y angle tab` | Strips | the strip is put down at this pose, on top of the others, and locks if it lies where it belongs |
| `hint piece` | Tile Swap, Overlap, Strips | the piece (a strip, in Strips) is put where it belongs (in Tile Swap the piece that sat there takes its place); refused with `no-group` if it is there already |
| `bomb x y` | Tile Swap, Overlap, Strips | every piece round the point is put where it belongs; the point is in picture pixels (Tile Swap) or a cell (Overlap; Strips: of the field, with its margin). Refused with `no-group` when nothing was left to place |

`applyBoardOp(board, op)` applies one if the board allows it, on the server and on every screen. A refusal is `bad-request` when the numbers make no sense or the operation is another puzzle's, and `no-group` when it was fine but the
board has moved on (the piece was put in its place by someone else a moment ago): the screen says "Someone moved that piece first" and takes the room's board again.

**Order.** The events are in the server's order, and a screen applies its own operations at once, so two players who move the same thing in the same moment see them in different orders. The `OnlineRoom` of a game of this kind notes it when
another player's event arrives while its own commands are still on their way, and takes the room's board once they are all answered (`resync`). `groups` in an event is, for these puzzles, `boardCheck(board)`: a number of what the board
comes to (which piece is where, which stacks hold which pieces, which strips are locked), which a screen compares with its own to find that it has drifted, as a Jigsaw does with its group count. It leaves out what a player's own hand
changes before it is put down (where a strip being dragged is), so that a drag in progress is never taken for a drift.

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
- **A puzzle made from a video:** `CreateRoomRequest.video` `{ type, bytes, ms }` (`video/mp4` or `video/quicktime`: MP4 and MOV, which are what the check reads; the board's `width` and `height` are the video's). Only for paid accounts, the family and the operator (`403` `plan-required` for a free account), and a paid account pays a video credit for each one (see *Accounts and credits*); over `videoBytes` (250 MB) or `videoMs` (2 minutes) is `413` `too-big`. The answer's `upload` is `{ url, headers }`: the game `PUT`s the file **straight to storage** with exactly those headers (the address is signed for that size and kind; storage turns away any other). Then `POST /rooms/{id}/video` from the owner: the server checks the stored file is the size and kind that was said (else the room is thrown away) and starts Amazon Rekognition Video on **the whole file** (about ten cents a minute of video; a job id is kept in the room). The answer is `{ state: 'checking' }` while it goes on (a minute or two: the owner's game asks again every few seconds, sixty times in five minutes at most) and `{ state: 'ready' }` when it has passed, and only then can anyone join (`not-ready` before). A video with explicit, violent, disturbing or hateful content is `rejected` (`422`, the room is thrown away and the operator is told); one that the service cannot read (it reads **MP4 and MOV made with H.264**; HEVC from some phones fails) is `unreadable` (`422`); if the service cannot be asked the answer is `busy` and asking again is fine. The local server is sent the file itself at `PUT /media/{id}/video` and makes no check. **An admin account** (its record says so, or its token has the `admins` group) may make a video of any size up to 5 GB and any length; and what the **family's and the operator's accounts** send, picture or video, is not looked at by the automatic check (the room remembers that: it is not told to the other players); the size and kind of the stored file are still checked.
- **Accounts and credits.** Everybody, guests too, plays alone as much as they like and joins any puzzle. **Starting** a puzzle costs credits, and an account is one of four types (`ACCOUNT_TYPES` in `protocol.ts`; the rules are small functions there, which the game and the server both use): **free** (starts with `freePhotoCredits`, 5, photo credits; a puzzle from a picture costs 1; no video puzzles), **paid** (puzzles from pictures cost nothing; a puzzle from a video costs 1 video credit; each payment period gives `paidVideoCredits`, 20, which add to what is left and roll over for ever), **family** and **admin** (nothing costs anything, and what they send is not looked at by the automatic check; an admin can also use the admin page). A **guest** cannot start a puzzle (`account-required`) and has no credits: the game shows 0 and 0. Both kinds of credits are kept for every account whatever its type (so that an account that is made free again keeps its video credits, which it cannot use until it is paid again); the game shows the infinity sign for what its type does not spend. Credits never expire. `GET /me` and `PUT /me` answer with `account` (an `AccountSummary`: type, credits, whether each is infinite, ads left today), and so does a `POST /rooms` that made a puzzle, which also took the credit (just before the room is written; a puzzle that is not made costs nothing). Refusals: `402 no-credits` (with `credits`: `photo` or `video`, and `account`), `403 plan-required` (a video from a free account). The old weekly count of puzzles is gone. **A kept file that was not looked at** (it came from a family or admin account) can only be used for a new puzzle by another such account (`unauthorized` otherwise, and the game then sends its own copy, which is looked at).
- **Hints and bombs.** An account also holds hints and bombs (`AccountSummary.hints`, `bombs`, `hintsInfinite`, `bombsInfinite`; the operator's account is infinite): every account starts with `startHints` (10) and `startBombs` (2), whatever its type, and an account from before they existed is given those the first time it is read. They are used in a puzzle (`src/core/help.ts`: Tile Swap, Overlap, Strips and Jigsaw; not Sliding Tiles or Rotascope). **Alone:** `POST /items/use` `{ item: 'hint' | 'bomb' }` takes one (`402 no-credits` with `item` and `account` when there is none; `403 account-required` for a guest) and the game places the pieces after the answer; `POST /items/award` `{ size }` adds the hints of a solved puzzle (1 for size 0 and 1, S and M, 2 above; the server cannot see a puzzle on the player's device, so it believes the game) and answers `{ account, given }`: **a free account can earn `freeHintsPerDay` (10) hints a day** (the day is UTC; `AccountRecord.hintDay` and `hintsEarned` count what it has earned that day, and what it holds does not matter), so `given` may be less than the puzzle is worth, or 0; paid, family and admin accounts have no limit (`AccountSummary.earnPerDay`, `earnLeft`, `earnInfinite` say where an account stands; a guest earns none). **With friends:** `CreateRoomRequest.helpers` (the host's choice; off when left out) is kept in the room and shown as `RoomDescriptor.helpers`; a `hint` or `bomb` command in a room that has it off is `403 helpers-off`, from a guest `account-required`, from an account with none `no-credits`; otherwise the item is taken before the room is asked and given back if the room refuses the operation. When the puzzle is solved the server gives each member that is not a guest the hints it is worth (`hintsFor`, from the room's own numbers: pieces, cells or total up to what size M has is 1, more is 2), each as far as the daily limit above allows, before the event that says it is solved goes out (so that the game's next look at the account shows them). The operator sets an account's stock with the admin page (`POST /admin/account` takes `hints` and `bombs`).
- **Ads for hints and bombs.** The same flow as the credits below with `kind` `'hint'` or `'bomb'` (`AdKind`): a free account that watches one is given `adHints` (5) hints or `adBombs` (1) bomb. Instead of "no credits left" and a number a day there is one wait for both kinds: `AccountRecord.helpAdAt` is when the next can be had, set when one is given to about `helpAdMs` (25 minutes) from then, made random from 0.8 to 1.2 times it, 20 to 30 minutes (`random.below`); an account that has not had one can have its first `helpAdFirstMs` (15 minutes) after it was made (`createdAt`), a paid one too. It is apart from the daily count of ads for credits (`adsPerDay`); an ad asked for sooner is `409 ad-refused` with `reason: 'wait'` (so no ad is shown for nothing), and the grant is checked again when the network reports the ad. The account says where it stands with `helpAdReady`, `helpAdIn` (ms left, by the server's count, so that no clock has to agree), `helpAdHints`, `helpAdBombs` and `helpAdNoAd`. These do not use up the daily limit of hints earned by solving puzzles. **A paid, family or admin account is given them without an ad:** `POST /items/reward` `{ item }` (an account's token) answers `{ account }`, or `409 ad-refused` with `reason` `wait` (not ready), or `watch` for a free account (it has to watch). A guest has no account to give them to (`account-required`).
- **Ads for credits.** In the Android and iOS apps (Steam, itch and the web page have no ads: their rules, or no ad network), a free account that has **no photo credits left** can watch a rewarded ad for `adPhotoCredits` (5), up to `adsPerDay` (5) a day (from midnight UTC); a paid account that has **no video credits left** can watch one for `adVideoCredits` (1), up to `videoAdsPerDay` (5) a day. **The credits are given by the ad network's report, not by the game** (server-side verification, AdMob's):
  1. `POST /credits/ad/start` `{ kind, platform: 'android' | 'ios' }` (an account's token; an ad that would earn nothing is not shown) answers `{ nonce, mode, account }`, or `409 ad-refused` with `reason`: `has-credits`, `daily-limit`, `platform`, `plan` (this type gets nothing for ads); `503 ads-off` when the server has no way to believe an ad (no ad units are set, and `adsTrusted` is 0). `nonce` is a one-time number (good for 30 minutes) kept with the account and the kind.
  2. The game calls `PhotoPuzzlesNative.showRewardedAd(kind, nonce)`; the app shows the ad with `nonce` as its **custom data** and no user id (the account's id is not sent to the ad network), and tells the page how it went with the window event `photopuzzles-ad` (`{ kind, rewarded, error? }`; see `src/platform.ts`, `android/README.md`).
  3. When the ad was watched to the end AdMob calls `GET /credits/ad/callback?...&signature=...&key_id=...` (no sign-in: the call is signed with ECDSA over the query string before `&signature=` **with its percent-escapes decoded** (`reward_item=Photo%20Credit` is signed as `Photo Credit`), checked against the keys AdMob publishes, for one of our ad units `ADMOB_AD_UNITS`, not older than a day: `server/src/admob.ts`). Each `transaction_id` counts once (AdMob repeats a call that was not answered with 200). The nonce is matched to its account, the rules are looked at again (no credits left, ads left today), and the credits are given. A call that is **genuine** (AdMob signed it) is always answered 200, even one that earns nothing (it is for another ad unit, it is old, nobody asked for it, the account has credits now): it is logged as `callback-ignored` (with `why`) or `reward-unclaimed`. One that is **not genuine** is `403` and logged as `callback-refused` with the `reason` (`unsigned`, `unknown-key`, `bad-signature`) and the query as it came.
  4. The game waits (the dialog says "Adding your credits…") and asks `GET /me` every two seconds, about thirty seconds, until the credits are there.
  With the limit `adsTrusted` set to 1 (for trying things out) `start` answers `mode: 'trusted'`, and the game asks for the credits itself with `POST /credits/ad` `{ kind, platform }`: anyone who can call the API could then give themselves credits, so it is off unless it is set. The local server (`npm run server`) believes the game; with `FAKE_ADMOB=1` it stands in for AdMob instead (`/dev/fake-admob?nonce=...` reports an ad as watched, signed with a key made at start-up), which is how the real flow is tried in a browser with a pretend shell.
- **Kept files: making another puzzle from the same picture.** When a picture (or video) has passed the check, the server keeps a copy of it as a **file** with an id of its own (`media.fileId` of the room descriptor, which every member gets; nothing for a video an administrator made unchecked, or when `fileKeepMs` is 0). The puzzle has a picture of its own as before and ends as before; the file is separate. A game that keeps the picture in its library keeps the id with it (the owner's game after making the puzzle; another player's when they save the picture of a puzzle they joined), and makes the next puzzle with `CreateRoomRequest.fileId` instead of a picture: `POST /rooms` with `fileId` (and `settings` of the file's own width and height) answers with no `upload`, the room is ready at once (nothing is sent or looked at again, and a video starts from its beginning), and it counts as one of the puzzles of the week like any other (and as a video, for a video). The answer `403 unauthorized` is for a file the player never sent and never joined a puzzle made from (a guest is not recorded: a guest cannot make puzzles); `410 file-gone` for an id the server does not hold (any more), whose stored picture has gone, or whose size is not the settings': the game forgets the id and sends the picture as usual. **How long:** a file is kept `fileKeepMs` (a week) after it was last used to make a puzzle (making a puzzle from it starts the week again), and there is no longest: a picture that keeps being used is kept. It goes at once with the account that sent it, with a ban, and when the operator ends a puzzle for its picture or deletes the file. The table's own expiry (and the stream that deletes the storage's copy) can be up to two days late; the service never uses a file after its time. The admin page's **Files** tab lists them, newest first, as thumbnails (`GET /admin/files`, `POST /admin/file/{id}/remove`).
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
`PORT` and `WEB_BASE` change it, and `ACCOUNT_TYPE=paid npm run server` (free, paid, family or admin) makes every account here that type, to try what each can do; an ad is believed here). `npm run dev` then shows **Play with friends** on the main screen. There is no real sign-in: each browser tab is a player of its own
(`dev:<id>:<name>`), which is what makes two tabs two players; the panel can sign that identity out, and then the tab is a guest (`POST /guest`), which is how guests are tried without a sign-in service. Stopping the server forgets every room.

The server is built from interfaces (`server/src/types.ts`: store, media, publish/subscribe, presence, clock, random) so that the cloud can fill them with DynamoDB, S3 and IoT Core.
`RoomService` is every request as a method; `router.ts` turns an HTTP request into a call and has nothing of Node in it; `local.ts` is the Node part.

## Codes and links

A code is five digits. A link is `https://<domain>/#/join/<code>~<secret>`: it opens the web version and joins without a knock, and nothing after `#` is sent to a server. See
`parseInvite` and `inviteLink`. Typing a code alone knocks.

## Not decided here (Phase 1 and later)

- How the time shown for a puzzle is counted (it does not count towards best times).
- Whether hand messages should carry only the dragged group's pose or also the pointer.
- Showing the others a piece in hand in Tile Swap, Overlap and Strips (there are no hand messages for them): a piece appears on the others' screens when it is put down.
