/**
 * The game's own sound effects. They have a switch of their own, apart from the sound of a video puzzle (the video's, with its own button on the playback bar): a player who
 * wants the video quiet still hears the effects, and the other way round. Browsers (and the Android web view) only let a page make a sound after the player has touched it,
 * which a puzzle's end always follows, so a refused `play()` is not an error.
 */
import incorrect from './sounds/incorrect.wav?url';
import partyBlower from './sounds/party-blower.mp3?url';
import pickup from './sounds/pickup.wav?url';
import place from './sounds/place.wav?url';
import select from './sounds/select.wav?url';
import successBell from './sounds/success-bell.mp3?url';

/** solved: the puzzle is done; placed: a piece is in its place; select: a piece is chosen; pickup: a piece is lifted (or traded); drop: a piece is set down loose; wrong: a piece does not go there. */
export type Effect = 'solved' | 'placed' | 'select' | 'pickup' | 'drop' | 'wrong';

const FILES: Record<Effect, string> = { solved: partyBlower, placed: successBell, select, pickup, drop: place, wrong: incorrect };

const players = new Map<Effect, HTMLAudioElement>();
const listeners = new Set<() => void>();
let on = true;

export function effectsOn(): boolean {
  return on;
}

export function setEffectsOn(value: boolean): void {
  if (value === on) return;
  on = value;
  for (const fn of listeners) fn();
}

/** Calls `fn` whenever the switch changes (from either screen's button); returns what stops it. */
export function onEffectsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function player(effect: Effect): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null;
  let a = players.get(effect);
  if (!a) {
    a = new Audio(FILES[effect]);
    a.preload = 'auto';
    players.set(effect, a);
  }
  return a;
}

/** Starts loading the effects, so that the first one is not late. */
export function preloadEffects(): void {
  for (const effect of Object.keys(FILES) as Effect[]) player(effect);
}

/** Plays an effect from its start, unless the player has switched effects off. */
export function playEffect(effect: Effect): void {
  if (!on) return;
  try {
    const a = player(effect);
    if (!a) return;
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  } catch {
    // no audio here: the game does not depend on it
  }
}
