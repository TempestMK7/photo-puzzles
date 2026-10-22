# Photo Puzzles (prototype)

Turn your own photos (later: videos) into puzzles, in the browser. Planned targets: itch.io (web), Android, iOS and Steam, from one TypeScript code base
(web build + Capacitor for phones + a desktop shell for Steam).

The **main screen** has the puzzle types along the top, your photos as a list on the left, the chosen photo in the middle, and the seed, difficulty,
Add photos and Play on the right. Choosing a photo and pressing Play (or double-clicking it) opens the **play screen**; when a puzzle is solved a dialog offers
View, New puzzle (the same photo with a new seed) and Photos. Best times are kept per photo, puzzle type and difficulty - not per seed.

**Video puzzles:** the browser plays the file itself (looped, with its sound) and the board is drawn again each time the video shows a new picture - one `drawImage` per piece, no
frame copying - so a 30 fps clip redraws 30 times a second. A bar under the board has pause / play, a draggable position and a sound switch (remembered). A new puzzle
or Restart keeps the video where it is. Videos are stored as they are in the browser's storage (nothing is uploaded or re-encoded).

Playable now: **Focus Point** - the picture is cut into rectangles of different sizes and shuffled; click two pieces to make them trade places *and sizes*; put
every piece back to solve it. The same seed always gives the same puzzle. Listed as "soon": Overlap, Strips, Jigsaw, Sliding Tiles.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (layout, shuffle, game rules)
npm run build    # type-check + production build in dist/
```

Add photos or **videos** (webm works everywhere; mp4 and others as far as the browser plays them) with the button or by dropping them on the page; three generated sample pictures are always there. Photos and records stay on your device
(IndexedDB / localStorage): nothing is uploaded.

## Layout

- `src/core/` - rules with no browser dependency: seeded random (`rng.ts`), picture cutting (`layout.ts`), the Focus Point game (`focus.ts`), the list of puzzle
  types and their options (`kinds.ts`), saved preferences and best times (`prefs.ts`)
- `src/store/photos.ts` - the photo library (samples + the player's photos and videos in IndexedDB, thumbnails, duplicates by content hash) and what a puzzle draws from (`PlaySource`)
- `src/ui/` - `library.ts` (main screen), `play.ts` (play screen), small DOM helpers and the type icons (drawn in code)
- `src/render.ts` - canvas drawing and the swap animation; `src/image.ts` - loading a photo (EXIF-aware, reduced to 1600 px), thumbnails, the sample pictures
- `src/main.ts` - starts the app and switches between the two screens
- `tests/` - Vitest

To add a puzzle type: describe it in `kinds.ts`, write its game in `src/core/`, and let `play.ts` start it.

## Not in this repository

All art here is generated in code. Do not add third-party or personal media: `.gitignore` excludes photos, videos, signing keys, store credentials
and `.env` files.
