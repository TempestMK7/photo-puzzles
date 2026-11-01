import { describe, expect, it } from 'vitest';
import { applyBoardOp, boardCheck, BoardRoom, buildBoard, type BoardKind, type RoomSetup } from '../src/core/boardRoom';
import { hasHelp, hintsFor, HINTS_LARGE, HINTS_SMALL } from '../src/core/help';
import { JigsawRoom, type RoomEvent } from '../src/core/jigsawRoom';
import { applyOp, buildJigsaw } from '../src/core/jigsawSetup';
import { findKind, optionsOf } from '../src/core/kinds';

const SETUPS: Record<BoardKind, RoomSetup> = {
  focus: { kind: 'focus', seed: 11, width: 400, height: 300, opts: { pieces: 50, irregular: 1 } },
  overlap: { kind: 'overlap', seed: 12, width: 400, height: 300, opts: { total: 100, stacks: 3, turned: 1, windows: 1, placed: 20 } },
  strips: { kind: 'strips', seed: 13, width: 400, height: 300, opts: { cells: 100, length: 6, tabs: 4, placed: 20 } },
};

const placedCount = (b: ReturnType<typeof buildBoard>): number =>
  b.kind === 'focus' ? b.game.slotOf.filter((s, i) => s === i).length : b.kind === 'overlap' ? b.game.done.filter(Boolean).length : b.game.state.filter((s) => s.locked).length;

describe('which puzzles have hints and bombs', () => {
  it('leaves out the two in which a piece put in place by hand could make the rest impossible', () => {
    expect(['focus', 'overlap', 'strips', 'jigsaw'].every(hasHelp)).toBe(true);
    expect(hasHelp('sliding')).toBe(false);
    expect(hasHelp('rotascope')).toBe(false);
  });
});

describe('what a solved puzzle gives', () => {
  it('is one hint for S and M and two for anything larger, in every kind', () => {
    for (const id of ['focus', 'overlap', 'strips', 'jigsaw', 'sliding', 'rotascope'] as const) {
      const kind = findKind(id)!;
      const sizes = kind.sizes!.values.length;
      for (let i = 0; i < sizes; i++) {
        expect(hintsFor(kind, optionsOf({ [`${id}.size`]: i }, kind))).toBe(i < 2 ? HINTS_SMALL : HINTS_LARGE);
      }
    }
  });

  it('reads the numbers a room was made with, whatever they are', () => {
    const jig = findKind('jigsaw')!;
    expect(hintsFor(jig, { pieces: 100 })).toBe(1);
    expect(hintsFor(jig, { pieces: 101 })).toBe(2);
    expect(hintsFor(jig, { pieces: 1000 })).toBe(2);
  });
});

describe.each(Object.keys(SETUPS) as BoardKind[])('a hint and a bomb in %s', (kind) => {
  const setup = SETUPS[kind] as RoomSetup & { kind: BoardKind };

  const firstLoose = (b: ReturnType<typeof buildBoard>): number => {
    if (b.kind === 'focus') return b.game.slotOf.findIndex((s, i) => s !== i);
    if (b.kind === 'overlap') return b.game.done.findIndex((d) => !d);
    return b.game.state.findIndex((s) => !s.locked);
  };

  it('places the piece, once, and refuses it when it is placed already', () => {
    const b = buildBoard(setup);
    const before = placedCount(b);
    const piece = firstLoose(b);
    expect(applyBoardOp(b, { t: 'hint', piece })).toMatchObject({ ok: true, placed: true });
    expect(placedCount(b)).toBeGreaterThan(before);
    expect(applyBoardOp(b, { t: 'hint', piece })).toMatchObject({ ok: false, stale: true });
    expect(applyBoardOp(b, { t: 'hint', piece: -1 })).toEqual({ ok: false });
    expect(applyBoardOp(b, { t: 'hint', piece: 1e9 })).toEqual({ ok: false });
  });

  it('places everything round a point with a bomb, and several pieces at once', () => {
    const b = buildBoard(setup);
    const before = placedCount(b);
    // the middle of the picture (picture pixels for Tile Swap, a cell for the others)
    const at = b.kind === 'focus' ? { x: 200, y: 150 } : b.kind === 'overlap' ? { x: Math.floor(b.cols / 2), y: Math.floor(b.rows / 2) } : { x: Math.floor(b.game.cols / 2), y: Math.floor(b.game.rows / 2) };
    const res = applyBoardOp(b, { t: 'bomb', ...at });
    expect(res.ok).toBe(true);
    expect(placedCount(b) - before).toBeGreaterThanOrEqual(2);
  });

  it('refuses a bomb that has nothing to place, and numbers that make no sense', () => {
    const b = buildBoard(setup);
    const at = b.kind === 'focus' ? { x: 200, y: 150 } : b.kind === 'overlap' ? { x: 5, y: 5 } : { x: 6, y: 6 };
    expect(applyBoardOp(b, { t: 'bomb', ...at }).ok).toBe(true);
    expect(applyBoardOp(b, { t: 'bomb', ...at })).toMatchObject({ ok: false, stale: true });
    expect(applyBoardOp(b, { t: 'bomb', x: -1, y: 0 })).toEqual({ ok: false });
    expect(applyBoardOp(b, { t: 'bomb', x: Number.NaN, y: 0 })).toEqual({ ok: false });
    expect(applyBoardOp(b, { t: 'bomb', x: 1e9, y: 0 })).toEqual({ ok: false });
  });

  it('is the same on a screen that only applies the room\'s events', () => {
    const room = new BoardRoom(setup);
    const copy = buildBoard(setup);
    const piece = firstLoose(room.board);
    const at = copy.kind === 'focus' ? { x: 100, y: 100 } : copy.kind === 'overlap' ? { x: 4, y: 4 } : { x: 7, y: 7 };
    for (const op of [{ t: 'hint', piece } as const, { t: 'bomb', ...at } as const]) {
      const res = room.submit('ann', op, 0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      applyBoardOp(copy, res.event.op as typeof op);
      expect(boardCheck(copy)).toBe(res.event.groups);
      expect(copy.game.snapshot()).toEqual(room.board.game.snapshot());
    }
  });

  it('can be used until the puzzle is solved, and then the room refuses them like everything else', () => {
    const room = new BoardRoom(setup);
    for (let guard = 0; !room.solved && guard < 2000; guard++) {
      const piece = firstLoose(room.board);
      const res = room.submit('ann', { t: 'hint', piece }, 0);
      expect(res.ok).toBe(true);
    }
    expect(room.solved).toBe(true);
    expect(room.submit('ann', { t: 'hint', piece: 0 }, 0)).toMatchObject({ ok: false, reason: 'ended' });
  });
});

describe('a hint in Tile Swap', () => {
  it('trades the piece with the one in its home, which is not counted as a swap', () => {
    const b = buildBoard(SETUPS.focus as RoomSetup & { kind: 'focus' });
    if (b.kind !== 'focus') return;
    const g = b.game;
    const piece = g.slotOf.findIndex((s, i) => s !== i);
    const sitter = g.slotOf.indexOf(piece);
    const where = g.slotOf[piece];
    const swaps = g.swaps;
    expect(g.hint(piece)).toBe(true);
    expect(g.slotOf[piece]).toBe(piece);
    expect(g.slotOf[sitter]).toBe(where);
    expect(g.swaps).toBe(swaps);
  });
});

describe('a hint and a bomb in a Jigsaw', () => {
  const setup = { seed: 5, width: 800, height: 600, opts: { pieces: 100, turning: 1 } };

  it('puts the piece\'s whole group in the picture, joined to what lies there', () => {
    const { game } = buildJigsaw(setup);
    const loose = [...game.groups.values()].find((g) => !g.anchored)!;
    const piece = loose.members[0];
    expect(applyOp(game, { t: 'hint', piece }).joins).toBe(1);
    const g = game.groups.get(game.groupOf[piece])!;
    expect(g.anchored).toBe(true);
    expect([g.dx, g.dy, g.rot]).toEqual([0, 0, 0]);
    expect(game.z).not.toContain(g.id);
    expect(game.anchorGroup(piece)).toBe(false);                    // (again: nothing left to do)
  });

  it('places every piece round a point, and the pieces joined to them', () => {
    const { game, layout } = buildJigsaw(setup);
    const before = game.anchoredCount;
    const s = layout.size;
    const res = game.bomb((layout.cols / 2 + 0.5) * s, (layout.rows / 2 + 0.5) * s);
    expect(res.length).toBeGreaterThanOrEqual(3);
    expect(game.anchoredCount).toBeGreaterThanOrEqual(before + res.length);
    for (const i of res) expect(game.groups.get(game.groupOf[i])!.anchored).toBe(true);
  });

  it('can be used until the picture is whole', () => {
    const { game } = buildJigsaw(setup);
    for (let guard = 0; !game.solved && guard < 500; guard++) {
      const loose = [...game.groups.values()].find((g) => !g.anchored)!;
      game.anchorGroup(loose.members[0]);
    }
    expect(game.solved).toBe(true);
  });

  describe('in a room', () => {
    const room = (): JigsawRoom => new JigsawRoom(setup);
    const loosePiece = (r: JigsawRoom): number => [...r.board.game.groups.values()].find((g) => !g.anchored)!.members[0];

    it('applies a hint for anyone, and an event applied to a copy gives the same board', () => {
      const r = room();
      const copy = buildJigsaw(setup);
      const piece = loosePiece(r);
      const res = r.submit('ann', { t: 'hint', piece }, 1000);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      applyOp(copy.game, res.event.op as never);
      expect(copy.game.snapshot()).toEqual(r.board.game.snapshot());
      expect(res.event.groups).toBe(copy.game.groups.size);
      expect(r.submit('bob', { t: 'hint', piece }, 1001)).toMatchObject({ ok: false, reason: 'no-group' });          // (it is in the picture now)
    });

    it('does not place a piece that another player has chosen, but lets a bomb through and frees what it placed', () => {
      const r = room();
      const piece = loosePiece(r);
      expect(r.submit('bob', { t: 'grab', piece }, 1000).ok).toBe(true);
      expect(r.submit('ann', { t: 'hint', piece }, 1001)).toMatchObject({ ok: false, reason: 'busy', holder: 'bob' });
      const { layout } = r.board;
      const home = { x: ((piece % layout.cols) + 0.5) * layout.size, y: (Math.floor(piece / layout.cols) + 0.5) * layout.size };
      const res = r.submit('ann', { t: 'bomb', ...home }, 1002);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.event.lock).toBeNull();                              // bob's hand is on a piece that is in the picture now: it is let go
      expect(res.event.reserved.filter((x) => x.piece === piece)).toEqual([]);
      expect(r.submit('bob', { t: 'drop', piece, dx: 0, dy: 0, rot: 0, tol: 10 }, 1003).ok).toBe(false);
    });

    it('refuses numbers that make no sense, and a bomb with nothing to place', () => {
      const r = room();
      expect(r.submit('ann', { t: 'hint', piece: -3 } as never, 0)).toMatchObject({ ok: false, reason: 'bad' });
      expect(r.submit('ann', { t: 'bomb', x: Number.NaN, y: 0 } as never, 0)).toMatchObject({ ok: false, reason: 'bad' });
      expect(r.submit('ann', { t: 'bomb', x: -5000, y: -5000 }, 0)).toMatchObject({ ok: false, reason: 'no-group' });
    });

    it('ends when the last group is placed', () => {
      const r = room();
      let last: RoomEvent | undefined;
      for (let guard = 0; !r.solved && guard < 500; guard++) {
        const res = r.submit('ann', { t: 'hint', piece: loosePiece(r) }, guard);
        if (res.ok) last = res.event;
      }
      expect(r.solved).toBe(true);
      expect(last?.solved).toBe(true);
    });
  });
});
