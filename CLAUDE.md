# Notes for Claude

PuzzleVidio (puzzlevid.io): a browser game (TypeScript, Vite, canvas, WebGL for video jigsaw pieces) that turns the player's own photos and videos into puzzles. See `README.md` for what each
puzzle type does and for the layout of the source.

## Git workflow (always)

- **Never commit to `main`, and never push to it.** Every change - code, docs, config, this file - goes on a new branch whose name **starts with `claude-`**
  (for example `claude-jigsaw-snap-fix`, `claude-update-readme`). Start each piece of work from an up-to-date `main`.
- When the work is done, **push the branch and open a pull request into `main`** (`gh pr create --base main`). The description says what changed and why, and how it was
  tested. Do not merge the pull request: the owner does that.
- Keep one branch and one pull request per piece of work. A follow-up to a pull request that is still open goes on the same branch.
- Commit messages: a short imperative summary line, a blank line, a few lines of why. End them with the attribution line Claude Code is configured to add
  (`Co-Authored-By: ...`), and end pull request descriptions with the matching generated-with line.
- Before opening a pull request run `npm test`, `npx tsc --noEmit` and `npm run build`; all three must pass.

## This is a public repository

Nothing private or copyrighted goes into a commit: no photos, videos or other media (all art in the game is drawn in code; the only recordings are the sound effects in `src/sounds/`, which the game plays - add one only when the owner says it is public domain, free to use, or made for the game), no keys, tokens or `.env` files, no personal paths,
names or e-mail addresses in files. `.gitignore` already excludes media, keys and native build output (`android/`, `ios/`); keep it that way, and check `git status` before
every commit. Test media (clips, big photos) is made on the spot with ffmpeg in an ignored folder and deleted afterwards.

## Commands

```
npm install
npm run dev        # the game at http://localhost:5173/ (Vite)
npm test           # Vitest: the rules in src/core and the save/restore of every puzzle type
npx tsc --noEmit   # type check (strict, no unused locals)
npm run build      # type check (the game and server/) + production build into dist/
npm run server     # the online server on this machine, http://localhost:8787 (memory only; for trying online play with two browser tabs)
(cd infra && npm test)   # the AWS stacks (CDK): the templates are built and checked; `npx cdk synth -c hostedZoneId=ZEXAMPLE` builds them all
```

## How the code is organised

- `src/core/` has the rules and no browser dependency, so it is unit tested: `focus`, `overlap`, `strips`, `jigsaw`, `sliding`, `rotascope` (each game also has `snapshot()` / `restore()` for saved
  puzzles), `kinds.ts` (the puzzle types and their options), `prefs.ts`, `rng.ts`.
- `src/sessions/` has one `PuzzleSession` per type (drawing and pointer input) behind `types.ts`; `index.ts` says how to start each. `jigsawGl.ts` draws the video Jigsaw and `videoGl.ts` (`VideoLayer`, shared by every other type) the pieces of the other types, on the
  graphics card; a type that has a video draws its pieces there (`overlay`, and `front` for what lies over them) and keeps the 2D drawing for photos and for a browser without WebGL 2, so a change to how a piece looks is made in both. `jigsawArt.ts` makes the piece shapes.
- A board with a camera (zoom and move) gives its session `view`, `wheel`, `pinch`, `zoomBy`, `zoomFit`, `zoomLabel` and `rightDown/Move/Up` (`types.ts`), and the play screen then shows the zoom control and handles the wheel and two fingers. Tile Swap, Sliding Tiles, Rotascope and Strips use `src/sessions/camera.ts` for it (the click ones act on the release of the press, and not when it moved the camera); Overlap and Jigsaw have their own. Anything drawn with a fixed width in board units has to use `cam.lineK()` so that it stays as many pixels wide when zoomed in.
- Hints and bombs (`src/core/help.ts`: which puzzles have them, how far a bomb reaches, what a solved puzzle gives; a free account earns at most `freeHintsPerDay` a day: `RoomService.earnHints`) are the account's, held on the server (`AccountRecord.hints/bombs`). A session of a puzzle that has them gives `canHelp` and `help` (`types.ts`), and `play.ts` does the choosing, the tap and the asking of the server (`POST /items/use`, then `session.help`). Their operations (`hint`, `bomb`) are in `BoardOp` and `JigsawOp` like any other move, so a puzzle played with friends takes them from the account in `RoomService.command` and only where `RoomRecord.helpers` (the host's choice) is set. A puzzle type in which a piece placed by hand can make the rest unsolvable (Sliding Tiles, Rotascope) must not get them.
- `src/store/` is storage on the device only: `photos.ts` (the library, IndexedDB), `saves.ts` (unfinished puzzles). Nothing is ever sent anywhere (`link.ts` only downloads a picture from an address the player pasted).
- The game was called Photo Puzzles before it became PuzzleVidio. Names that players' data hangs on keep the old name on purpose, so nothing saved is lost: the IndexedDB databases `photo-puzzles` and `photo-puzzles-saves`, the `photo-puzzles/...` local storage keys, the `PhotoPuzzlesNative` bridge of the Android app, the GitHub repository and the Android package id. Only what players see (title, heading, app label) was renamed.
- Tile Swap, Overlap and Strips can be played with friends too: `src/core/boardRoom.ts` (`BoardOp`, `applyBoardOp`, `BoardRoom`, `boardCheck`) is their room and a session sends its moves with `init.online?.send` and applies the others' in `applyEvent` / `resync` / `groupCount`. A new move of these puzzles is an operation there (and in `docs/online-protocol.md`), never a change of the board by itself.
- `src/online/` is the player's side of playing with friends and `server/` the online server (`RoomService` on interfaces; see `docs/online-play-plan.md` and `docs/online-protocol.md`). The server imports `src/core` and `src/online/protocol.ts`, so the rules are the same on both sides: keep those two free of browser and Node dependencies.
- `server/src/aws/` are the Lambda functions (the API, the picture clean-up, the broker's authorizer and the presence function) and the DynamoDB / S3 / IoT versions of the service's interfaces; `tests/helpers/fakeDynamo.ts` is a small DynamoDB for the tests (the service tests run on it too), and it throws on any expression it was not written for. A new query shape in `DynamoStore` needs the fake to learn it.
- `infra/` is the AWS side (CDK, TypeScript, its own `package.json`): see `infra/README.md` and `docs/online-play-plan.md`. No account ids, zone ids, keys or e-mail addresses go into it: they are CDK context at deploy time. Do not deploy from a session without the owner's say-so.
- `src/ui/` has the main screen (`library.ts`), the play screen (`play.ts`) and the window with the original picture (`refwindow.ts`).

## Conventions

- Match the surrounding code: comment density, naming, idiom. Comments explain why. Prefer a small change over a rewrite.
- How big a puzzle is comes from its **size** (`sizes` of the kind in `kinds.ts`: S, M, L... each sets the pieces, cells, tiles or rings; `optionsOf` adds what the size sets to the options, so a session reads `opts.pieces` and the like). Settings that hold for every kind (grid lines, animations, vibration, raise piece, light background) are `GENERAL` in `kinds.ts`, kept as `all.<key>` and changed in the settings window (`src/ui/settings.ts`); a session reads them with `init.flag(key)`.
- Game rules go in `src/core/` with tests in `tests/`; a new puzzle option is described in `kinds.ts`, and the setting that decides whether a best time is shared goes
  through `recordKey` (display-only options are marked `display`).
- A puzzle must be reproducible from its seed. Anything the player changes while playing is part of the puzzle's `snapshot()`, and a snapshot that does not fit is refused
  (throws) so that the puzzle starts fresh instead.
- Keep it fast on a slow phone or tablet: no per-frame allocation in drawing loops, and measure on a low-end device before and after a change to rendering.
- Do not use `confirm()`, `alert()` or `prompt()` for anything the player needs to answer: an Android web view swallows them. Ask in the page.
- Check a change in a real browser (and at phone width, below 820 px, where the screens stack) before calling it done; say plainly in the pull request what was not tested.

## Android

The game is also packaged for Android as a thin WebView app, in `android/` (it is part of this repository: `android/README.md` says how it is built and what is not kept, which is the web build that is copied into it, `local.properties`, and anything with a key in it). Put the web build in with `node scripts/android-web.mjs dev|prod|offline`, then `cd android && ./gradlew assembleDebug`. When changing
something the app depends on (file picking, storage, video, ads), remember that an Android WebView differs from a desktop browser, and test there if you can. Never commit a keystore, `keystore.properties` or `local.properties` (the AdMob ids and the signing are there); the ad unit ids are not secret but are kept out of the repository too.

The page and the shell talk through `window.PhotoPuzzlesNative` (`src/haptics.ts` uses `haptic(kind)`, `src/store/shared.ts` uses `takeShared()`). **Sharing into the app:** the shell lists itself for `ACTION_SEND` and
`ACTION_SEND_MULTIPLE` of `image/*` and `video/*`, serves each shared file to the page at `/shared/<number>/<name>` on the page's own address (read from the sender's `content://` address), and `takeShared()` returns
the JSON list `[{ "url", "name", "type" }]` of what has not been taken yet (and empties it). If something is shared while the page is open, the shell fires the window event `photopuzzles-shared`; the page takes
what is new and adds it to the library. The page fetches only `/shared/<id>/<name>` addresses and at most 50 files. iOS has no such thing yet (it would be a Share Extension in a native iOS app).

**Signing in with Google** cannot happen in a web view (Google refuses it), so a shell that offers `PhotoPuzzlesNative.openSignIn(url)` (opens a sign-in address in a Chrome Custom Tab) and `takeSignIn()` (the address the player came back to the app with, `com.tempest.photopuzzles://signed-in?code=...`, once, or an empty string) is signed in through the phone's browser: `src/platform.ts` (`browserSignIn`), `CognitoAccount` (`external`), `android/README.md`. The window event `photopuzzles-signin` says that an address has come.

**Rewarded ads:** the only ads are the Android app's (AdMob: `android/app/src/main/java/com/tempest/photopuzzles/Ads.java`; `docs/online-protocol.md`, *Ads for credits*, has the whole flow). The page shows an "ad for credits" button only when the shell offers `PhotoPuzzlesNative.showRewardedAd(kind, nonce)` (`kind` is `'photo'` or `'video'`; `nonce` is the one-time number that the server gave for this ad, which the shell gives the ad network as the ad's custom data; it starts the ad and returns at once) and, optionally, `PhotoPuzzlesNative.platform()` (`'android'` or `'ios'`; anything else is taken for Android). When the ad is over the shell fires the window event `photopuzzles-ad` with `detail` `{ kind, rewarded, error? }`: `rewarded` is true only if the player watched it to the end, `error` is `no-ad` or `consent`. **The page never gives itself credits:** AdMob tells the server that the ad was watched (server-side verification), and the page asks the server about the account until they are there. Where the law asks for it the shell also offers `privacyOptionsRequired()` and `showPrivacyOptions()` (Google's consent form). The page waits five minutes for the event at most. Steam and itch builds have no ads (their rules): they say so with `VITE_PLATFORM=steam` or `itch` when built, and show a note that ads can be watched in the mobile apps with the same account. The credits are the account's, so they work on every platform. See `src/platform.ts`.
