import type { KindId } from '../core/kinds';
import { FocusSession } from './focus';
import { JigsawSession } from './jigsaw';
import { OverlapSession } from './overlap';
import { StripsSession } from './strips';
import type { PuzzleSession, SessionFactory } from './types';

/** How to start a puzzle of each playable type. */
const FACTORIES: Partial<Record<KindId, SessionFactory>> = {
  focus: (init) => new FocusSession(init),
  overlap: (init) => new OverlapSession(init),
  strips: (init) => new StripsSession(init),
  jigsaw: (init) => new JigsawSession(init),
};

export function startSession(kind: KindId, init: Parameters<SessionFactory>[0]): PuzzleSession {
  const make = FACTORIES[kind];
  if (!make) throw new Error(`${kind} cannot be played yet`);
  return make(init);
}

export type { PuzzleSession } from './types';
