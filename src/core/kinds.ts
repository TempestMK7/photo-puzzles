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
  /** Shown as a slider that moves between these named sizes (the value is the index; min 0, max the last); the kind's `sizes` say what each one sets. */
  tiers?: string[];
  /** Added after puzzles were already being recorded and saved: at its default it stays out of the record key (and the difficulty in words), so what was kept before still matches. */
  later?: boolean;
}

export type KindId = 'focus' | 'overlap' | 'strips' | 'jigsaw' | 'sliding' | 'rotascope';

/** The difficulty of a kind as a few sizes: what each size sets (by option key, for the game to read), and how to say it in words. */
export interface SizesDef {
  values: Record<string, number>[];
  describe(v: Record<string, number>): string;
}

export interface KindDef {
  id: KindId;
  name: string;
  blurb: string;
  /** False: listed but not playable yet. */
  available: boolean;
  options: OptionDef[];
  /** The sizes the `size` option moves between, when the kind has them. */
  sizes?: SizesDef;
}

const SIZE_NAMES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
export const SIZE = 'size';

/** The slider between a kind's sizes: it starts at M. */
function sizeOption(count: number): OptionDef {
  return { key: SIZE, label: 'Size', min: 0, max: count - 1, def: 1, tiers: SIZE_NAMES.slice(0, count) };
}

/** The sizes of a kind from its table: one row for each, with the same columns. */
function sizesOf(columns: string[], rows: number[][], describe: (v: Record<string, number>) => string): SizesDef {
  return { values: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), describe };
}

/**
 * The settings that hold for every kind of puzzle, and are changed in the settings window rather than with the puzzle's options (they are about how the game looks and
 * feels, not how hard it is). Kept in the same map as the options, under "all.".
 */
export const GENERAL: OptionDef[] = [
  { key: 'grid', label: 'Grid lines', min: 0, max: 1, def: 1, toggle: true, display: true },
  { key: 'animate', label: 'Animations', min: 0, max: 1, def: 1, toggle: true, display: true },
  // touch feedback
  { key: 'haptics', label: 'Vibration', min: 0, max: 1, def: 1, toggle: true, display: true },
  // pieces picked up by a finger are held above it, so that the finger does not hide them
  { key: 'offset', label: 'Raise piece above touch point', min: 0, max: 1, def: 1, toggle: true, display: true },
  { key: 'light', label: 'Light background', min: 0, max: 1, def: 0, toggle: true, display: true },
];

export function generalValue(settings: Settings, key: string): number {
  const o = GENERAL.find((x) => x.key === key);
  const v = settings[`all.${key}`];
  if (!o || typeof v !== 'number' || !Number.isFinite(v)) return o?.def ?? 1;
  return Math.min(o.max, Math.max(o.min, Math.round(v)));
}

/** Before the settings were shared by every kind each had its own: take what the player had set, so that nothing they turned off comes back on. */
export function migrateGeneral(settings: Settings): void {
  for (const o of GENERAL) {
    if (typeof settings[`all.${o.key}`] === 'number') continue;
    for (const k of KINDS) {
      const old = settings[`${k.id}.${o.key}`];
      if (typeof old === 'number' && old !== o.def) {
        settings[`all.${o.key}`] = old;
        break;
      }
    }
  }
}

export const KINDS: readonly KindDef[] = [
  {
    id: 'focus',
    name: 'Tile Swap',
    blurb: 'Pieces of different sizes are shuffled. Click two to trade places and sizes. A piece that is in the right place locks there.',
    available: true,
    options: [sizeOption(5), { key: 'irregular', label: 'Irregular pieces', min: 0, max: 1, def: 1, toggle: true }],
    sizes: sizesOf(['pieces'], [[20], [50], [100], [200], [500]], (v) => `about ${v.pieces} pieces`),
  },
  {
    id: 'overlap',
    name: 'Overlap',
    blurb: 'Pieces that overlap wait in stacks: each has a centre square of its own and some squares around it that other pieces share. Drag the top piece onto the grid, centre first, turned the way it lies in the picture. Tap a piece to turn it.',
    available: true,
    options: [
      sizeOption(5),
      { key: 'turned', label: 'Turned pieces', min: 0, max: 1, def: 1, toggle: true },
      { key: 'windows', label: 'Window pieces', min: 0, max: 1, def: 1, toggle: true },
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 50, def: 20, step: 5 },
    ],
    sizes: sizesOf(['total', 'stacks'], [[50, 3], [100, 4], [200, 5], [500, 6], [1000, 7]], (v) => `about ${v.total} cells, ${v.stacks} trays`),
  },
  {
    id: 'strips',
    name: 'Strips',
    blurb: 'Strips cut out of the picture lie turned and scattered over tabs. Drag each back into its hole; tap a strip to turn it; drag one onto a tab to move it there.',
    available: true,
    options: [
      sizeOption(5),
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 50, def: 20, step: 5 },
    ],
    sizes: sizesOf(['cells', 'length', 'tabs'], [[50, 4, 4], [100, 6, 6], [200, 8, 8], [500, 10, 10], [1000, 12, 12]], (v) => `about ${v.cells} cells, strips up to ${v.length}, ${v.tabs} tabs`),
  },
  {
    id: 'jigsaw',
    name: 'Jigsaw',
    blurb: 'Classic interlocking pieces on a huge table. The corners are in place; join pieces to them and to each other. Wheel to zoom, right-drag to move. Click a piece to select it; right-click (or R) turns it when turning is on.',
    available: true,
    options: [
      sizeOption(6),
      { key: 'placed', label: 'Placed at the start (%)', min: 0, max: 80, def: 0, step: 5, later: true },
      { key: 'edges', label: 'Edge pieces start in the picture area', min: 0, max: 1, def: 0, toggle: true, later: true },
      { key: 'turning', label: 'Turned pieces', min: 0, max: 1, def: 0, toggle: true },
      { key: 'snap', label: 'Joining pieces', min: 0, max: 2, def: 0, choices: ['Snap while dragging', 'Snap when held together', 'Snap on release'] },
    ],
    sizes: sizesOf(['pieces'], [[50], [100], [200], [500], [1000], [2000]], (v) => `about ${v.pieces} pieces`),
  },
  {
    id: 'sliding',
    name: 'Sliding Tiles',
    blurb: 'The picture is cut into tiles and one is missing. Click a tile in the empty space\'s row or column to slide it (and the tiles in between) over.',
    available: true,
    options: [
      sizeOption(4),
    ],
    sizes: sizesOf(['tiles'], [[20], [50], [100], [200]], (v) => `about ${v.tiles} tiles`),
  },
  {
    id: 'rotascope',
    name: 'Rotascope',
    blurb: 'A round picture is cut into rings of wedges round an empty middle. Click a piece that touches the empty space to slide it in; it changes size and turns as it passes between rings.',
    available: true,
    options: [
      sizeOption(4),
    ],
    sizes: sizesOf(['rings', 'wedges'], [[2, 4], [3, 4], [4, 5], [5, 5]], (v) => `${v.rings} rings of ${v.wedges} pieces`),
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

/** The current value of every option of a kind, by option key; with the values that its size sets (the pieces, the cells...) among them. */
export function optionsOf(settings: Settings, kind: KindDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of kind.options) out[o.key] = optionValue(settings, kind.id, o);
  if (kind.sizes) Object.assign(out, kind.sizes.values[out[SIZE]]);
  return out;
}

/**
 * Identifies a puzzle for best times: the same photo, type and difficulty is the same puzzle whatever the seed, so a new seed keeps the record and only a
 * change of difficulty starts a new one (how it is shown - grid lines, animations - does not count).
 */
export function recordKey(kind: KindDef, photoId: string, settings: Settings): string {
  const opts = optionsOf(settings, kind);
  const difficulty = kind.options.filter((o) => !o.display && !(o.later && opts[o.key] === o.def)).map((o) => o.key).sort();
  return [kind.id, photoId, ...difficulty.map((k) => `${k}=${opts[k]}`)].join('|');
}

/** The difficulty options a recordKey holds ("cells=7|turned=1"), as settings, so that a saved puzzle can be set up again. */
export function settingsOfKey(kind: KindDef, key: string): Settings {
  const out: Settings = {};
  for (const part of key.split('|').slice(2)) {
    const [name, value] = part.split('=');
    const o = kind.options.find((x) => x.key === name && !x.display);
    const n = Number(value);
    if (o && Number.isFinite(n)) out[`${kind.id}.${o.key}`] = n;
  }
  return out;
}

/** The difficulty of a puzzle in words, for lists: "Approximate pieces: 300 · Turned pieces: off". */
export function describeDifficulty(kind: KindDef, settings: Settings): string {
  return kind.options
    .filter((o) => !o.display)
    .map((o) => ({ o, v: optionValue(settings, kind.id, o) }))
    .filter(({ o, v }) => !(o.later && v === o.def))
    .map(({ o, v }) => {
      if (o.tiers && kind.sizes) return `${o.label}: ${o.tiers[v]} (${kind.sizes.describe(kind.sizes.values[v])})`;
      if (o.toggle) return `${o.label}: ${v ? 'on' : 'off'}`;
      if (o.choices) return o.choices[v] ?? `${o.label}: ${v}`;
      return `${o.label}: ${v}`;
    })
    .join(' · ');
}

/** The seed of one puzzle: the player's seed, mixed with the photo and the type so each photo / type gets its own puzzle from one seed. */
export function puzzleSeedText(seed: string, photoId: string, kind: KindId): string {
  return `${seed.trim().toUpperCase()}|${photoId}|${kind}`;
}
