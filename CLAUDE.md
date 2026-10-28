# Notes for Claude

Photo Puzzles: a browser game (TypeScript, Vite, canvas, WebGL for video jigsaw pieces) that turns the player's own photos and videos into puzzles. See `README.md` for what each
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

Nothing private or copyrighted goes into a commit: no photos, videos or other media (all art in the game is drawn in code), no keys, tokens or `.env` files, no personal paths,
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
- `src/sessions/` has one `PuzzleSession` per type (drawing and pointer input) behind `types.ts`; `index.ts` says how to start each. `jigsawGl.ts` and `videoGl.ts` draw video pieces on the
  graphics card, `jigsawArt.ts` makes the piece shapes.
- `src/store/` is storage on the device only: `photos.ts` (the library, IndexedDB), `saves.ts` (unfinished puzzles). Nothing is ever sent anywhere (`link.ts` only downloads a picture from an address the player pasted).
- `src/online/` is the player's side of playing with friends and `server/` the online server (`RoomService` on interfaces; see `docs/online-play-plan.md` and `docs/online-protocol.md`). The server imports `src/core` and `src/online/protocol.ts`, so the rules are the same on both sides: keep those two free of browser and Node dependencies.
- `infra/` is the AWS side (CDK, TypeScript, its own `package.json`): see `infra/README.md` and `docs/online-play-plan.md`. No account ids, zone ids, keys or e-mail addresses go into it: they are CDK context at deploy time. Do not deploy from a session without the owner's say-so.
- `src/ui/` has the main screen (`library.ts`), the play screen (`play.ts`) and the window with the original picture (`refwindow.ts`).

## Conventions

- Match the surrounding code: comment density, naming, idiom. Comments explain why. Prefer a small change over a rewrite.
- Game rules go in `src/core/` with tests in `tests/`; a new puzzle option is described in `kinds.ts`, and the setting that decides whether a best time is shared goes
  through `recordKey` (display-only options are marked `display`).
- A puzzle must be reproducible from its seed. Anything the player changes while playing is part of the puzzle's `snapshot()`, and a snapshot that does not fit is refused
  (throws) so that the puzzle starts fresh instead.
- Keep it fast on a slow phone or tablet: no per-frame allocation in drawing loops, and measure on a low-end device before and after a change to rendering.
- Do not use `confirm()`, `alert()` or `prompt()` for anything the player needs to answer: an Android web view swallows them. Ask in the page.
- Check a change in a real browser (and at phone width, below 820 px, where the screens stack) before calling it done; say plainly in the pull request what was not tested.

## Android

The game is also packaged for Android as a thin WebView app that is built locally from an untracked `android/` folder; it is not part of this repository. When changing
something the app depends on (file picking, storage, video), remember that an Android WebView differs from a desktop browser, and test there if you can.
