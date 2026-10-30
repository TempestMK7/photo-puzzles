import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JigsawRoom } from '../src/core/jigsawRoom';
import { applyOp } from '../src/core/jigsawSetup';
import { PROTOCOL_VERSION } from '../src/online/protocol';
import { sniffImage } from '../server/src/image';
import { RoomService } from '../server/src/service';
import type { Player } from '../server/src/types';
import { DynamoStore } from '../server/src/aws/dynamo';
import { MemoryStore } from '../server/src/memory';
import { FakeDynamo } from './helpers/fakeDynamo';
import { ann, bob, cy, DAY, jpeg, joined, open, png, request, world as makeWorld, type MakeStore, type World } from './helpers/world';

// The service has the same rules on every store: all of its tests run on the memory one and on the DynamoDB one (with a fake of DynamoDB).
const stores: [string, MakeStore][] = [
  ['memory', () => new MemoryStore()],
  ['DynamoDB', (clock) => new DynamoStore(new FakeDynamo(), 'table', clock)],
];

describe('sniffImage', () => {
  it('reads the size of a JPEG and of a PNG, and nothing else', () => {
    expect(sniffImage(jpeg(400, 300))).toEqual({ type: 'image/jpeg', width: 400, height: 300 });
    expect(sniffImage(png(640, 480))).toEqual({ type: 'image/png', width: 640, height: 480 });
    expect(sniffImage(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe.each(stores)('the room service on %s', (_name, store) => {
  const world = (extra: Parameters<typeof makeWorld>[0] = {}) => makeWorld(extra, store);

  describe('creating a room', () => {
    let w: World;
    beforeEach(() => (w = world()));

    it('gives a five-digit code, a link and an address to upload to; the room can be joined once the picture is in', async () => {
      const made = await w.service.createRoom(ann, request());
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      expect(made.invite.code).toMatch(/^\d{5}$/);
      expect(made.invite.link).toBe(`https://play.test/#/join/${made.invite.code}~${made.invite.secret}`);
      expect(made.upload.url).toMatch(/^http:\/\/media\.test\/media\//);
      const early = await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret });
      expect(early).toMatchObject({ ok: false, error: 'not-ready' });
      expect((await w.service.finishUpload(made.roomId, png(400, 300))).ok).toBe(true);
      expect(w.media.has(made.roomId)).toBe(true);
      expect((await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).ok).toBe(true);
    });

    it('wants the player to have agreed, and the right version', async () => {
      expect(await w.service.createRoom(ann, { ...request(), consent: false as unknown as true })).toMatchObject({ ok: false, error: 'bad-request' });
      expect(await w.service.createRoom(ann, { ...request(), protocol: 0 })).toMatchObject({ ok: false, error: 'update-required', protocol: PROTOCOL_VERSION });
    });

    it('keeps to the limits, and keeps only the options that make the puzzle', async () => {
      expect(await w.service.createRoom(ann, request({ pieces: 1100 }))).toMatchObject({ ok: false, error: 'limit' });
      expect((await w.service.createRoom(ann, request({ pieces: 1000 }))).ok).toBe(true);
      for (const bad of [{ width: 10 }, { height: 99999 }, { seed: -1 }, { seed: 1.5 }, { kind: 'strips' }]) {
        const req = request();
        expect(await w.service.createRoom(bob, { ...req, settings: { ...req.settings, ...bad } as never }), JSON.stringify(bad)).toMatchObject({ ok: false, error: 'bad-request' });
      }
      const made = await open(w, cy, request({ turning: 1, haptics: 0, light: 1, bogus: 5 } as never));
      const room = await joined(w, made, bob);
      expect(room.settings.opts).toEqual({ pieces: 100, placed: 0, edges: 0, turning: 1, snap: 0 });
    });

    it('lets a free player make three a week, and tells when the next can be made', async () => {
      for (let i = 0; i < 3; i++) {
        const made = await open(w, ann);
        await w.service.close(ann, made.roomId);                  // closing one does not give the quota back
        w.clock.t += 1000;
      }
      const start = 1_000_000;
      const fourth = await w.service.createRoom(ann, request());
      expect(fourth).toMatchObject({ ok: false, error: 'quota', retryAt: start + 7 * DAY });
      expect((await w.service.createRoom(bob, request())).ok).toBe(true);        // someone else's quota is theirs
      w.clock.t = start + 7 * DAY + 1;
      expect((await w.service.createRoom(ann, request())).ok).toBe(true);
    });

    it('lets a player be in five puzzles at a time', async () => {
      const w2 = world({ freeRoomsPerWeek: 99 });                       // (the quota is three a week: lifted for this check)
      for (let i = 0; i < 5; i++) await open(w2, ann);
      expect(await w2.service.createRoom(ann, request())).toMatchObject({ ok: false, error: 'limit' });
      const made = await open(w2, bob);
      expect((await w2.service.join(ann, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret }))).toMatchObject({ ok: false, error: 'limit' });
    });

    it('throws away a room whose picture is not the size the puzzle was made for, and frees its code', async () => {
      const made = await w.service.createRoom(ann, request());
      if (!made.ok) throw new Error();
      expect(await w.service.finishUpload(made.roomId, jpeg(401, 300))).toMatchObject({ ok: false, error: 'bad-request' });
      expect(await w.store.getRoom(made.roomId)).toBeUndefined();
      expect(await w.store.roomOfCode(made.invite.code)).toBeUndefined();
      const other = await w.service.createRoom(ann, request());
      if (!other.ok) throw new Error();
      expect(await w.service.finishUpload(other.roomId, new TextEncoder().encode('not a picture'))).toMatchObject({ ok: false, error: 'bad-request' });
      expect(w.media.has(other.roomId)).toBe(false);
    });
  });

  describe('joining', () => {
    let w: World;
    beforeEach(() => (w = world()));

    it('lets the link in at once, shows the room as it is, and tells the others', async () => {
      const made = await open(w);
      w.online.add('ann');
      const room = await joined(w, made, bob);
      expect(room.members.map((m) => [m.id, m.color])).toEqual([['ann', 0], ['bob', 1]]);
      expect(room.online).toEqual(['ann']);
      expect(room.state.v).toBe(0);
      expect(room.media.url).toMatch(/\/media\//);
      expect(room.media.sourceId).toBe('abc123');
      expect(room.settings.width).toBe(400);
      expect(w.messages(made.roomId)).toContainEqual({ t: 'joined', member: { id: 'bob', name: 'Bob', color: 1 } });
      expect((await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code })).ok).toBe(true);       // already in: no knock
    });

    it('turns a wrong secret, a wrong code and a code that is not five digits away', async () => {
      const made = await open(w);
      const wrong = made.invite.secret.replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: wrong })).toMatchObject({ ok: false, error: 'not-found' });
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code === '00000' ? '00001' : '00000' })).toMatchObject({ ok: false, error: 'not-found' });
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: '12' })).toMatchObject({ ok: false, error: 'bad-request' });
      expect(await w.service.join(bob, { protocol: 0, code: made.invite.code })).toMatchObject({ ok: false, error: 'update-required' });
    });

    it('makes a code on its own knock: a member says yes or no, and the player asks again', async () => {
      const made = await open(w);
      const code = { protocol: PROTOCOL_VERSION, code: made.invite.code };
      expect(await w.service.join(bob, code)).toMatchObject({ ok: false, error: 'knock-pending' });
      expect(await w.service.join(bob, code)).toMatchObject({ ok: false, error: 'knock-pending' });
      expect(w.messages(made.roomId).filter((m) => m.t === 'knock')).toEqual([{ t: 'knock', id: 'bob', name: 'Bob' }]);     // asked twice, knocked once
      expect(await w.service.answerKnock(cy, made.roomId, 'bob', true)).toMatchObject({ ok: false, error: 'not-found' });       // not a member
      expect((await w.service.answerKnock(ann, made.roomId, 'bob', true)).ok).toBe(true);
      expect((await w.service.join(bob, code)).ok).toBe(true);
      expect(await w.service.join(cy, code)).toMatchObject({ ok: false, error: 'knock-pending' });
      await w.service.answerKnock(bob, made.roomId, 'cy', false);                       // any member may answer
      expect(await w.service.join(cy, code)).toMatchObject({ ok: false, error: 'knock-denied' });
      expect((await w.service.join(cy, { ...code, secret: made.invite.secret })).ok).toBe(true);     // the link still gets in
    });

    it('tells a member who comes later about the players who are waiting to be let in', async () => {
      const made = await open(w);
      const code = { protocol: PROTOCOL_VERSION, code: made.invite.code };
      await w.service.join(bob, code);
      const seen = await w.service.getRoom(ann, made.roomId);
      expect(seen.ok && seen.room.knocks).toEqual([{ id: 'bob', name: 'Bob' }]);
      await w.service.answerKnock(ann, made.roomId, 'bob', false);
      const after = await w.service.getRoom(ann, made.roomId);
      expect(after.ok && after.room.knocks).toEqual([]);
    });

    it('refuses to make puzzles when the operator has set the weekly number to 0', async () => {
      const x = makeWorld({ freeRoomsPerWeek: 0 }, store);
      expect(await x.service.createRoom(ann, request())).toMatchObject({ ok: false, error: 'paused' });
      expect(await x.store.creationsSince('ann', 0)).toEqual([]);                      // nothing was made or counted
      expect(x.media.has('anything')).toBe(false);
    });

    it('holds eight players', async () => {
      const made = await open(w);
      for (let i = 1; i < 8; i++) await joined(w, made, { id: `p${i}`, name: `P${i}` });
      expect(await w.service.join({ id: 'late', name: 'Late' }, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false, error: 'full' });
      const room = await w.service.getRoom(ann, made.roomId);
      expect(room.ok && room.room.members.map((m) => m.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('shows a room only to its members, and lists a player\'s rooms', async () => {
      const made = await open(w);
      expect(await w.service.getRoom(bob, made.roomId)).toMatchObject({ ok: false, error: 'not-found' });
      await joined(w, made, bob);
      expect((await w.service.getRoom(bob, made.roomId)).ok).toBe(true);
      const list = await w.service.listRooms(bob);
      expect(list.rooms.map((r) => [r.id, r.owner, r.members.length, r.status])).toEqual([[made.roomId, 'ann', 2, 'open']]);
      expect((await w.service.listRooms(cy)).rooms).toEqual([]);
    });

    it('gives a new code and link to the owner on request and stops the old ones', async () => {
      const made = await open(w);
      const again = await w.service.regenerateInvite(ann, made.roomId);
      if (!again.ok) throw new Error();
      expect(again.invite.code).not.toBe(made.invite.code);
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false, error: 'not-found' });
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: again.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false, error: 'not-found' });
      expect((await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: again.invite.code, secret: again.invite.secret })).ok).toBe(true);
      expect(await w.service.regenerateInvite(bob, made.roomId)).toMatchObject({ ok: false, error: 'unauthorized' });
    });
  });

  describe('playing', () => {
    let w: World;
    beforeEach(() => (w = world()));
    const cmd = (w: World, p: Player, id: string, command: Parameters<RoomService['command']>[2]['command']) => w.service.command(p, id, { protocol: PROTOCOL_VERSION, command });

    it('lets one player hold a piece, tells everyone, and counts every event', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const g = new JigsawRoom(room.settings, room.state).board.game;
      const [a, b] = [...g.groups.values()].filter((x) => !x.anchored);
      const first = await cmd(w, ann, made.roomId, { t: 'grab', piece: a.members[0] });
      expect(first).toMatchObject({ ok: true, event: { v: 1, by: 'ann', lock: { holder: 'ann', piece: a.members[0] } } });
      expect(await cmd(w, bob, made.roomId, { t: 'grab', piece: b.members[0] })).toMatchObject({ ok: false, error: 'busy', holder: 'ann' });
      expect(await cmd(w, bob, made.roomId, { t: 'drop', piece: a.members[0], dx: 1, dy: 2, rot: 0, tol: null })).toMatchObject({ ok: false, error: 'not-holder' });
      expect(await cmd(w, bob, made.roomId, { t: 'drop', piece: a.members[0], dx: NaN, dy: 2, rot: 0, tol: null })).toMatchObject({ ok: false });
      const drop = await cmd(w, ann, made.roomId, { t: 'drop', piece: a.members[0], dx: 5, dy: 6, rot: 0, tol: null });
      expect(drop).toMatchObject({ ok: true, event: { v: 2, lock: null } });
      expect(w.messages(made.roomId).filter((m) => m.t === 'event').map((m) => (m as { v: number }).v)).toEqual([1, 2]);        // refusals are not published
      const after = await w.service.getRoom(bob, made.roomId);
      expect(after.ok && after.room.state.v).toBe(2);
      expect(await cmd(w, cy, made.roomId, { t: 'grab', piece: a.members[0] })).toMatchObject({ ok: false, error: 'not-found' });          // not a member
      expect(await w.service.command(ann, made.roomId, { protocol: 0, command: { t: 'release' } })).toMatchObject({ ok: false, error: 'update-required' });
    });

    it('lets a hold run out by itself, and keeps it while it is renewed', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const [a, b] = [...new JigsawRoom(room.settings, room.state).board.game.groups.values()].filter((x) => !x.anchored);
      await cmd(w, ann, made.roomId, { t: 'grab', piece: a.members[0] });
      w.clock.t += 8000;
      const renewed = await w.service.renew(ann, made.roomId);
      expect(renewed).toEqual({ ok: true, until: w.clock.t + 10_000 });
      expect(w.messages(made.roomId)).toContainEqual({ t: 'renewed', id: 'ann', until: w.clock.t + 10_000 });          // so that the others do not think it ran out
      w.clock.t += 9000;
      expect(await cmd(w, bob, made.roomId, { t: 'grab', piece: b.members[0] })).toMatchObject({ ok: false, error: 'busy' });
      w.clock.t += 2000;
      expect(await cmd(w, bob, made.roomId, { t: 'grab', piece: b.members[0] })).toMatchObject({ ok: true });
      expect(await w.service.renew(ann, made.roomId)).toMatchObject({ ok: false, error: 'not-holder' });
    });

    it('gives exactly one of two players who grab at the same moment the piece', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const [a, b] = [...new JigsawRoom(room.settings, room.state).board.game.groups.values()].filter((x) => !x.anchored);
      const results = await Promise.all([cmd(w, ann, made.roomId, { t: 'grab', piece: a.members[0] }), cmd(w, bob, made.roomId, { t: 'grab', piece: b.members[0] })]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ error: 'busy' })]);
      const state = await w.service.getRoom(ann, made.roomId);
      expect(state.ok && state.room.state.v).toBe(1);
    });

    it('ends when the puzzle is solved: the room is kept for an hour for those watching, then goes with its picture and its code', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const players = [ann, bob];
      const copy = new JigsawRoom(room.settings, room.state).board.game;       // a game on a player's screen: it only applies what the service says
      const rec = (await w.store.getRoom(made.roomId))!;
      await w.store.putRoom({ ...rec, played: { ms: 60_000, since: w.clock.t }, rev: rec.rev + 1 });          // someone has been connected for a minute, and still is
      w.clock.t += 5_000;
      // play it with the same rules a game would: take a loose group, put it right against a neighbour
      for (let step = 0; step < 400; step++) {
        const cur = await w.service.getRoom(ann, made.roomId);
        if (!cur.ok || cur.room.status === 'solved') break;
        const game = new JigsawRoom(room.settings, cur.room.state).board.game;
        const a = [...game.groups.values()].find((x) => !x.anchored)!;
        let pose: { dx: number; dy: number; rot: number } | undefined;
        for (const m of a.members) {
          const c = m % game.cols;
          const r = Math.floor(m / game.cols);
          for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]]) {
            if (nc < 0 || nr < 0 || nc >= game.cols || nr >= game.rows || pose) continue;
            const o = game.groups.get(game.groupOf[nr * game.cols + nc])!;
            if (o.id !== a.id) pose = { dx: o.dx, dy: o.dy, rot: o.rot };
          }
        }
        const who = players[step % 2];
        for (const c of [{ t: 'grab', piece: a.members[0] }, { t: 'drop', piece: a.members[0], ...pose!, tol: 10 }] as const) {
          const r = await cmd(w, who, made.roomId, c);
          expect(r.ok).toBe(true);
          if (r.ok && r.event.op) applyOp(copy, r.event.op);
          // the service loads the room again for every command (which renumbers its groups): the screen must still agree with it
          const now = await w.service.getRoom(ann, made.roomId);
          expect(JSON.stringify(copy.snapshot())).toBe(JSON.stringify(now.ok && now.room.state.game));
        }
      }
      const done = await w.service.getRoom(ann, made.roomId);
      expect(done.ok && done.room.status).toBe('solved');
      expect(done.ok && done.room.expiresAt).toBe(w.clock.t + 3600 * 1000);
      expect(done.ok && done.room.solvedMs).toBe(65_000);                    // the time that counted is fixed when the last piece goes in
      expect(w.messages(made.roomId).filter((m) => m.t === 'solved')).toEqual([{ t: 'solved', at: w.clock.t, ms: 65_000 }]);
      expect(await cmd(w, ann, made.roomId, { t: 'grab', piece: 0 })).toMatchObject({ ok: false, error: 'ended' });
      expect(w.media.has(made.roomId)).toBe(true);
      w.clock.t += 3600 * 1000 + 1;
      expect(await w.service.getRoom(ann, made.roomId)).toMatchObject({ ok: false, error: 'not-found' });
      expect(w.media.has(made.roomId)).toBe(false);
      expect(await w.store.roomOfCode(made.invite.code)).toBeUndefined();
      expect(w.messages(made.roomId).at(-1)).toEqual({ t: 'closed', reason: 'solved' });
    });
  });

  describe('the automatic look at a picture', () => {
    const told: string[] = [];
    beforeEach(() => void (told.length = 0));
    const make = (check: (bytes: Uint8Array) => Promise<{ ok: true } | { ok: false; label: string }>) =>
      makeWorld({}, store, undefined, async (text) => void told.push(text), { check });
    const create = async (w: World) => {
      const made = await w.service.createRoom(ann, request());
      if (!made.ok) throw new Error('create failed');
      return made;
    };

    it('lets a picture that passes make the puzzle ready, after the look', async () => {
      const seen: number[] = [];
      const w = make(async (bytes) => (seen.push(bytes.length), { ok: true }));
      const made = await create(w);
      expect(await w.service.finishUpload(made.roomId, jpeg(400, 300))).toEqual({ ok: true });
      expect(seen).toHaveLength(1);
      expect((await w.service.getRoom(ann, made.roomId)).ok).toBe(true);
      expect(told).toEqual([]);
    });

    it('turns a picture down: the puzzle ends with nothing kept, the creator is told it was refused, and the operator is told what was found', async () => {
      const w = make(async () => ({ ok: false, label: 'Violence / Graphic Violence' }));
      const made = await create(w);
      expect(await w.service.finishUpload(made.roomId, jpeg(400, 300))).toMatchObject({ ok: false, error: 'rejected' });
      expect(await w.store.getRoom(made.roomId)).toBeUndefined();
      expect(w.media.has(made.roomId)).toBe(false);
      expect(await w.store.roomOfCode(made.invite.code)).toBeUndefined();
      expect(told).toHaveLength(1);
      expect(told[0]).toContain('Violence / Graphic Violence');
      expect(told[0]).toContain(made.roomId);
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false });
    });

    it('does not look at what it would turn away anyway (a picture of the wrong size or kind)', async () => {
      const check = vi.fn(async () => ({ ok: true as const }));
      const w = make(check);
      const made = await create(w);
      expect(await w.service.finishUpload(made.roomId, jpeg(401, 300))).toMatchObject({ ok: false, error: 'bad-request' });
      expect(check).not.toHaveBeenCalled();
    });

    it('shows nothing when the look could not be made, and lets the creator send the picture again', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let working = false;
      const w = make(async () => {
        if (!working) throw new Error('throttled');
        return { ok: true };
      });
      const made = await create(w);
      expect(await w.service.finishUpload(made.roomId, jpeg(400, 300))).toMatchObject({ ok: false, error: 'busy' });
      expect(w.media.has(made.roomId)).toBe(false);                                   // the picture was not stored
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false, error: 'not-ready' });
      working = true;
      expect(await w.service.finishUpload(made.roomId, jpeg(400, 300))).toEqual({ ok: true });
      expect((await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).ok).toBe(true);
      log.mockRestore();
    });
  });

  describe('reports, and what the operator does about them', () => {
    const told: string[] = [];
    const worldOf = (extra = {}) => makeWorld(extra, store, undefined, async (text) => void told.push(text));
    beforeEach(() => void (told.length = 0));

    it('keeps a report from a member with who was in the puzzle, tells the operator, and refuses anyone else or a reason it does not know', async () => {
      const w = worldOf();
      const made = await open(w);
      await joined(w, made, bob);
      expect(await w.service.report(cy, made.roomId, { reason: 'illegal' })).toMatchObject({ ok: false, error: 'not-found' });        // only a member can report
      expect(await w.service.report(bob, made.roomId, { reason: 'nonsense' as never })).toMatchObject({ ok: false, error: 'bad-request' });
      expect(await w.service.report(bob, made.roomId, { reason: 'copyright', note: '  not\u0000 theirs\n to  share ' })).toEqual({ ok: true });
      const reports = await w.service.adminReports();
      expect(reports).toEqual([expect.objectContaining({ roomId: made.roomId, ownerId: 'ann', reporterId: 'bob', members: ['ann', 'bob'], reason: 'copyright', note: 'not theirs to share' })]);
      expect(told).toHaveLength(1);
      expect(told[0]).toContain(made.roomId);
      expect(told[0]).not.toContain('not theirs');                                      // what a player wrote is for the operator to read, not for a message
    });

    it('lists the newest reports first and only those of the last days asked for', async () => {
      const w = worldOf();
      const made = await open(w);
      await joined(w, made, bob);
      await w.service.report(bob, made.roomId, { reason: 'other', note: 'one' });
      w.clock.t += 10 * 3600 * 1000;
      await w.service.report(bob, made.roomId, { reason: 'adult', note: 'two' });
      expect((await w.service.adminReports(30)).map((r) => r.note)).toEqual(['two', 'one']);
      expect((await w.service.adminReports(0.25)).map((r) => r.note)).toEqual(['two']);        // the last six hours
    });

    it('still tells nothing wrong when the operator cannot be told: the report is kept', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const w = makeWorld({}, store, undefined, async () => { throw new Error('no topic'); });
      const made = await open(w);
      await joined(w, made, bob);
      expect(await w.service.report(bob, made.roomId, { reason: 'other' })).toEqual({ ok: true });
      expect(await w.service.adminReports()).toHaveLength(1);
      log.mockRestore();
    });

    it('shows a puzzle with its picture, and ends one at the operator\'s word with a message to the players', async () => {
      const w = worldOf();
      const made = await open(w);
      await joined(w, made, bob);
      const shown = await w.service.adminRoom(made.roomId);
      expect(shown).toMatchObject({ id: made.roomId, ownerId: 'ann', members: [{ id: 'ann', name: 'Ann' }, { id: 'bob', name: 'Bob' }], status: 'open', ready: true });
      expect(shown?.picture).toContain(made.roomId);
      expect(await w.service.adminRoom('nothing')).toBeUndefined();
      expect(await w.service.adminRemoveRoom(made.roomId)).toBe(true);
      expect(await w.service.adminRemoveRoom(made.roomId)).toBe(false);
      expect(w.messages(made.roomId).at(-1)).toEqual({ t: 'closed', reason: 'owner' });
      expect(w.media.has(made.roomId)).toBe(false);
      expect(await w.store.roomOfCode(made.invite.code)).toBeUndefined();
      expect(await w.service.getRoom(bob, made.roomId)).toMatchObject({ ok: false, error: 'not-found' });
    });

    it('bans a player: they leave every puzzle, the ones they made end, and it holds until it is lifted (an account that is deleted stays banned)', async () => {
      const w = worldOf({ freeRoomsPerWeek: 50 });
      const mine = await open(w, bob);
      await joined(w, mine, ann);
      const theirs = await open(w, ann);
      await joined(w, theirs, cy);
      await w.service.adminBan('ann', '  harassing\nplayers ');
      expect(await w.service.isBanned('ann')).toBe(true);
      expect(await w.service.isBanned('bob')).toBe(false);
      expect(await w.service.adminBans()).toEqual([{ playerId: 'ann', at: w.clock.t, reason: 'harassing players' }]);
      expect(await w.store.getRoom(theirs.roomId)).toBeUndefined();
      const rest = await w.service.getRoom(bob, mine.roomId);
      expect(rest.ok && rest.room.members.map((m) => m.id)).toEqual(['bob']);
      await w.service.deleteAccount(ann);
      expect(await w.service.isBanned('ann')).toBe(true);
      await w.service.adminUnban('ann');
      expect(await w.service.isBanned('ann')).toBe(false);
      expect(await w.service.adminBans()).toEqual([]);
    });
  });

  describe('leaving and expiring', () => {
    let w: World;
    beforeEach(() => (w = world()));

    it('makes the code stop working a day after the last move, and every move starts the day again', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const [a] = [...new JigsawRoom(room.settings, room.state).board.game.groups.values()].filter((x) => !x.anchored);
      w.clock.t += DAY - 1000;
      expect((await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'grab', piece: a.members[0] } })).ok).toBe(true);
      w.clock.t += DAY - 1000;
      expect((await w.service.join(cy, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).ok).toBe(true);
      w.clock.t += DAY;                                              // joining is not a move: a day after the last one it is over
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false, error: 'not-found' });
      expect(w.media.has(made.roomId)).toBe(false);
      expect(w.messages(made.roomId).at(-1)).toEqual({ t: 'closed', reason: 'expired' });
    });

    it('ends a puzzle that is played every day after thirty days anyway, with its picture and its code', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const [a] = [...new JigsawRoom(room.settings, room.state).board.game.groups.values()].filter((x) => !x.anchored);
      const made0 = w.clock.t;
      let days = 0;
      for (; days < 40; days++) {
        w.clock.t += DAY - 1000;
        if (!(await w.service.getRoom(ann, made.roomId)).ok) break;
        expect((await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'grab', piece: a.members[0] } })).ok).toBe(true);        // somebody plays: the day starts again
        await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'release' } });
      }
      expect(w.clock.t - made0).toBeGreaterThanOrEqual(30 * DAY - DAY);                // it lasted about thirty days, not for ever
      expect(w.clock.t - made0).toBeLessThanOrEqual(31 * DAY);
      expect(await w.service.getRoom(ann, made.roomId)).toMatchObject({ ok: false, error: 'not-found' });
      expect(w.media.has(made.roomId)).toBe(false);
      expect(await w.store.roomOfCode(made.invite.code)).toBeUndefined();
    });

    it('clears out expired rooms in a sweep', async () => {
      const one = await open(w, ann);
      const two = await open(w, bob);
      w.clock.t += DAY - 5;
      await w.service.listRooms(ann);                               // (looking does not keep a room alive)
      expect(await w.service.sweep()).toBe(0);
      w.clock.t += 10;
      expect(await w.service.sweep()).toBe(2);
      expect([w.media.has(one.roomId), w.media.has(two.roomId)]).toEqual([false, false]);
      expect((await w.store.allRooms()).length).toBe(0);
    });

    it('lets a player leave: the room goes on without them, the owner passes on, a hold is let go, and the last one out closes it', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      const [a] = [...new JigsawRoom(room.settings, room.state).board.game.groups.values()].filter((x) => !x.anchored);
      await w.service.command(ann, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'grab', piece: a.members[0] } });
      expect((await w.service.leave(ann, made.roomId)).ok).toBe(true);
      const now = await w.service.getRoom(bob, made.roomId);
      expect(now.ok && [now.room.owner, now.room.members.length, now.room.state.lock]).toEqual(['bob', 1, null]);
      expect(w.messages(made.roomId)).toContainEqual({ t: 'left', id: 'ann' });
      expect(await w.service.getRoom(ann, made.roomId)).toMatchObject({ ok: false, error: 'not-found' });
      expect((await w.service.join(ann, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).ok).toBe(true);        // and can come back
      await w.service.leave(ann, made.roomId);
      await w.service.leave(bob, made.roomId);
      expect(await w.store.getRoom(made.roomId)).toBeUndefined();
      expect(w.media.has(made.roomId)).toBe(false);
    });

    it('lets the owner send a player out: they lose their hold and the room, everyone is told, and they cannot come back, with the code, the link or a new one', async () => {
      const made = await open(w);
      const room = await joined(w, made, bob);
      await joined(w, made, cy);
      const [a] = [...new JigsawRoom(room.settings, room.state).board.game.groups.values()].filter((x) => !x.anchored);
      await w.service.command(bob, made.roomId, { protocol: PROTOCOL_VERSION, command: { t: 'grab', piece: a.members[0] } });
      expect(await w.service.removeMember(bob, made.roomId, cy.id)).toMatchObject({ ok: false, error: 'unauthorized' });        // only the owner
      expect(await w.service.removeMember(ann, made.roomId, ann.id)).toMatchObject({ ok: false, error: 'bad-request' });        // not themselves
      expect(await w.service.removeMember(ann, made.roomId, 'nobody')).toMatchObject({ ok: false, error: 'not-found' });
      expect((await w.service.removeMember(ann, made.roomId, bob.id)).ok).toBe(true);
      const now = await w.service.getRoom(ann, made.roomId);
      expect(now.ok && [now.room.members.map((m) => m.id), now.room.state.lock]).toEqual([['ann', 'cy'], null]);
      expect(w.messages(made.roomId)).toContainEqual({ t: 'removed', id: 'bob' });
      expect(await w.service.getRoom(bob, made.roomId)).toMatchObject({ ok: false, error: 'not-found' });
      expect(await w.service.listRooms(bob)).toEqual({ ok: true, rooms: [] });
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code, secret: made.invite.secret })).toMatchObject({ ok: false, error: 'removed' });
      expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: made.invite.code })).toMatchObject({ ok: false, error: 'removed' });          // no knock either
      const fresh = await w.service.regenerateInvite(ann, made.roomId);
      expect(fresh.ok).toBe(true);
      if (fresh.ok) expect(await w.service.join(bob, { protocol: PROTOCOL_VERSION, code: fresh.invite.code, secret: fresh.invite.secret })).toMatchObject({ ok: false, error: 'removed' });
      expect(w.messages(made.roomId).filter((m) => m.t === 'knock')).toEqual([]);
      expect((await w.service.join(cy, { protocol: PROTOCOL_VERSION, code: fresh.ok ? fresh.invite.code : '', secret: fresh.ok ? fresh.invite.secret : '' })).ok).toBe(true);          // anyone else still can
    });

    it('forgets a player who asks to go: the puzzles they made end, they leave the others, their name and quota record go, and the account is deleted last', async () => {
      const deleted: string[] = [];
      const x = makeWorld({ freeRoomsPerWeek: 50 }, store, { delete: async (id) => void deleted.push(id) });
      const mine = await open(x, ann);
      await joined(x, mine, bob);
      const theirs = await open(x, bob);
      await joined(x, theirs, ann);
      await joined(x, theirs, cy);
      await x.service.setProfile(ann, 'Annie');
      expect(await x.service.deleteAccount(ann)).toEqual({ ok: true });
      expect(deleted).toEqual(['ann']);
      expect(await x.store.getRoom(mine.roomId)).toBeUndefined();                    // the one they made is gone, with its picture and its code
      expect(x.media.has(mine.roomId)).toBe(false);
      expect(await x.store.roomOfCode(mine.invite.code)).toBeUndefined();
      expect(x.messages(mine.roomId).at(-1)).toEqual({ t: 'closed', reason: 'owner' });
      const rest = await x.service.getRoom(bob, theirs.roomId);
      expect(rest.ok && rest.room.members.map((m) => m.id)).toEqual(['bob', 'cy']);          // the other goes on without them
      expect(x.messages(theirs.roomId)).toContainEqual({ t: 'left', id: 'ann' });
      expect(await x.store.roomsOf('ann')).toEqual([]);
      expect(await x.store.getName('ann')).toBeUndefined();
      expect(await x.store.creationsSince('ann', 0)).toEqual([]);
      expect(await x.store.creationsSince('bob', 0)).toHaveLength(1);                     // nobody else's record is touched
      expect(await x.service.deleteAccount(ann)).toEqual({ ok: true });                  // asking again is harmless
    });

    it('says so, and has forgotten the rest, when the account cannot be deleted (asking again finishes it)', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);          // the service logs what went wrong
      let broken = true;
      const x = makeWorld({}, store, { delete: async () => { if (broken) throw new Error('no'); } });
      await open(x, ann);
      expect(await x.service.deleteAccount(ann)).toMatchObject({ ok: false, error: 'busy' });
      expect(log).toHaveBeenCalledOnce();
      log.mockRestore();
      expect(await x.store.roomsOf('ann')).toEqual([]);
      broken = false;
      expect(await x.service.deleteAccount(ann)).toEqual({ ok: true });
    });

    it('does not ask the sign-in service about a guest, who has no account', async () => {
      const deleted: string[] = [];
      const x = makeWorld({}, store, { delete: async (id) => void deleted.push(id) });
      const g = { id: 'gZed', name: 'Zed', guest: true };
      const made = await open(x, ann);
      await joined(x, made, g);
      await x.service.setProfile(g, 'Zed');
      expect(await x.service.deleteAccount(g)).toEqual({ ok: true });
      expect(deleted).toEqual([]);
      expect(await x.store.roomsOf('gZed')).toEqual([]);
      expect(await x.store.getName('gZed')).toBeUndefined();
    });

    it('lets only the owner close a room, and tells everyone', async () => {
      const made = await open(w);
      await joined(w, made, bob);
      expect(await w.service.close(bob, made.roomId)).toMatchObject({ ok: false, error: 'unauthorized' });
      expect((await w.service.close(ann, made.roomId)).ok).toBe(true);
      expect(w.messages(made.roomId).at(-1)).toEqual({ t: 'closed', reason: 'owner' });
      expect(await w.store.roomOfCode(made.invite.code)).toBeUndefined();
    });
  });
});
