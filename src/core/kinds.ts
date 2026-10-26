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
  /** Shown as a list of named choices (the value is the index; min 0, max the last). */
  choices?: string[];
  /** A way of showing the puzzle, not a difficulty: it does not start a new best-time record. */
  display?: boolean;
}

export type KindId = 'focus' | 'overlap' | 'strips' | 'jigsaw' | 'sliding' | 'rotascope';

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
      { key: 'cells', label: 'Cells across', min: 5, max: 16, def: 7 },
      { key: 'turned', label: 'Turned pieces', min: 0, max: 1, def: 1, toggle: true },
      { key: 'windows', label: 'Window pieces', min: 0, max: 1, def: 1, toggle: true },
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 50, def: 20, step: 5 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  {
    id: 'strips',
    name: 'Strips',
    blurb: 'Strips cut out of the picture lie turned and scattered over tabs. Drag each back into its hole; tap a strip to turn it; drag one onto a tab to move it there.',
    available: true,
    options: [
      { key: 'cells', label: 'Cells across', min: 6, max: 40, def: 16 },
      { key: 'length', label: 'Longest strip', min: 3, max: 12, def: 8 },
      { key: 'tabs', label: 'Tabs', min: 1, max: 10, def: 3 },
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 50, def: 20, step: 5 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  {
    id: 'jigsaw',
    name: 'Jigsaw',
    blurb: 'Classic interlocking pieces on a huge table. The corners are in place; join pieces to them and to each other. Wheel to zoom, right-drag to move. Click a piece to select it; right-click (or R) turns it when turning is on.',
    available: true,
    options: [
      { key: 'pieces', label: 'Approximate pieces', min: 100, max: 5000, def: 300, step: 100 },
      { key: 'turning', label: 'Turned pieces', min: 0, max: 1, def: 0, toggle: true },
      { key: 'snap', label: 'Joining pieces', min: 0, max: 2, def: 0, choices: ['Snap while dragging', 'Snap when held together', 'Snap on release'] },
      { key: 'haptics', label: 'Vibration', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  {
    id: 'sliding',
    name: 'Sliding Tiles',
    blurb: 'The picture is cut into tiles and one is missing. Click a tile in the empty space\'s row or column to slide it (and the tiles in between) over.',
    available: true,
    options: [
      { key: 'tiles', label: 'Approximate tiles', min: 8, max: 99, def: 15 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
      { key: 'animate', label: 'Animations', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
  {
    id: 'rotascope',
    name: 'Rotascope',
    blurb: 'A round picture is cut into rings of wedges round an empty middle. Click a piece that touches the empty space to slide it in; it changes size and turns as it passes between rings.',
    available: true,
    options: [
      { key: 'rings', label: 'Rings', min: 2, max: 6, def: 3 },
      { key: 'wedges', label: 'Wedges in each ring', min: 3, max: 12, def: 5 },
      { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
      { key: 'animate', label: 'Animations', min: 0, max: 1, def: 1, toggle: true, display: true },
    ],
  },
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
