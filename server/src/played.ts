import { topics, type RoomMessage } from '../../src/online/protocol';
import type { Clock, PubSub, RoomRecord, Store } from './types';

/**
 * The time spent on a puzzle played with friends: it counts only while at least one player is connected. A room keeps what has been counted (`ms`) and, while someone is
 * connected, when that began (`since`); the time now is the one plus the other. When the puzzle is solved the total is fixed in `solvedMs`. This is shown for fun; it is not a
 * best time.
 */
export interface Played {
  ms: number;
  since: number | null;
}

/** The time that counts for a room at `now`: its total once solved, else what was counted plus the stretch that is going on. */
export function playedMs(room: Pick<RoomRecord, 'played' | 'solvedMs'>, now: number): number {
  if (room.solvedMs !== undefined) return room.solvedMs;
  const p = room.played;
  return p ? p.ms + (p.since === null ? 0 : Math.max(0, now - p.since)) : 0;
}

export interface ActiveDeps {
  store: Pick<Store, 'getRoom' | 'putRoom'>;
  pubsub: PubSub;
  clock: Clock;
}

/**
 * Starts the count (someone has connected to a room that nobody was connected to) or stops it (the last one has gone), and tells the room. `fresh` says that nobody was connected
 * before this: a count that had not been stopped then is one whose "disconnected" was lost, and the stretch it covers is not counted (a little time is lost, none is made up).
 */
export async function setActive(d: ActiveDeps, roomId: string, active: boolean, fresh = false): Promise<void> {
  const now = d.clock.now();
  for (let attempt = 0; attempt < 6; attempt++) {
    const room = await d.store.getRoom(roomId);
    if (!room || room.solvedMs !== undefined || room.status === 'solved') return;
    const was = room.played ?? { ms: 0, since: null };
    let next: Played;
    if (active) {
      if (was.since !== null && !fresh) return;
      next = { ms: was.ms, since: now };
    } else {
      if (was.since === null) return;
      next = { ms: was.ms + Math.max(0, now - was.since), since: null };
    }
    if (await d.store.putRoom({ ...room, played: next, rev: room.rev + 1 })) {
      await d.pubsub.publish(topics.events(roomId), { t: 'played', ms: next.ms, since: next.since } satisfies RoomMessage);
      return;
    }
  }
}
