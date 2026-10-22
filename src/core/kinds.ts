// The puzzle types the game knows (or will): what each is called, whether it can be played yet, and its difficulty options.
// Adding a type = describe it here, give it a game in src/core/, and a screen in src/ui/play.ts.

export interface OptionDef {
  key: string;
  label: string;
  min: number;
  max: number;
  def: number;
  step?: number;
  /** Shown as a check box (0 / 1) instead of a slider. */
  toggle?: boolean;
  /** A way of showing the puzzle, not a difficulty: it does not start a new best-time record. */
  display?: boolean;
}

export type KindId = 'focus' | 'overlap' | 'strips' | 'jigsaw' | 'sliding';

export interface KindDef {
  id: KindId;
  name: string;
  blurb: string;
  /** False: listed but not playable yet. */
  available: boolean;
  options: OptionDef[];
}

export const KINDS: readonly KindDef[] = [
  {
    id: 'focus',
    name: 'Focus Point',
    blurb: 'Pieces of different sizes are shuffled. Click two to trade places and sizes.',
    available: true,
    options: [
      { key: 'pieces', label: 'Pieces', min: 6, max: 60, def: 16, step: 2 },
      { key: 'irregular', label: 'Irregular pieces', min: 0, max: 1, def: 1, toggle: true },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
      { key: 'animate', label: 'Animations', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  {
    id: 'overlap',
    name: 'Overlap',
    blurb: 'L-shaped pieces that overlap wait in stacks. Drag the top piece onto the grid, turned the way it lies in the picture. Tap a piece to turn it.',
    available: true,
    options: [
      { key: 'cells', label: 'Cells across', min: 5, max: 10, def: 7 },
      { key: 'turned', label: 'Turned pieces', min: 0, max: 1, def: 1, toggle: true },
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 50, def: 20, step: 5 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  {
    id: 'strips',
    name: 'Strips',
    blurb: 'Strips cut out of the picture lie turned and scattered. Drag each back into its hole; tap a strip to turn it.',
    available: true,
    options: [
      { key: 'strips', label: 'Number of strips', min: 6, max: 40, def: 14 },
      { key: 'length', label: 'Longest strip', min: 3, max: 12, def: 8 },
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 50, def: 20, step: 5 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  { id: 'jigsaw', name: 'Jigsaw', blurb: 'Classic interlocking pieces.', available: false, options: [] },
  { id: 'sliding', name: 'Sliding Tiles', blurb: 'Slide the tiles into the empty space.', available: false, options: [] },
];

export function findKind(id: string): KindDef | undefined {
  return KINDS.find((k) => k.id === id);
}

/** Option values live in one flat map, keyed "kind.option". A missing or out-of-range value falls back to the default / the nearest limit. */
export type Settings = Record<string, number>;

export function optionValue(settings: Settings, kind: KindId, opt: OptionDef): number {
  const v = settings[`${kind}.${opt.key}`];
  if (typeof v !== 'number' || !Number.isFinite(v)) return opt.def;
  return Math.min(opt.max, Math.max(opt.min, Math.round(v)));
}

/** The current value of every option of a kind, by option key. */
export function optionsOf(settings: Settings, kind: KindDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of kind.options) out[o.key] = optionValue(settings, kind.id, o);
  return out;
}

/**
 * Identifies a puzzle for best times: the same photo, type and difficulty is the same puzzle whatever the seed, so a new seed keeps the record and only a
 * change of difficulty starts a new one (grid lines and animations are display settings and do not count).
 */
export function recordKey(kind: KindDef, photoId: string, settings: Settings): string {
  const opts = optionsOf(settings, kind);
  const difficulty = kind.options.filter((o) => !o.display).map((o) => o.key).sort();
  return [kind.id, photoId, ...difficulty.map((k) => `${k}=${opts[k]}`)].join('|');
}

/** The seed of one puzzle: the player's seed, mixed with the photo and the type so each photo / type gets its own puzzle from one seed. */
export function puzzleSeedText(seed: string, photoId: string, kind: KindId): string {
  return `${seed.trim().toUpperCase()}|${photoId}|${kind}`;
}
