/**
 * The game's own sound effects. They have a switch of their own, apart from the sound of a video puzzle (the video's, with its own button on the playback bar): a player who
 * wants the video quiet still hears the effects, and the other way round. Browsers (and the Android web view) only let a page make a sound after the player has touched it,
 * which a puzzle's end always follows, so a refused `play()` is not an error.
 */
import explode from './sounds/explode.mp3?url';
import fuse from './sounds/fuse.mp3?url';
import incorrect from './sounds/incorrect.wav?url';
import partyBlower from './sounds/party-blower.mp3?url';
import pickup from './sounds/pickup.wav?url';
import drop from './sounds/drop.wav?url';
import rotate from './sounds/rotate.wav?url';
import select from './sounds/select.wav?url';
import successBell from './sounds/success-bell.mp3?url';

/**
 * solved: the puzzle is done; placed: a piece is in its place; select: a piece is chosen; pickup: a piece is lifted (or traded); drop: a piece is set down loose (or put back in a tray); rotate: a piece is turned; wrong: a piece does not go there;
 * fuse: a bomb is falling (it is not looped, and is stopped when the bomb lands); explode: the bomb has landed.
 */
export type Effect = 'solved' | 'placed' | 'select' | 'pickup' | 'drop' | 'rotate' | 'wrong' | 'fuse' | 'explode';

const FILES: Record<Effect, string> = { solved: partyBlower, placed: successBell, select, pickup, drop, rotate, wrong: incorrect, fuse, explode };

const players = new Map<Effect, HTMLAudioElement>();
/** The copies of each effect that are sounding, so that one can be stopped (the fuse ends when the bomb lands). */
const sounding = new Map<Effect, Set<HTMLAudioElement>>();
const listeners = new Set<() => void>();
/** The effects that are waiting for their moment (see `playEffect`'s delay). */
const waiting = new Set<ReturnType<typeof setTimeout>>();
let on = true;
/** How loud the effects are, from 0 to 1 of the volume the files have (the settings window's slider; it starts at half). */
let volume = 0.5;

export function effectsVolume(): number {
  return volume;
}

export function setEffectsVolume(value: number): void {
  volume = Math.min(1, Math.max(0, value));
  for (const a of players.values()) a.volume = volume;
}

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

/**
 * Plays an effect from its start, unless the player has switched effects off, `delayMs` from now if asked (a bell that is to ring as a ripple begins). An effect that is
 * still sounding when it is asked for again goes on, and the new one sounds over it (a row of bells ring into each other).
 */
export function playEffect(effect: Effect, delayMs = 0): void {
  if (!on) return;
  if (delayMs > 0) {
    const timer = setTimeout(() => {
      waiting.delete(timer);
      playEffect(effect);
    }, delayMs);
    waiting.add(timer);
    return;
  }
  try {
    let a = player(effect);
    if (!a) return;
    if (a.paused === false) a = new Audio(FILES[effect]);                  // (the browser has the file already)
    a.volume = volume;
    a.currentTime = 0;
    void a.play().catch(() => undefined);
    const set = sounding.get(effect) ?? new Set<HTMLAudioElement>();
    sounding.set(effect, set);
    set.add(a);
    a.addEventListener?.('ended', () => set.delete(a), { once: true });
  } catch {
    // no audio here: the game does not depend on it
  }
}

/** Stops an effect that is sounding (every copy of it): the fuse of a bomb that has landed. Nothing happens if it is not. */
export function stopEffect(effect: Effect): void {
  const set = sounding.get(effect);
  if (!set) return;
  for (const a of set) {
    try {
      a.pause();
      a.currentTime = 0;
    } catch {
      /* no audio here */
    }
  }
  set.clear();
}

/** Drops the effects that were asked for later and have not begun (the puzzle they belong to has been left). */
export function cancelEffects(): void {
  for (const timer of waiting) clearTimeout(timer);
  waiting.clear();
}
