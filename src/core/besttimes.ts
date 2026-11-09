import { SIZE, type KindDef, type KindId } from './kinds';

/**
 * Best times, one for each kind of puzzle and size, for regular puzzles and for fast mode ones (the file, the other options and the seed do not matter: a Large Jigsaw made from a photo and one made from a video compete for the
 * same place). What is kept is what the list shows: the time, the moves where the puzzle counts them, the file that was used (its name then, since the file may be removed later) and when.
 */
export interface BestTime {
  ms: number;
  /** The player's moves (swaps, slides, turns...), for the kinds that count them. */
  moves?: number;
  file: string;
  video: boolean;
  /** When the puzzle was solved (milliseconds since 1970). */
  at: number;
}

export type BestTimes = Record<string, BestTime>;

/** The key of a best time. Fast mode puzzles (see `isFast`) keep theirs apart from the regular ones. */
export const bestKey = (kind: KindId, size: number, fast = false): string => `${kind}|${size}${fast ? '|fast' : ''}`;

/** The names of a kind's sizes, with what each one sets in words: [{ name: 'S', detail: 'about 20 pieces' }, ...]. Nothing for a kind that has no sizes. */
export function sizeLabels(kind: KindDef): { name: string; detail: string }[] {
  const tiers = kind.options.find((o) => o.key === SIZE)?.tiers;
  return (kind.sizes?.values ?? []).map((v, i) => ({ name: tiers?.[i] ?? String(i + 1), detail: kind.sizes!.describe(v) }));
}

/** A new time for a size: true (and it takes the place of the old one) when it is faster than the one there, or there is none. */
export function recordBest(all: BestTimes, key: string, entry: BestTime): boolean {
  const old = all[key];
  if (old && old.ms <= entry.ms) return false;
  all[key] = entry;
  return true;
}
