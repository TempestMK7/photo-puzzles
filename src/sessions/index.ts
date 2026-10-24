import type { KindId } from '../core/kinds';
import { FocusSession } from './focus';
import { JigsawSession } from './jigsaw';
import { glAvailable } from './jigsawGl';
import { OverlapSession } from './overlap';
import { RotascopeSession } from './rotascope';
import { SlidingSession } from './sliding';
import { StripsSession } from './strips';
import type { PuzzleSession, SessionFactory } from './types';

/** How to start a puzzle of each playable type. */
const FACTORIES: Partial<Record<KindId, SessionFactory>> = {
  focus: (init) => new FocusSession(init),
  overlap: (init) => new OverlapSession(init),
  strips: (init) => new StripsSession(init),
  jigsaw: (init) => new JigsawSession(init),
  sliding: (init) => new SlidingSession(init),
  rotascope: (init) => new RotascopeSession(init),
};

export function startSession(kind: KindId, init: Parameters<SessionFactory>[0]): PuzzleSession {
  const make = FACTORIES[kind];
  if (!make) throw new Error(`${kind} cannot be played yet`);
  return make(init);
}

/** Pieces cut from a still picture (so a video has to be stopped at its first picture, the same one every time): Jigsaw, where the browser cannot draw video pieces. */
export function needsStill(kind: KindId): boolean {
  return kind === 'jigsaw' && !glAvailable();
}

export type { PuzzleSession } from './types';
