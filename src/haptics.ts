/**
 * Touch feedback. `haptic('grab')` and the like ask the device to give a small buzz.
 *
 * Two ways, tried in this order:
 * 1. A host app can offer `PhotoPuzzlesNative.haptic(kind)` (the Android app does): it plays the phone's own tuned effects (the ones the system uses for a long press
 *    or a confirmation), which are felt on every phone. A web page can only ask for "vibrate for so many milliseconds", and a short buzz of that kind is often too
 *    weak for a phone's motor to show at all.
 * 2. `navigator.vibrate`, with pulses long enough to be felt.
 */

export type Haptic = 'grab' | 'drop' | 'join' | 'placed' | 'turn' | 'move' | 'solved';

/** Milliseconds, or on / off / on... for `navigator.vibrate`. */
const PATTERNS: Record<Haptic, number | number[]> = {
  grab: 35,
  drop: 25,
  join: 45,
  placed: [50, 45, 70],
  turn: 20,
  move: 30,
  solved: [60, 70, 60, 70, 220],
};

interface Native {
  haptic?: (kind: string) => void;
}

function native(): Native | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { PhotoPuzzlesNative?: Native }).PhotoPuzzlesNative;
}

/** Can this device give touch feedback (so that a switch for it is worth showing)? */
export function canHaptic(): boolean {
  return typeof native()?.haptic === 'function' || (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function');
}

export function haptic(kind: Haptic): void {
  try {
    const host = native();
    if (typeof host?.haptic === 'function') {
      host.haptic(kind);
      return;
    }
    if (typeof navigator !== 'undefined') navigator.vibrate?.(PATTERNS[kind]);
  } catch {
    // some browsers refuse until the page has been touched; the game does not depend on this
  }
}
