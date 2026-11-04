import { describe, expect, it } from 'vitest';
import { BoardRoom, openRoom, type BoardKind, type RoomSetup } from '../src/core/boardRoom';
import { JigsawRoom } from '../src/core/jigsawRoom';

// Each player's count of pieces they put in the picture: what an operation adds is its player's, and what was in place from the start is nobody's.

const SETUPS: Record<BoardKind, RoomSetup> = {
  focus: { kind: 'focus', seed: 11, width: 400, height: 300, opts: { pieces: 20, irregular: 1 } },
  overlap: { kind: 'overlap', seed: 12, width: 400, height: 300, opts: { total: 50, stacks: 3, turned: 1, windows: 1, placed: 20 } },
  strips: { kind: 'strips', seed: 13, width: 400, height: 300, opts: { cells: 50, length: 4, tabs: 4 } },
};

const sum = (credits: Record<string, number> | undefined): number => Object.values(credits ?? {}).reduce((a, b) => a + b, 0);

describe.each(Object.keys(SETUPS) as BoardKind[])('the credits of a %s room', (kind) => {
  it('start empty, whatever starts in place, and count what a hint puts in place for the player who used it', () => {
    const room = new BoardRoom(SETUPS[kind] as RoomSetup & { kind: BoardKind });
    expect(room.state().credits).toEqual({});
    const g = room.board.game as { solved: boolean };
    expect(g.solved).toBe(false);
    // hint pieces until one is accepted, as ann, then another as bob
    const ids = Array.from({ length: 20 }, (_, i) => i);
    const hint = (by: string): number => {
      for (const piece of ids) {
        const res = room.submit(by, { t: 'hint', piece }, 0);
        if (res.ok) return sum(res.event.credits);
      }
      throw new Error('nothing to hint');
    };
    expect(hint('ann')).toBe(1);
    expect(room.state().credits).toEqual({ ann: 1 });
    expect(hint('bob')).toBe(2);
    expect(room.state().credits).toEqual({ ann: 1, bob: 1 });
  });

  it('are kept when the room is made again from its state, and go on from there', () => {
    const first = new BoardRoom(SETUPS[kind] as RoomSetup & { kind: BoardKind });
    for (let piece = 0; piece < 20; piece++) if (first.submit('ann', { t: 'hint', piece }, 0).ok) break;
    const again = openRoom(SETUPS[kind], first.state());
    expect(again.state().credits).toEqual({ ann: 1 });
    for (let piece = 0; piece < 20; piece++) if (again.submit('bob', { t: 'hint', piece }, 0).ok) break;
    expect(again.state().credits).toEqual({ ann: 1, bob: 1 });
  });

  it('count a bomb\'s pieces for the player who dropped it, all of them', () => {
    const room = new BoardRoom(SETUPS[kind] as RoomSetup & { kind: BoardKind });
    const at = kind === 'focus' ? { x: 200, y: 150 } : { x: 3, y: 3 };
    const res = room.submit('ann', { t: 'bomb', ...at }, 0);
    if (!res.ok) return;                                                               // (nothing lay there to place on this small board)
    expect(res.event.credits!.ann).toBeGreaterThanOrEqual(1);
    expect(sum(res.event.credits)).toBe(res.event.credits!.ann);
  });
});

describe('the credits of a Jigsaw room', () => {
  const setup = { kind: 'jigsaw' as const, seed: 5, width: 600, height: 400, opts: { pieces: 24, placed: 6 } };

  it('start empty, though some pieces start in the picture, and count what a hint puts there for its player', () => {
    const room = new JigsawRoom(setup);
    expect(room.state().credits).toEqual({});
    const g = room.board.game;
    const before = g.anchoredCount;
    expect(before).toBeGreaterThan(0);
    let credited = 0;
    for (let piece = 0; piece < g.count && credited < 2; piece++) {
      const res = room.submit('ann', { t: 'hint', piece }, 0);
      if (res.ok) credited = res.event.credits?.ann ?? 0;
    }
    expect(credited).toBeGreaterThan(0);
    expect(g.anchoredCount - before).toBe(credited);                                  // (the pieces that were placed from the start are not in it)
    expect(room.state().credits).toEqual({ ann: credited });
    expect(new JigsawRoom(setup, room.state()).state().credits).toEqual({ ann: credited });
  });
});
