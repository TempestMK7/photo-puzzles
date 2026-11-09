import { describe, expect, it } from 'vitest';
import { cleanPuzzleSettings } from '../src/core/kinds';
import { buildJigsaw } from '../src/core/jigsawSetup';
import { makeOverlap } from '../src/core/overlap';
import { Prefs } from '../src/core/prefs';
import { makeStrips } from '../src/core/strips';
import { SettingsSync } from '../src/online/settingsSync';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import type { Clock } from '../server/src/types';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, world, type MakeStore } from './helpers/world';

// Lock Piece Orientation and Placed At The Start in the three puzzles that have the fast mode options, and the last used settings kept for the account.

const share = (n: number, percent: number): number => Math.min(n - 1, Math.round((n * percent) / 100));

describe('Overlap', () => {
  const opts = { total: 100, stacks: 4 };

  it('places that share of the pieces at random, and the pieces are the same whatever is placed', () => {
    const none = makeOverlap(7, 400, 300, { ...opts, placed: 0 }).game;
    const some = makeOverlap(7, 400, 300, { ...opts, placed: 40 }).game;
    expect(none.done.some(Boolean)).toBe(false);
    expect(some.done.filter(Boolean)).toHaveLength(share(some.total, 40));
    expect(some.pieces).toEqual(none.pieces);
    for (const stack of some.stacks) for (const id of stack) expect(some.done[id]).toBe(false);
    expect(makeOverlap(7, 400, 300, { ...opts, placed: 40 }).game.done).toEqual(some.done);
    expect(makeOverlap(7, 400, 300, { ...opts, placed: 80 }).game.solved).toBe(false);
  });

  it('with the orientation locked starts every piece the right way up and does not turn them', () => {
    const g = makeOverlap(3, 400, 300, { ...opts, lock: 1 }).game;
    expect(g.rot.every((r) => r === 0)).toBe(true);
    g.rotate(0);
    expect(g.rot[0]).toBe(0);
    const turned = makeOverlap(3, 400, 300, { ...opts, lock: 0 }).game;
    expect(turned.rot.some((r) => r !== 0)).toBe(true);
    const before = turned.rot[0];
    turned.rotate(0);
    expect(turned.rot[0]).toBe((before + 1) % 4);
  });

  it('reads the old turned option of a room made before', () => {
    expect(makeOverlap(3, 400, 300, { ...opts, turned: 0 }).game.rot.every((r) => r === 0)).toBe(true);
    expect(makeOverlap(3, 400, 300, { ...opts, turned: 1 }).game.rot.some((r) => r !== 0)).toBe(true);
  });
});

describe('Strips', () => {
  const opts = { cells: 100, length: 6, tabs: 3 };

  it('places that share of the strips at random, home and locked', () => {
    const g = makeStrips(5, 400, 300, { ...opts, placed: 30 }).game;
    expect(g.lockedCount).toBe(share(g.total, 30));
    for (const s of g.state.filter((x) => x.locked)) expect(s.angle).toBe(0);
    expect(makeStrips(5, 400, 300, { ...opts, placed: 0 }).game.lockedCount).toBe(0);
    expect(makeStrips(5, 400, 300, { ...opts, placed: 80 }).game.solved).toBe(false);
  });

  it('with the orientation locked starts every strip the right way up and does not turn them', () => {
    const g = makeStrips(5, 400, 300, { ...opts, lock: 1 }).game;
    expect(g.state.every((s) => s.angle === 0)).toBe(true);
    const before = JSON.stringify(g.state[0]);
    expect(g.rotate(0)).toBe(false);
    expect(JSON.stringify(g.state[0])).toBe(before);
    expect(makeStrips(5, 400, 300, { ...opts, lock: 0 }).game.state.some((s) => s.angle !== 0)).toBe(true);
  });
});

describe('Jigsaw', () => {
  const setup = { seed: 9, width: 400, height: 300 };

  it('with the orientation locked starts every piece the right way up, and turns them otherwise', () => {
    const rots = (lock: number) => [...buildJigsaw({ ...setup, opts: { pieces: 60, lock } }).game.groups.values()].map((g) => g.rot);
    expect(rots(1).every((r) => r === 0)).toBe(true);
    expect(rots(0).some((r) => r !== 0)).toBe(true);
  });

  it('places that share of the pieces', () => {
    const base = buildJigsaw({ ...setup, opts: { pieces: 100, lock: 1, placed: 0, edges: 1 } });
    const placed = buildJigsaw({ ...setup, opts: { pieces: 100, lock: 1, placed: 40, edges: 1 } });
    expect(placed.game.anchoredCount).toBeGreaterThan(base.game.anchoredCount + 20);
  });
});

const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock: Clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

describe.each(stores)('the last used settings on %s', (_n, makeStore) => {
  it('are kept for an account, cleaned, and come back with the profile; a guest has none', async () => {
    const w = world({}, makeStore);
    expect((await w.service.profile(ann)).account.settings).toBeUndefined();
    const res = await w.service.setSettings(ann, { 'jigsaw.placed': 500, 'jigsaw.lock': 1, 'all.light': 1, 'junk.x': 3, 'jigsaw.drag': 'no' });
    expect(res).toMatchObject({ ok: true, account: { settings: { 'jigsaw.placed': 80, 'jigsaw.lock': 1 } } });
    expect((await w.service.profile(ann)).account.settings).toEqual({ 'jigsaw.placed': 80, 'jigsaw.lock': 1 });
    expect(await w.service.setSettings(ann, 'x')).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await w.service.setSettings({ id: 'g_1', name: 'G', guest: true }, {})).toMatchObject({ ok: false, error: 'account-required' });
  });
});

describe('SettingsSync', () => {
  function setup(server: Record<string, number> | undefined) {
    const store = new Map<string, string>();
    const prefs = new Prefs({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
    let summary: { type: string; settings?: Record<string, number> } = { type: 'guest' };
    const listeners: (() => void)[] = [];
    const sent: Record<string, number>[] = [];
    const identity = { kind: () => 'account', who: () => ({ id: 'ann' }), summary: () => summary, onChange: (fn: () => void) => void listeners.push(fn) };
    let applied = 0;
    new SettingsSync(prefs, identity as never, { saveSettings: async (s: Record<string, number>) => (sent.push(s), { ok: true }) } as never, () => applied++);
    return {
      prefs,
      sent,
      applied: () => applied,
      arrives: () => {
        summary = { type: 'free', ...(server ? { settings: server } : {}) };
        listeners.forEach((f) => f());
      },
    };
  }

  it('takes in what the account holds when it is first seen, and shows it', () => {
    const s = setup({ 'jigsaw.lock': 1, 'jigsaw.size': 4 });
    s.prefs.data.settings['jigsaw.size'] = 2;
    s.arrives();
    expect(cleanPuzzleSettings(s.prefs.data.settings)).toEqual({ 'jigsaw.lock': 1, 'jigsaw.size': 4 });
    expect(s.applied()).toBe(1);
  });

  it('gives the account this devices settings when it has none yet, and sends each later change a moment after', async () => {
    const s = setup(undefined);
    s.prefs.data.settings['overlap.size'] = 3;
    s.arrives();
    await new Promise((r) => setTimeout(r, 1700));
    expect(s.sent).toEqual([{ 'overlap.size': 3 }]);
    s.prefs.data.settings['overlap.size'] = 4;
    s.prefs.save();
    s.prefs.data.settings['overlap.size'] = 2;
    s.prefs.save();
    await new Promise((r) => setTimeout(r, 1700));
    expect(s.sent).toEqual([{ 'overlap.size': 3 }, { 'overlap.size': 2 }]);
  });
});
