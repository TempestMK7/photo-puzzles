# Online play with friends: plan

Status: plan only, nothing built yet. This file is the TODO list; tick items off as they land, and change it when a decision changes.

## What it is

Someone starts a Jigsaw puzzle, agrees that the picture goes to our server, and gets a 5-digit code and an invite link. Friends join with either. Everyone shares one board and
can move pieces, but only one person has a piece in hand at a time. Players can leave and come back until the puzzle is solved or has been idle for 24 hours. Solving it ends
the online puzzle: people still in it can watch the finished board until they leave, then the puzzle is gone from their list. Anyone can save the picture to their own library.

Local play stays exactly as it is: free, unlimited, no account, nothing leaves the device.

## Decisions already made

- **Puzzle types:** Jigsaw only at first. The turn-based types (Sliding Tiles, Focus Point) come next, the layout-sensitive ones (Strips, Overlap, Rotascope) last. Limits are per type and can differ.
- **Jigsaw size online:** at most 1,000 pieces. Everything else stays as it is locally.
- **Accounts:** local play needs none. Creating or joining an online puzzle needs one. Sign-in with Google and with e-mail at launch; Apple and Facebook later.
- **Free tier:** 3 online puzzles *created* per week. More puzzles, video puzzles and bigger limits are for a paid tier (payments are not part of this plan, but the limits come from configuration so a tier can change them). Joining does not count.
- **Room limits:** 8 players per puzzle, 5 active online puzzles per player.
- **Hosting:** everything online is AWS, serverless, so that it costs about nothing with no players and scales by itself when there are many.
- **Platforms:** the web version at our own domain (Route 53), itch.io, Steam (in a desktop wrapper, later) and the Android app all use the same server. A code works from any of them.
- **Repo:** `server/` and `infra/` in this repository, importing `src/core`. No keys, tokens or AWS account ids are committed; ids that the apps need are build-time settings.
- **Domain:** bought in Route 53 when the infrastructure starts.

## Architecture

| Part | Service | Why |
|---|---|---|
| Game files | S3 + CloudFront | free to leave idle, scales without limit |
| Commands (create, join, list, grab, drop, leave) | API Gateway HTTP API + Lambda (Node) | pay per request |
| Room state, codes, members, quota counters | DynamoDB (on-demand) | a room is one record; it just sits there while nobody plays |
| Pictures (videos later) | private S3 bucket, short-lived signed URLs | only members of a room can fetch its picture |
| Live updates (who holds what, drag positions, moves) | AWS IoT Core, MQTT over WebSocket | built-in publish/subscribe: one message reaches everyone in a room, no servers |
| Accounts | Cognito user pool (Google federation + e-mail) | |
| Clean-up | DynamoDB TTL + Streams -> Lambda, S3 lifecycle as a backstop | |

Nothing runs while nobody plays. A room's state stays in DynamoDB until it expires.

The Lambda code uses the same `src/core` rules as the game, so the server decides what a drop does (snap, join groups, solved) exactly as a local game would.

### A puzzle's life

1. The player picks a photo, sees the consent text ("this picture is sent to our server and deleted when the puzzle ends or is idle for a day") and creates the puzzle. The client sends a re-encoded copy at most 1600 px on its longest side (the size the game plays at; re-encoding also removes camera metadata such as GPS).
2. `POST /rooms` checks the quota and the limits, makes the room, a 5-digit code and an invite link, and returns a signed upload URL. The client uploads the picture straight to S3; the room is playable once the picture is checked.
3. Friends join by code or by link. They get the room's settings, the current snapshot and a signed picture URL, and subscribe to the room's topic.
4. Every committed move adds one to the room's `version` and is published to everyone. A client that sees a gap in `version` fetches the snapshot again.
5. Every move also pushes the room's expiry out to 24 hours from now. When it passes, the room, its codes and its picture go.
6. When the puzzle is solved the server marks the room solved, publishes it and keeps the room for an hour for anyone still watching. Then it is deleted like any expired room, and it disappears from everyone's list.

### Moving pieces: one hand

- **Grab:** `POST /rooms/{id}/grab` does one conditional write that sets `lock = {holder, group, until}` if there is no live lock. Denied: the client shows "Alex is moving a piece".
- **Drag:** the holder publishes positions (about 10 a second, and only while the piece moves) straight to `puzzle/{room}/hand/{player}`. No Lambda is involved. Others draw the piece moving, smoothed. Others ignore hand messages from anyone who is not the lock holder.
- **Keeping the lock:** the holder calls `POST .../lock/renew` every few seconds. The lock lasts about 10 s, and it **expires by itself**: a grab after that time just succeeds, so a player who loses connection never blocks the board and no server timer is needed. IoT's "client disconnected" event releases it sooner.
- **Drop:** `POST .../drop` with the group's position (and turn, if turning is on). A Lambda loads the room, applies the move with the shared `JigsawGame`, saves it conditionally on `version` (retry on a clash), and publishes the result: where the group went, what joined, whether it is solved.
- **Release without moving** (`.../release`) lets go of the piece.
- A 1,000-piece snapshot is about 90 KB as JSON (measured), well inside DynamoDB's 400 KB item limit. That is one reason for the cap. Writing all of it on every drop is fine at this size; storing only what changed is the way out if it costs too much.

### Data (DynamoDB)

- `Rooms`: roomId, kind, opts, seed, media key and type, source photo id, owner, status (`open` / `solved`), `version`, `lock`, snapshot, `expiresAt` (TTL), join-link secret (hashed).
- `Codes`: 5-digit code -> roomId, with the same expiry. A code is chosen at random and written conditionally, so two rooms never share one. If more than about 20,000 rooms are ever active at once the code gets a sixth digit.
- `Members`: roomId + playerId, with an index by playerId for "my online puzzles".
- `Players`: id (the Cognito subject), display name, colour, tier.
- `Creations`: one item per created puzzle with a 7-day TTL; the quota counts them (3 per rolling 7 days on the free tier).
- Limits (pieces, puzzles per window, players) are read from configuration (AppConfig or SSM Parameter Store), keyed by tier and puzzle type, so they can change without a release.

### Codes and links

- **Link:** `https://<domain>/#/join/<code>~<secret>`. It opens the web version, asks for sign-in if needed, joins and plays. The long secret makes a link as private as the picture itself. The part after `#` never reaches a server log. If the Android app is installed, an Android App Link opens it instead.
- **Code:** 5 digits, for typing on any platform. Because only 100,000 codes exist, a code alone must not let a stranger into a room by guessing: joining by code **knocks**, and any member who is online approves. The link skips the knock.
- **Limits on guessing:** failed codes are rate-limited per account and per IP (WAF), and sign-in is required to try one.
- The creator can regenerate the code and link (which cuts off old ones) and remove a player or close the puzzle.

## Sign-in on each platform

- **Web:** Cognito hosted sign-in (OAuth code flow with PKCE), Google as a federated provider, plus e-mail and password with a verification code.
- **Android app (WebView):** Google refuses sign-in inside an embedded web view. Use a Chrome Custom Tab and return to the app through the App Link.
- **itch.io (page in an iframe) and a Steam wrapper:** the iframe cannot show the sign-in pages and a wrapper has no normal browser. Use a **device code**: the game shows a short code and `<domain>/link`, the player signs in on the web there, and the game collects the result. This needs a small custom Lambda flow and works everywhere, including a Steam Deck.
- Every build takes its server addresses and pool ids from build-time settings; nothing assumes it is served from our domain. The API allows the web, itch, Android and desktop-wrapper origins.

## Phases

### 0. Groundwork (no AWS) - done in PR #17
- [x] Write the protocol: commands, published messages, `version` handling, errors, a `protocol` number (an old app is told to update). `docs/online-protocol.md`.
- [x] Check what the Jigsaw layout depends on. It depends only on the seed, the picture's size and the settings, not on the screen. One thing did depend on the screen (how close pieces must be to join, which follows the zoom); it is now part of the operation and the room clamps it.
- [x] Give the game the operations a server needs: `buildJigsaw`, `applyOp` (`grab`, `drop`, `rotate`), `JigsawRoom` with the one-hand lock and `snapshot()` / `restore()`.
- [x] Split `src/sessions/jigsaw.ts` so that input produces operations through one `commit()`. Still to do in Phase 1: send them to a server, and apply remote ones.
- [x] Shared types for the messages in one place (`src/online/protocol.ts`).

### 1. A local prototype (no AWS)
- [ ] `server/` with the handlers behind interfaces for storage, pictures and publish/subscribe, with in-memory versions and a small local Node harness (HTTP and WebSocket) so that `npm run server` plays two browser tabs against each other.
- [ ] Client online mode in the play screen: remote moves, the one-hand indicator, other players' pieces moving, connection banner, reconnect with resync.
- [ ] Tests: the rules of the room (lock, expiry of a lock, version clashes, solved) and a scripted run with three fake clients (contention, disconnect, reconnect, solve).

### 2. AWS foundation (`infra/`, CDK in TypeScript)
- [ ] Buy the domain in Route 53; certificate; hosted zone.
- [ ] S3 + CloudFront for the game; private media bucket; DynamoDB tables with TTL; Cognito pool with Google and e-mail; API Gateway; Lambda functions; IoT Core with a custom authorizer that checks the sign-in token and limits each player to the topics of rooms they belong to (publish only on their own `hand` topic).
- [ ] Separate dev and prod stacks, a budget alarm, log groups, error alarms.
- [ ] GitHub Actions: test, build, deploy through an OIDC role (no stored AWS keys).
- [ ] Spike, half a day: IoT Core against AppSync Events for the live updates. Choose before building on it.

### 3. The feature
- [ ] **Consent dialog** before anything is uploaded; remember nothing but the answer for this puzzle.
- [ ] Create: pick photo and Jigsaw settings (online cap 1,000 pieces), upload, get code and link.
- [ ] Invite dialog: show code, copy link, share (Web Share), QR code, regenerate, player list, remove a player.
- [ ] Join: "Join with a code" box, the link route, the knock and approval, a name and colour.
- [ ] "Online puzzles" list (like "In progress"): puzzles I am in, who is online, time left before expiry, leave and rejoin.
- [ ] Play: the 24-hour idle expiry, the solved flow (watch, leave, removed from the list), time shown for fun but not counted in best times.
- [ ] **Save to library**: for anyone who does not have the picture; the creator's own copy is recognised by the source photo id, others by the room they saved it from.
- [ ] Account screen: sign in and out, display name, delete account.

### 4. Limits, safety and policy (before any public release)
- [ ] Quota: 3 creations per rolling 7 days; limits per tier and per type from configuration; a clear message with when the next one is free.
- [ ] Server-side picture check: type and size before the room is playable; then re-encode, and automated moderation (Rekognition).
- [ ] A report button, removing a room, banning an account.
- [ ] Rate limits and WAF on create, join and code guesses; reserved Lambda concurrency so a bug cannot run up a bill.
- [ ] Terms of service, privacy policy (what is sent, how long it is kept), a copyright takedown contact. Needs a real legal review.
- [ ] Account deletion in the app **and** at a web address (Google Play requires both for an app with sign-up); data-safety form for Play.
- [ ] Delete everything of a room when it ends; the S3 lifecycle rule removes anything missed. A maximum room age (for example 30 days) so an always-active room cannot live forever.

### 5. Platforms
- [ ] Android: App Links (`assetlinks.json` on the domain, intent filter), Custom Tab sign-in, INTERNET permission (already added locally), network security settings.
- [ ] itch.io build: iframe-friendly, device-code sign-in, allowed origin on the API.
- [ ] Device-code sign-in Lambda flow and the `<domain>/link` page.
- [ ] Steam: a desktop wrapper (Steamworks, depots) once everything else works. Steam sign-in as an identity later.

### 6. Before launch
- [ ] Load test with scripted clients (rooms of 4, dragging) to find limits and cost per room-hour.
- [ ] Request higher AWS limits ahead of time (Lambda concurrency, IoT message and connection rates, API throttle, DynamoDB).
- [ ] Staging run with real phones on mobile data and a laptop at the same time.
- [ ] Runbook: how to see errors, shut off creation, change limits, ban an account.

### Later
- Sliding Tiles and Focus Point online, then the other types.
- Video puzzles (large uploads, size and length caps, streaming from CloudFront, storage and bandwidth cost).
- Payments (Stripe on the web, Play Billing in the Android app, entitlements in DynamoDB), Apple and Facebook sign-in.

## Costs

- No players: about $1 a month (the Route 53 zone) plus pennies of storage. No servers, no load balancer.
- Busy: pay per use. IoT Core is roughly $1 per million messages; a room of 4 with one person dragging all the time is about 40 messages a second. Lowering the update rate and sending only while a piece moves are the levers. (Prices are from memory; check them before relying on them.)

## Risks and open questions

- **Codes (decided):** a code that works for 24 hours and has only 5 digits can be guessed, so joining by code knocks (a member approves), failed codes are rate-limited, and the link carries a long secret and joins directly. If the knock turns out to be too much friction, the other option is a code that only works for a short window after it is shown.
- **Cold starts:** the first request after a quiet time takes a few tenths of a second longer. Dragging is unaffected (it does not go through Lambda).
- **Cheating:** drag positions do not pass through the server, so a rude member could fake what others see while dragging. Drops are checked by the server, so the board itself is safe.
- **IoT sign-in** is the fiddliest part to build; the spike above decides.
- **Quotas** on a new AWS account start low; ask for increases well before a launch.
- **Time shown for a puzzle:** how it is counted (time with someone connected? gaps over five minutes left out?) is not decided; it does not count towards best times either way.
