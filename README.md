# PuzzleVidio (prototype)

Turn your own photos (later: videos) into puzzles, in the browser. Planned targets: itch.io (web), Android, iOS and Steam, from one TypeScript code base
(web build + Capacitor for phones + a desktop shell for Steam).

The **main screen** has the puzzle types along the top, your photos as a list on the left, the chosen photo in the middle, and the seed, difficulty,
Add photos and Play on the right. Choosing a photo and pressing Play (or double-clicking it) opens the **play screen**; when a puzzle is solved a dialog offers
View, New puzzle (the same photo with a new seed), Other photo (a new puzzle with the same type and settings on another photo - one not yet solved with these settings if there is one, picked at random) and Photos. Best times are kept per photo, puzzle type and difficulty - not per seed.

**Video puzzles:** the browser plays the file itself (looped, with its sound) and the board is drawn again each time the video shows a new picture - one `drawImage` per piece, no
frame copying - so a 30 fps clip redraws 30 times a second. A bar under the board has pause / play, a draggable position and a sound switch (remembered). A new puzzle
or Restart keeps the video where it is. Videos are stored as they are in the browser's storage (nothing is uploaded or re-encoded).

**Display settings** for Focus Point: grid lines and swap animations can be switched off (on the main screen or with the Grid / Animate buttons while playing). They are
remembered and, being about looks rather than difficulty, do not start a new best-time record.

Playable now:
- **Focus Point** - the picture is cut into rectangles of different sizes (6 to 200 of them) and shuffled; click two pieces to make them trade places *and sizes*; put every piece back.
- **Overlap** - the grid is divided like a checkerboard: every other cell is a piece's own *centre* cell, and the cells between are *overlap* cells. Each piece is a centre and two to four of the overlap
  cells next to it (three to five cells), and every overlap cell belongs to at least two pieces. The pieces wait in three stacks; drag the top piece onto the grid (or onto another stack to move it there), centre
  first and turned the way it lies in the picture, and it stays and shows its part. The empty board is a radial pattern drawn in code (sunbursts, targets, rose windows, spirals, wheels - one per puzzle, with its
  centre off the board); some pieces have a *window* on one of their overlap cells that shows the bit of that pattern from where the piece belongs, as a hint, and turns into the picture for every piece that
  has it when any piece is placed over that cell.
  Options: cells across (5-16), turned pieces, window pieces, pieces placed at the start.
- **Strips** - the whole picture is cut into straight strips (1 x N cells, 3 up to the longest allowed; they may cross) that lie scattered and turned on the board. You choose the
  cells across and the longest strip; the number of strips is worked out so that every cell is covered and every strip covers at least one cell that no other strip covers
  (so its place is certain). Drag each strip back into its hole; it locks when it lies exactly there, turned the right way - the moment it does, even before you let go of the mouse button. The loose strips are spread at random over 1-10
  **tabs** (each tab shows the same picture and holes with its own strips; drag a strip onto a tab, or rest it there, to move it; keys 1-9 and 0 switch tabs). Options: cells across
  (6-40), longest strip, tabs, pieces placed at the start.
- **Jigsaw** - classic interlocking pieces, no grid. You choose the *approximate* number of pieces (100-5000 in steps of 100; the picture is cut into square cells, so the real
  count is the nearest grid to that). The four corner pieces start solved and fixed; the rest lie scattered round the frame on a table four times the size of the picture in each
  direction. Put a loose piece against a piece it belongs beside and it joins it - the moment it is close enough, even before you let go - and joined pieces move as one; anything
  that joins a solved piece becomes part of the picture. The mouse wheel (or the control at the bottom right: -, the zoom, +; click the zoom to show everything) zooms about the
  pointer; the right button - or the left one on bare ground - moves the camera (two fingers on bare ground zoom and move it on a touch screen; while a piece is in hand, a second finger turns it instead). The table is dark by default; the **Light background** option (and the Light button in the header) makes it light, for pieces that are hard to see on a dark one. On a touch screen pieces are lifted above the finger and give touch feedback (see "Touch" below). A video keeps playing in the pieces:
  they are drawn on the graphics card (WebGL 2, `src/sessions/jigsawGl.ts`) - the video frame is a texture, the piece shapes are made once, and every piece is one instance of a
  quad, so a frame is a single draw call however many pieces there are (a few thousand cost well under a millisecond of script). The pieces have a canvas of their own laid over
  the board (copying it onto the board's canvas every frame was by far the most expensive step on a slow GPU), only that canvas is redrawn for each new picture of the video,
  and when the graphics card cannot keep up with the video the piece canvas drops to as little as half the resolution by itself. On a 2016 tablet (Mali-T830) this gives
  about 25-30 pictures a second from a 720p video and 19-24 from a 1080p one, with 300-5000 pieces. A browser without WebGL 2 stops the video at its first picture instead and
  cuts the pieces from that (`jigsawArt.ts`).
  Two ways to make the start easier or tidier: **Placed at the start (%)** (0-80, off by default) puts that share of the pieces, picked at random, in their places as part of the
  picture, as the corners are (placed pieces that touch are one block, and loose pieces join them the same way), and **Edge pieces start in the picture area** (off by default)
  scatters the border pieces at random over the area where the finished picture goes - loose, not in their places - while the others lie round it, so the border pieces stand
  apart from the rest. With both on, the placed pieces are picked from the inside pieces only. Both count as difficulty (they start their own best time), but puzzles saved or
  recorded before they existed keep their records, because an option added later is left out of the record key while it is at its default.
  More options: **Turned pieces** (loose pieces start turned by quarter turns; click a piece to select it - it glows - and right-click, R or the Rotate button turns the selected
  piece, or the one in your hand when you right-click while dragging it; pieces only join when turned the same way, and only upright pieces join the picture) and **Joining pieces**,
  how eagerly pieces that lie against one they fit join it: *snap while dragging* (as soon as they touch, even before you let go), *snap when held together* (the piece has to
  stay there, held, for half a second - or you let go with the pieces together, which snaps them at once) or *snap on release* (only when you let go with the pieces together).
- **Sliding Tiles** - the picture is cut into a grid of tiles with the last one taken out, then shuffled by sliding (so it can always be solved). You choose the *approximate* number of
  tiles (8-99; the grid is the one nearest that with tiles as square as the picture allows, so a wide picture gets more columns). Click a tile in the empty cell's row or column and it
  slides over, taking the tiles between it and the empty cell along; the missing tile appears when the puzzle is solved. Videos keep playing in the tiles: they are drawn on the graphics card (`src/sessions/videoGl.ts`: each tile is a textured
  quad of the video's picture), because on a slow device a video picture costs 25-40 ms to get onto a 2D canvas but about a millisecond to give to the graphics card (a 2016 tablet: 1-10 pictures a
  second with the 2D canvas, 30 with the graphics card, 1080p and 99 tiles included).
- **Rotascope** - a round picture is cut into concentric rings of equal wedges round a hole in the middle: a sliding puzzle with one empty cell, as in Pandora's Box. You choose the number of
  **rings** (2-6) and of **wedges in each ring** (3-12). Click a piece that touches the empty cell - the next ring in or out, the neighbour in its own ring (the ring closes up), or, for ring 0,
  the middle - and it slides in. Each ring is a fixed ratio wider than the one inside it, so a piece grows or shrinks and turns as it passes between rings. The picture is whole again
  when every piece is home. The empty cell and the middle show a dimmed ghost of the picture. Videos keep playing in the pieces, drawn on the graphics card like the tiles of Sliding Tiles
  (each wedge is a few triangles whose colours come from the turned and scaled picture).

**Touch.** On a touch screen the dragging puzzles (Overlap, Strips, Jigsaw) hold a piece you pick up 76 px above your finger (it rises over a tenth of a second, and stays at least 24 px from the
top of the screen) so that the finger does not hide it; a mouse or a pen holds it where it is, and the **Lift pieces above the finger** option switches it off. Every puzzle gives a small
vibration at its key moments: **Vibration** option, and a header button where the device can give it. Focus Point: each piece you select (and the swap); Sliding Tiles and Rotascope: a piece
that moves; Overlap, Strips and Jigsaw: a piece picked up, put down, placed (a longer pattern) and turned; finished puzzles a long pattern. A browser asks for it with `navigator.vibrate`; an
app that wraps the game in a web view can offer `window.PhotoPuzzlesNative.haptic(kind)` (`grab`, `drop`, `join`, `placed`, `turn`, `move`, `solved`) instead and play the phone's own haptic effects,
which are felt on every phone, whereas a web page's short vibrate-for-a-few-milliseconds is often too weak to notice (`src/haptics.ts`, `src/sessions/feedback.ts`).

In Overlap and Strips a tap on a piece turns it a quarter turn (so does the right button, a second finger, the R key or the Rotate button). Grid lines can be switched off
in the types that have them.

## The original

The **Original** button in the play screen's header opens a small window with the original picture to look at while solving. Drag it by its title, resize it by the corner, close it
with the x (or Escape, which closes the window before it leaves the puzzle). For a video the window does not play the file a second time: it mirrors the video the puzzle is
cut from (`captureStream`), so it shows the same moment whether the video plays, is paused or is moved to another place, and it costs no second decoder (about 10-20% of the frame
rate on a 2016 tablet; a copy to a canvas is the fallback where `captureStream` is missing). `src/ui/refwindow.ts`.

## Saved puzzles

A puzzle that is left unfinished (back to the photo screen, closing the page) is kept, and comes back exactly as it was - pieces, turns, tabs, the Jigsaw camera, the time -
when you start the same photo, type and difficulty again with the same seed. Restart and New puzzle throw the kept one away; a solved puzzle leaves nothing to keep. Deleting a
photo or video deletes its saved puzzles too. Saves live only in this browser (IndexedDB, `src/store/saves.ts`); nothing is sent anywhere.

The **In progress** button at the top of the photo screen lists every unfinished puzzle (photo, type, difficulty, time played, how far it got, when it was left, the last played
first). Tapping one sets the type, photo, difficulty and seed it was made with and opens it as it was left; Discard (tap twice) forgets it.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (layout, shuffle, game rules)
npm run build    # type-check + production build in dist/
```

Add photos or **videos** (webm, mp4 and mkv with H.264 / VP9 / AAC / Opus play in every mainstream browser; HEVC, AC-3 and other formats only where the browser or the device
decodes them - a file the browser cannot play is reported when you add it; an Android WebView does not open H.264 inside mkv at all, VP9 or HEVC inside mkv are fine) with the button or by dropping them on the page. **From a link...** takes the address of a picture or video (a Google image search "imgres" link works too; so does pasting a link or a copied picture with Ctrl+V, or dragging a picture in from another page): the page downloads it itself, with no cookies and no referrer, so it only works when the picture's site allows other pages to read it (Wikimedia, Unsplash, Imgur, Giphy and Reddit do; a refusal is reported, there is no proxy) - the Android app needs the INTERNET permission for it. **Stock Files** (a tab above the photo list, in a build with a server) searches Pixabay and Pexels (whichever the server has a key for) for pictures and videos: a result is shown in full in the middle, and **Play** downloads it from Pexels, adds it to the library (with its credit: a small mark of the site on its thumbnail, and "Photo by ... on Pixabay" under its name) and starts the puzzle; the server only does the searching (`server/src/stock.ts`; a site is offered only when its key is in Secrets Manager, `infra/README.md` says how to give it one). **Adult content is kept out** in two ways, because the sites' own safe search is not enough: the server answers a search for adult words with nothing and leaves out results whose tags or title use them (`server/src/stockFilter.ts`), and an online puzzle made from a stock picture or video gets a stricter automatic look (it also turns down implied and partial nudity; a kiss and swimwear are fine). Photos and records stay on your device
(IndexedDB / localStorage): nothing is uploaded; a link is only ever downloaded from.

**Animated GIFs** are turned into a WebM video when they are added (the browser's own `ImageDecoder` reads the frames and their delays, `VideoEncoder` encodes them as VP8 and
`src/webm.ts` writes the file), so they play, loop and seek like any other video; a one-frame GIF stays a picture, and a browser without those WebCodecs APIs adds the GIF as a still
picture as before. A long GIF takes a few seconds to convert, with the progress shown on the Adding line.

## Layout

- `src/core/` - rules with no browser dependency: seeded random (`rng.ts`), picture cutting (`layout.ts`), the games (`focus.ts`, `overlap.ts`, `strips.ts`, `jigsaw.ts`, `sliding.ts`, `rotascope.ts`: generator + rules, and `snapshot` / `restore` for saving),
  the list of puzzle types and their options (`kinds.ts`), saved preferences and best times (`prefs.ts`);
  for playing together: `jigsawSetup.ts` makes a Jigsaw puzzle from its seed (the same on every screen and on a server) and applies the operations that change it, `jigsawRoom.ts` is the room that
  lets one player hold a piece at a time. `src/online/protocol.ts` has the messages and invite links; see `docs/online-protocol.md` and `docs/online-play-plan.md`
- `src/online/` - what playing with friends needs on a player's side: the messages (`protocol.ts`), the requests (`api.ts`), the live connection (`realtime.ts` for the local server, `iotRealtime.ts` and the little MQTT it needs in `mqtt.ts` for AWS IoT Core), the room as one player sees it (`room.ts`), who the player is (`identity.ts`: a stand-in for an account on the local server; `cognito.ts`: the account, with its own e-mail and password calls to the user pool (`passwords`) and Cognito's sign-in page for Google later; `password.ts`: the rules for a password; `guestAccount.ts`: a guest, who may join puzzles but not make them; `session.ts`: the account or else the guest, and the display name). A build is for the cloud when it is given `VITE_ONLINE_URL`, `VITE_IOT_ENDPOINT`, `VITE_IOT_AUTHORIZER`, `VITE_COGNITO_HOST` and `VITE_COGNITO_CLIENT_ID` (the deploy workflow reads them from the stacks' outputs); without them `npm run dev` uses the local server.
  `server/` is the online server: `RoomService` has every request as a method on interfaces for storage and the rest, `router.ts` is the HTTP side, `local.ts` runs it on this machine (`npm run server`, in memory; see `docs/online-protocol.md`).
- `android/` - the Android app (a WebView around the web build, with file picking, sharing into the game, touch feedback and rewarded ads; `android/README.md`). `scripts/android-web.mjs` puts the web build in it.
- Accounts and credits: a free, paid, family or admin account (`server/src/accounts.ts`, `server/src/service.ts`: `docs/online-protocol.md`, *Accounts and credits*). Playing alone and joining puzzles are free for everyone; starting an online puzzle costs photo or video credits as the type says, shown at the top of the main screen (`src/ui/credits.ts`), and the mobile apps can play a rewarded ad for more (`src/platform.ts`).
- `src/admin/` - the admin page at `/admin` (accounts and their types, puzzles, files, reports, logs; for the operator, behind a Cognito group; see `docs/runbook.md`).
- `src/legal/` - the text of the privacy policy and the terms, built into `privacy.html` and `terms.html` (shown at `/privacy` and `/terms`); see `docs/legal/README.md`.
- `infra/` - the AWS infrastructure (CDK): the game's hosting, the table and bucket for online puzzles, sign-in, the budget (`infra/README.md`; how to run it is `docs/runbook.md`; the plan is `docs/online-play-plan.md`, the live-message choice `docs/online-realtime.md`).
- `src/sessions/` - one `PuzzleSession` per type (layout, drawing, pointer input) behind the interface in `types.ts`; `index.ts` says how to start each
- `src/store/saves.ts` - unfinished puzzles (IndexedDB)
- `src/online/playbackSync.ts` - the video of a puzzle played with friends: the host's play, pause and seeking, and the others following until they go their own way (and the button back); `videoFrames.ts` takes the pictures of a video that the server looks at
- `src/store/shared.ts` - pictures and videos that other apps share with the Android app ("Share > PuzzleVidio"): the page takes them from the host app through `PhotoPuzzlesNative.takeShared()`; see *Android* in `CLAUDE.md`
- `src/store/stock.ts` - the stock library (Pixabay, Pexels) from the game's side: searching through the server, checking that every address is its site's, downloading a file, and the credit kept with a picture
- `src/store/photos.ts` - the photo library (the player's photos and videos in IndexedDB, the id the online server keeps each under, thumbnails, duplicates by content hash) and what a puzzle draws from (`PlaySource`)
- `src/ui/` - `library.ts` (main screen), `play.ts` (play screen), `onlinebar.ts` (who is in an online puzzle, the invite with its QR code, sending a player out; `online.ts` is the panel for playing with friends, with the account's sign-out and deletion; `qr.ts` loads the QR library only when a code is shown), small DOM helpers and the type icons (drawn in code)
- `src/render.ts` - canvas drawing and the swap animation; `src/image.ts` - loading a photo (EXIF-aware, reduced to 1600 px), thumbnails; `src/gif.ts` + `src/webm.ts` - animated GIF to WebM on import
- `src/main.ts` - starts the app and switches between the two screens
- `tests/` - Vitest

To add a puzzle type: describe it in `kinds.ts`, write its game in `src/core/`, its session in `src/sessions/`, and register it in `sessions/index.ts`.

## Not in this repository

All art here is generated in code. Do not add third-party or personal media: `.gitignore` excludes photos, videos, signing keys, store credentials
and `.env` files.
