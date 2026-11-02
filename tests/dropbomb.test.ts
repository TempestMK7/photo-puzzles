import { afterEach, describe, expect, it, vi } from 'vitest';

const plan = { x: 0, y: 0, unit: 1, area: [], lo: 0.75, hi: 2 };

/** A stand-in for the bomb's drawing that notes what it was asked. */
const fake = () => {
  const calls: string[] = [];
  return { calls, fx: { drop: () => calls.push('drop'), explode: () => calls.push('explode'), cancelFall: () => calls.push('cancel') } as never };
};

afterEach(() => {
  vi.doUnmock('../src/sounds');
  vi.useRealTimers();
});

describe('Cascade, with a bomb that is still falling', () => {
  it('waits for the bomb to land before the first step, and does what is left at once (told) when cut short', async () => {
    vi.useFakeTimers();
    const { Cascade } = await import('../src/sessions/feedback');
    let ended = 0;
    const c = new Cascade(() => void ended++);
    const done: string[] = [];
    c.start([1, 2], 200, (item, _k, late) => done.push(`${item}${late ? '!' : ''}`), 1000);
    expect(done).toEqual([]);
    vi.advanceTimersByTime(999);
    expect(done).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(done).toEqual(['1']);
    c.flush();
    expect(done).toEqual(['1', '2!']);
    expect(ended).toBe(1);
    c.flush();
    expect(ended).toBe(1);                                              // (nothing was waiting)
    c.start([1, 2], 200, () => undefined, 1000);
    c.cancel();
    expect(ended).toBe(2);
  });
});

describe('dropBomb', () => {
  it('plays the fuse as it falls, then the explosion as it lands (stopping the fuse), and puts the pieces in place after that', async () => {
    vi.useFakeTimers();
    const played: string[] = [];
    vi.doMock('../src/sounds', () => ({ playEffect: (e: string) => played.push(e), stopEffect: (e: string) => played.push(`stop ${e}`) }));
    vi.resetModules();
    const { Cascade, dropBomb } = await import('../src/sessions/feedback');
    const f = fake();
    const placed: number[] = [];
    dropBomb(new Cascade(), f.fx, { flag: () => true } as never, plan, true, [7, 8, 9], (piece) => placed.push(piece));
    expect(f.calls).toEqual(['drop']);
    expect(played).toEqual(['fuse']);
    expect(placed).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(f.calls).toEqual(['drop', 'explode']);
    expect(played).toEqual(['fuse', 'stop fuse', 'explode']);
    expect(placed).toEqual([7]);
    vi.advanceTimersByTime(400);
    expect(placed).toEqual([7, 8, 9]);
  });

  it('makes no sound for another player\'s bomb, and has no fall and no fire with animations off', async () => {
    vi.useFakeTimers();
    const played: string[] = [];
    vi.doMock('../src/sounds', () => ({ playEffect: (e: string) => played.push(e), stopEffect: () => undefined }));
    vi.resetModules();
    const { Cascade, dropBomb } = await import('../src/sessions/feedback');
    const theirs = fake();
    dropBomb(new Cascade(), theirs.fx, { flag: () => true } as never, plan, false, [1], () => undefined);
    vi.advanceTimersByTime(1000);
    expect(played).toEqual([]);
    const off = fake();
    const placed: number[] = [];
    dropBomb(new Cascade(), off.fx, { flag: () => false } as never, plan, true, [1, 2], (p) => placed.push(p));
    expect(off.calls).toEqual(['explode']);                              // (no fall: the pieces start at once)
    expect(placed).toEqual([1]);
    expect(played).toEqual(['explode']);
  });
});
