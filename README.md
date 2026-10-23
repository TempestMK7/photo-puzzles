# Photo Puzzles (prototype)

Turn your own photos (later: videos) into puzzles, in the browser. Planned targets: itch.io (web), Android, iOS and Steam, from one TypeScript code base
(web build + Capacitor for phones + a desktop shell for Steam).

The **main screen** has the puzzle types along the top, your photos as a list on the left, the chosen photo in the middle, and the seed, difficulty,
Add photos and Play on the right. Choosing a photo and pressing Play (or double-clicking it) opens the **play screen**; when a puzzle is solved a dialog offers
View, New puzzle (the same photo with a new seed) and Photos. Best times are kept per photo, puzzle type and difficulty - not per seed.

**Video puzzles:** the browser plays the file itself (looped, with its sound) and the board is drawn again each time the video shows a new picture - one `drawImage` per piece, no
frame copying - so a 30 fps clip redraws 30 times a second. A bar under the board has pause / play, a draggable position and a sound switch (remembered). A new puzzle
or Restart keeps the video where it is. Videos are stored as they are in the browser's storage (nothing is uploaded or re-encoded).

**Display settings** for Focus Point: grid lines and swap animations can be switched off (on the main screen or with the Grid / Animate buttons while playing). They are
remembered and, being about looks rather than difficulty, do not start a new best-time record.

Playable now:
- **Focus Point** - the picture is cut into rectangles of different sizes and shuffled; click two pieces to make them trade places *and sizes*; put every piece back.
- **Overlap** - the picture is covered by L-shaped pieces that overlap. They wait in three stacks; drag the top piece onto the grid, turned the way it lies in the
  picture, and it stays and shows its part. A piece whose cells all show already is removed from its stack. The empty board is a radial pattern drawn in code
  (sunbursts, targets, rose windows, spirals, wheels - one per puzzle); some pieces have a *window* cell that shows the bit of that pattern from where the piece belongs, as a hint.
  Options: cells across (5-16), turned pieces, window pieces, pieces placed at the start.
- **Strips** - straight strips (1 x N cells, they may cross) are cut out of the picture and lie scattered and turned on the board. Drag each back into its hole; it locks when
  it lies exactly there, turned the right way. Options: number of strips, longest strip, pieces placed at the start.

In Overlap and Strips a tap on a piece turns it a quarter turn (so does the right button, a second finger, the R key or the Rotate button). Grid lines can be switched off
in every type. Listed as "soon": Jigsaw, Sliding Tiles.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (layout, shuffle, game rules)
npm run build    # type-check + production build in dist/
```

Add photos or **videos** (webm and mp4 with H.264 / AAC play in every mainstream browser; HEVC and other formats only where the browser or the device decodes them - a file
the browser cannot play is reported when you add it) with the button or by dropping them on the page; three generated sample pictures are always there. Photos and records stay on your device
(IndexedDB / localStorage): nothing is uploaded.

## Layout

- `src/core/` - rules with no browser dependency: seeded random (`rng.ts`), picture cutting (`layout.ts`), the games (`focus.ts`, `overlap.ts`, `strips.ts`: generator + rules),
  the list of puzzle types and their options (`kinds.ts`), saved preferences and best times (`prefs.ts`)
- `src/sessions/` - one `PuzzleSession` per type (layout, drawing, pointer input) behind the interface in `types.ts`; `index.ts` says how to start each
- `src/store/photos.ts` - the photo library (samples + the player's photos and videos in IndexedDB, thumbnails, duplicates by content hash) and what a puzzle draws from (`PlaySource`)
- `src/ui/` - `library.ts` (main screen), `play.ts` (play screen), small DOM helpers and the type icons (drawn in code)
- `src/render.ts` - canvas drawing and the swap animation; `src/image.ts` - loading a photo (EXIF-aware, reduced to 1600 px), thumbnails, the sample pictures
- `src/main.ts` - starts the app and switches between the two screens
- `tests/` - Vitest

To add a puzzle type: describe it in `kinds.ts`, write its game in `src/core/`, its session in `src/sessions/`, and register it in `sessions/index.ts`.

## Not in this repository

All art here is generated in code. Do not add third-party or personal media: `.gitignore` excludes photos, videos, signing keys, store credentials
and `.env` files.
