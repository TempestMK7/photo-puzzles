# Photo Puzzles (prototype)

Turn your own photos (later: videos) into puzzles, in the browser. Planned targets: itch.io (web), Android, iOS and Steam, from one TypeScript code base
(web build + Capacitor for phones + a desktop shell for Steam).

This first prototype has one puzzle type, **Focus Point**: the picture is cut into rectangles of different sizes and shuffled; click two pieces to make them
trade places *and sizes*; put every piece back to solve it. The same seed always gives the same puzzle.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm run dev      # http://localhost:5173
npm test         # unit tests (layout, shuffle, game rules)
npm run build    # type-check + production build in dist/
```

Choose or drag in a photo; with none, a generated picture is used. Photos stay on your device: nothing is uploaded.

## Layout

- `src/core/` — rules with no browser dependency: seeded random (`rng.ts`), picture cutting (`layout.ts`), the puzzle (`focus.ts`)
- `src/render.ts` — canvas drawing and the swap animation
- `src/image.ts` — loading a photo (EXIF-aware, reduced to 1600 px) and the built-in sample picture
- `src/main.ts` — page wiring, pointer input
- `tests/` — Vitest

## Not in this repository

All art here is generated in code. Do not add third-party or personal media: `.gitignore` excludes photos, videos, signing keys, store credentials
and `.env` files.
