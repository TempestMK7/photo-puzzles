import { KINDS, type KindDef, type KindId } from './kinds';
import type { HelpKind } from './help';

/**
 * The achievements: the list, and the rules that unlock them. Nothing here knows about a screen or a store (Google Play, Steam and Game Center each get told about an unlock by the
 * shell of its platform; the ids below are what they map their own ids from, so an id is never changed or reused once the game has been released).
 */

/** What the game counts across all the puzzles a player has played on this device. */
export type Counter = 'hints' | 'bombs' | 'solved';

/** Something the player did that an achievement can be about. */
export type GameEvent =
  | {
      type: 'solved';
      kind: KindId;
      /** The puzzle's size, as the position of its size in the kind's table (0 is S, 2 is L). */
      size: number;
      video: boolean;
      /** Played with friends. */
      online: boolean;
      /** What this solve is called, when the same one may be told twice (a puzzle played with friends is told again to whoever opens it again): it counts once. */
      once?: string;
    }
  | { type: 'help'; help: HelpKind };

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  /** Unlocked when the counter gets to the target; the screen shows how far it is. */
  counter?: { name: Counter; target: number };
  /** Unlocked by an event that this says yes to. */
  when?: (e: GameEvent) => boolean;
}

/** The first size that counts as large (S, M, L). */
export const LARGE = 2;

const onSolved = (f: (e: Extract<GameEvent, { type: 'solved' }>) => boolean) => (e: GameEvent) => e.type === 'solved' && f(e);

/** The first puzzle solved of each kind. */
const firstOfEach: AchievementDef[] = KINDS.filter((k) => k.available).map((k) => ({
  id: `first_${k.id}`,
  name: `First ${k.name}`,
  description: `Solve a ${k.name} puzzle.`,
  when: onSolved((e) => e.kind === k.id),
}));

/** A puzzle of each kind, Large or bigger. */
const largeOfEach: AchievementDef[] = KINDS.filter((k) => k.available && k.sizes).map((k) => ({
  id: `large_${k.id}`,
  name: `Large ${k.name}`,
  description: `Solve a ${k.name} puzzle of size L or bigger.`,
  when: onSolved((e) => e.kind === k.id && e.size >= LARGE),
}));

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: 'first_solve', name: 'First Solve', description: 'Solve a puzzle.', counter: { name: 'solved', target: 1 } },
  { id: 'solved_10', name: 'Puzzle Fan', description: 'Solve 10 puzzles.', counter: { name: 'solved', target: 10 } },
  { id: 'solved_50', name: 'Puzzle Master', description: 'Solve 50 puzzles.', counter: { name: 'solved', target: 50 } },
  { id: 'solved_100', name: 'Puzzle Legend', description: 'Solve 100 puzzles.', counter: { name: 'solved', target: 100 } },
  { id: 'solve_video', name: 'Moving Picture', description: 'Solve a puzzle made from a video.', when: onSolved((e) => e.video) },
  { id: 'solve_online', name: 'Better Together', description: 'Solve a puzzle with friends.', when: onSolved((e) => e.online) },
  { id: 'use_hint', name: 'A Little Help', description: 'Use a hint.', counter: { name: 'hints', target: 1 } },
  { id: 'use_bomb', name: 'Fire in the Hole', description: 'Use a bomb.', counter: { name: 'bombs', target: 1 } },
  { id: 'hints_50', name: 'Hint Addict', description: 'Use 50 hints.', counter: { name: 'hints', target: 50 } },
  { id: 'bombs_10', name: 'Demolition Crew', description: 'Use 10 bombs.', counter: { name: 'bombs', target: 10 } },
  ...firstOfEach,
  ...largeOfEach,
];

export function findAchievement(id: string): AchievementDef | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

/** What is kept of a player's achievements: when each was unlocked, the counters, and the solves that were told already. */
export interface AchievementState {
  unlocked: Record<string, number>;
  counts: Record<Counter, number>;
  once: string[];
}

export const emptyAchievements = (): AchievementState => ({ unlocked: {}, counts: { hints: 0, bombs: 0, solved: 0 }, once: [] });

/** How many of the solves that were told already are remembered. */
const ONCE_KEPT = 50;

/** The position of a size in a kind's table, from the numbers the size sets (what a puzzle played with friends holds): the biggest size that is not bigger than them. */
export function sizeIndexOf(kind: KindDef, opts: Record<string, number>): number {
  const rows = kind.sizes?.values;
  if (!rows?.length) return 0;
  const key = Object.keys(rows[0])[0];
  let found = 0;
  rows.forEach((row, i) => {
    if (row[key] <= opts[key]) found = i;
  });
  return found;
}

/** Takes an event into the state (which it changes) and says which achievements it unlocked, with `now` as the time. */
export function applyEvent(state: AchievementState, e: GameEvent, now: number): AchievementDef[] {
  if (e.type === 'solved') {
    if (e.once) {
      if (state.once.includes(e.once)) return [];
      state.once.push(e.once);
      if (state.once.length > ONCE_KEPT) state.once.splice(0, state.once.length - ONCE_KEPT);
    }
    state.counts.solved++;
  } else if (e.help === 'hint') state.counts.hints++;
  else state.counts.bombs++;
  const out: AchievementDef[] = [];
  for (const a of ACHIEVEMENTS) {
    if (state.unlocked[a.id] !== undefined) continue;
    if ((a.counter && state.counts[a.counter.name] >= a.counter.target) || a.when?.(e)) {
      state.unlocked[a.id] = now;
      out.push(a);
    }
  }
  return out;
}

/** How far along an achievement is (the counter, not above its target), or nothing when it has no counter. */
export function progressOf(state: AchievementState, a: AchievementDef): { current: number; target: number } | undefined {
  if (!a.counter) return undefined;
  return { current: Math.min(state.counts[a.counter.name], a.counter.target), target: a.counter.target };
}
