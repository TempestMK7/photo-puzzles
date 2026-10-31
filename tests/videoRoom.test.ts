import { describe, expect, it } from 'vitest';
import { playbackNow, type CreateRoomRequest, type VideoType } from '../src/online/protocol';
import { looksLike } from '../server/src/service';
import { createRouter, DevAuth } from '../server/src/router';
import type { VideoModeration } from '../server/src/types';
import { ann, bob, jpeg, joined, request, world, type World } from './helpers/world';

const MP4 = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);                 // ....ftypisom
  return b;
};
const WEBM = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  b.set([0x1a, 0x45, 0xdf, 0xa3]);
  return b;
};

const videoRequest = (video: Partial<NonNullable<CreateRoomRequest['video']>> = {}, extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest =>
  request({}, { video: { type: 'video/mp4', bytes: 5000, ms: 12_000, ...video }, ...extra });

/** A video room whose file has been put in storage (the creator's game does that straight to the bucket in the cloud). */
async function made(w: World, req = videoRequest(), bytes: Uint8Array = MP4(req.video?.bytes ?? 0), type: VideoType = 'video/mp4') {
  const res = await w.service.createRoom(ann, req);
  if (!res.ok) throw new Error(`create failed: ${res.error}`);
  await w.media.put(res.roomId, bytes, type);
  return res;
}

/** The look at a whole video, as a test wants it to go: what it says each time it is asked, and how often it was started. */
function lookAt(...answers: Awaited<ReturnType<VideoModeration['result']>>[]) {
  const calls = { started: 0, asked: 0 };
  const check: VideoModeration = {
    async start() {
      calls.started++;
      return { jobId: 'job-1' };
    },
    async result() {
      return answers[Math.min(calls.asked++, answers.length - 1)];
    },
  };
  return { check, calls };
}

describe('making a puzzle from a video', () => {
  it('is switched off until the operator sets a limit', async () => {
    const w = world({ videoRoomsPerWeek: 0 });
    expect(await w.service.createRoom(ann, videoRequest())).toEqual({ ok: false, error: 'video-off' });
    expect((await w.service.createRoom(ann, request())).ok).toBe(true);                               // pictures are as before
  });

  it('gives the creator a place to send the file, and the puzzle cannot be joined until it has arrived and been checked', async () => {
    const w = world();
    const res = await w.service.createRoom(ann, videoRequest());
    if (!res.ok) throw new Error(res.error);
    expect(res.upload?.url).toContain(`/media/${res.roomId}/video`);
    expect(await w.service.join(bob, { protocol: 1, code: res.invite.code, secret: res.invite.secret })).toEqual({ ok: false, error: 'not-ready' });
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: false, error: 'not-ready' });           // no file yet
    await w.media.put(res.roomId, MP4(5000), 'video/mp4');
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'ready' });                  // (no check is made by this server: it lets the video through)
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'ready' });                  // and asking again is no harm
    const room = await joined(w, res, bob);
    expect(room.media.type).toBe('video');
    expect(room.media.video).toEqual({ type: 'video/mp4', bytes: 5000, ms: 12_000 });
    expect(room.playback).toMatchObject({ pos: 0, paused: false });
  });

  it('takes only MP4 and MOV, nothing too long or too large, and counts videos by themselves', async () => {
    const w = world({ videoRoomsPerWeek: 1, freeRoomsPerWeek: 3 });
    expect(await w.service.createRoom(ann, videoRequest({ bytes: 1_000_001 }))).toEqual({ ok: false, error: 'too-big' });
    expect(await w.service.createRoom(ann, videoRequest({ ms: 30_001 }))).toEqual({ ok: false, error: 'too-big' });
    expect(await w.service.createRoom(ann, videoRequest({ type: 'video/webm' as VideoType }))).toEqual({ ok: false, error: 'bad-request' });          // it cannot be checked
    expect(await w.service.createRoom(ann, videoRequest({ type: 'video/x-matroska' as VideoType }))).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.createRoom(ann, videoRequest({ type: 'video/x-flv' as VideoType }))).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.createRoom(ann, videoRequest({ bytes: 0 }))).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.createRoom(ann, videoRequest({ ms: Number.NaN }))).toEqual({ ok: false, error: 'bad-request' });
    expect((await w.service.createRoom(ann, videoRequest({ type: 'video/quicktime' }))).ok).toBe(true);
    const again = await w.service.createRoom(ann, videoRequest());
    expect(again).toMatchObject({ ok: false, error: 'quota' });                                      // one video a week
    expect((await w.service.createRoom(ann, request())).ok).toBe(true);                               // and the pictures still have their own three
  });

  it('forgets the count of videos when the account is deleted', async () => {
    const w = world({ videoRoomsPerWeek: 1 });
    expect((await w.service.createRoom(ann, videoRequest())).ok).toBe(true);
    await w.service.deleteAccount(ann);
    expect(await w.store.creationsSince('video#ann', 0)).toEqual([]);
  });

  it('ends the puzzle, with its file, when the file is not what was said', async () => {
    for (const [what, bytes, type] of [['another size', MP4(4999), 'video/mp4'], ['another kind', WEBM(5000), 'video/mp4'], ['no kind at all', new Uint8Array(5000), 'video/mp4']] as const) {
      const look = lookAt({ state: 'done', ok: true });
      const w = world({}, undefined, undefined, undefined, undefined, look.check);
      const res = await made(w, videoRequest(), bytes, type);
      expect(await w.service.checkVideo(ann, res.roomId), what).toEqual({ ok: false, error: 'bad-request' });
      expect(look.calls.started, what).toBe(0);                                                         // nothing is paid for
      expect(w.media.has(res.roomId), what).toBe(false);
      expect(await w.store.getRoom(res.roomId), what).toBeUndefined();
    }
  });

  it('is only for the owner of a video puzzle', async () => {
    const w = world();
    const res = await made(w);
    expect(await w.service.checkVideo(bob, res.roomId)).toEqual({ ok: false, error: 'not-found' });
    const picture = world();
    const p = await picture.service.createRoom(ann, request());
    if (!p.ok) throw new Error(p.error);
    expect(await picture.service.checkVideo(ann, p.roomId)).toEqual({ ok: false, error: 'not-found' });
  });
});

describe('the look at the whole video', () => {
  it('is started once, asked about until it is done, and only then can anyone join', async () => {
    const look = lookAt({ state: 'working' }, { state: 'working' }, { state: 'done', ok: true });
    const w = world({}, undefined, undefined, undefined, undefined, look.check);
    const res = await made(w);
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'checking' });
    expect(await w.service.join(bob, { protocol: 1, code: res.invite.code, secret: res.invite.secret })).toEqual({ ok: false, error: 'not-ready' });
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'checking' });
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'checking' });
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'ready' });
    expect(look.calls).toEqual({ started: 1, asked: 3 });
    expect((await joined(w, res, bob)).playback).toMatchObject({ pos: 0, paused: false });
    expect((await w.store.getRoom(res.roomId))!.checking).toBeUndefined();
  });

  it('asks for the stricter look at a video that came from the stock library, and for the usual one at any other', async () => {
    const asked: (boolean | undefined)[] = [];
    const check: VideoModeration = {
      async start() {
        return { jobId: 'job' };
      },
      async result(_job, strict) {
        asked.push(strict);
        return { state: 'done', ok: true };
      },
    };
    const w = world({ videoRoomsPerWeek: 2 }, undefined, undefined, undefined, undefined, check);
    const stock = await made(w, videoRequest({}, { stock: true }));
    await w.service.checkVideo(ann, stock.roomId);
    await w.service.checkVideo(ann, stock.roomId);
    const own = await w.service.createRoom(bob, videoRequest());
    if (!own.ok) throw new Error(own.error);
    await w.media.put(own.roomId, MP4(videoRequest().video!.bytes), 'video/mp4');
    await w.service.checkVideo(bob, own.roomId);
    await w.service.checkVideo(bob, own.roomId);
    expect(asked).toEqual([true, false]);
  });

  it('turns a video down, ends the puzzle and tells the operator', async () => {
    const told: string[] = [];
    const look = lookAt({ state: 'done', ok: false, label: 'Violence / Graphic Violence' });
    const w = world({}, undefined, undefined, async (t) => void told.push(t), undefined, look.check);
    const res = await made(w);
    await w.service.checkVideo(ann, res.roomId);
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: false, error: 'rejected' });
    expect(told[0]).toContain('Violence / Graphic Violence');
    expect(w.media.has(res.roomId)).toBe(false);
    expect(await w.store.getRoom(res.roomId)).toBeUndefined();
  });

  it('ends the puzzle when the service cannot read the video (while asking, or at the start)', async () => {
    const look = lookAt({ state: 'unreadable' });
    const w = world({}, undefined, undefined, undefined, undefined, look.check);
    const res = await made(w);
    await w.service.checkVideo(ann, res.roomId);
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: false, error: 'unreadable' });
    expect(w.media.has(res.roomId)).toBe(false);
    const refusing = world({}, undefined, undefined, undefined, undefined, { start: async () => ({ unreadable: true }), result: async () => ({ state: 'working' }) });
    const r2 = await made(refusing);
    expect(await refusing.service.checkVideo(ann, r2.roomId)).toEqual({ ok: false, error: 'unreadable' });
    expect(await refusing.store.getRoom(r2.roomId)).toBeUndefined();
  });

  it('is not given up on when the service cannot be reached: the creator may ask again', async () => {
    let up = false;
    const flaky: VideoModeration = {
      async start() {
        if (!up) throw new Error('down');
        return { jobId: 'j' };
      },
      async result() {
        if (!up) throw new Error('down');
        return { state: 'done', ok: true };
      },
    };
    const w = world({}, undefined, undefined, undefined, undefined, flaky);
    const res = await made(w);
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: false, error: 'busy' });
    up = true;
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'checking' });
    up = false;
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: false, error: 'busy' });
    expect(await w.store.getRoom(res.roomId)).toBeDefined();
    up = true;
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'ready' });
  });
});

describe('the video of an administrator', () => {
  const root = { id: 'root', name: 'Root', admin: true as const };
  const huge = (over: Partial<NonNullable<CreateRoomRequest['video']>> = {}) => videoRequest({ bytes: 5000, ms: 12_000, ...over });

  it('is not held to the size and length limits, which anyone else is', async () => {
    const w = world({ videoBytes: 1000, videoMs: 5000, videoRoomsPerWeek: 5 });
    expect(await w.service.createRoom(ann, huge())).toEqual({ ok: false, error: 'too-big' });
    expect((await w.service.createRoom(root, huge({ bytes: 200_000_000, ms: 600_000 }))).ok).toBe(true);
    expect(await w.service.createRoom(root, huge({ bytes: 5_000_000_001 }))).toEqual({ ok: false, error: 'too-big' });          // storage takes at most 5 GB at once
  });

  it('is not looked at by the automatic check, but the file is still the one that was said', async () => {
    const look = lookAt({ state: 'done', ok: false, label: 'Explicit' });
    const w = world({ videoRoomsPerWeek: 5 }, undefined, undefined, undefined, undefined, look.check);
    const res = await w.service.createRoom(root, huge());
    if (!res.ok) throw new Error(res.error);
    await w.media.put(res.roomId, MP4(4999), 'video/mp4');
    expect(await w.service.checkVideo(root, res.roomId)).toEqual({ ok: false, error: 'bad-request' });                      // another size: still turned away
    const again = await w.service.createRoom(root, huge());
    if (!again.ok) throw new Error(again.error);
    await w.media.put(again.roomId, MP4(5000), 'video/mp4');
    expect(await w.service.checkVideo(root, again.roomId)).toEqual({ ok: true, state: 'ready' });
    expect(look.calls).toEqual({ started: 0, asked: 0 });                                                                         // and no one paid for a look
    const joinedBy = await joined(w, again, bob);
    expect(joinedBy.media.type).toBe('video');
    expect(JSON.stringify(joinedBy)).not.toContain('unchecked');                                                               // the players are not told
  });

  it('does not make the video of anyone else unchecked', async () => {
    const look = lookAt({ state: 'done', ok: true });
    const w = world({}, undefined, undefined, undefined, undefined, look.check);
    const res = await made(w);
    expect(await w.service.checkVideo(ann, res.roomId)).toEqual({ ok: true, state: 'checking' });
    expect(look.calls.started).toBe(1);
  });
});

describe('the local server', () => {
  it('is sent the file itself, of exactly the size that was said', async () => {
    const w = world();
    const res = await w.service.createRoom(ann, videoRequest());
    if (!res.ok) throw new Error(res.error);
    expect(await w.service.storeVideo(res.roomId, MP4(5000))).toEqual({ ok: true });
    expect(w.media.has(res.roomId)).toBe(true);
    const res2 = await w.service.createRoom(bob, videoRequest());
    if (!res2.ok) throw new Error(res2.error);
    expect(await w.service.storeVideo(res2.roomId, new Uint8Array(10))).toEqual({ ok: false, error: 'bad-request' });
  });
});

describe('the host of a video puzzle', () => {
  const ready = async (w: World) => {
    const res = await made(w);
    await w.service.checkVideo(ann, res.roomId);
    await joined(w, res, bob);
    return res;
  };

  it('says where the video is, and the others hear it and are told it when they join', async () => {
    const w = world();
    const res = await ready(w);
    w.clock.t += 5000;
    expect(await w.service.setPlayback(ann, res.roomId, { pos: 3.5, paused: true })).toEqual({ ok: true });
    expect(w.messages(res.roomId).at(-1)).toEqual({ t: 'playback', pos: 3.5, paused: true, at: w.clock.t });
    const cy = { id: 'cy', name: 'Cy' };
    const room = await joined(w, res, cy);
    expect(room.playback).toEqual({ pos: 3.5, paused: true, at: w.clock.t });
  });

  it('is the owner only, and only in a video puzzle, with a position inside the video', async () => {
    const w = world();
    const res = await ready(w);
    expect(await w.service.setPlayback(bob, res.roomId, { pos: 1, paused: false })).toEqual({ ok: false, error: 'unauthorized' });
    expect(await w.service.setPlayback(ann, res.roomId, { pos: -1, paused: false })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.setPlayback(ann, res.roomId, { pos: 99, paused: false })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.setPlayback(ann, res.roomId, { pos: Number.NaN, paused: false })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.setPlayback(ann, res.roomId, { pos: 1, paused: 'yes' as unknown as boolean })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.setPlayback(ann, res.roomId, { pos: 12.5, paused: false })).toEqual({ ok: true });         // a little past the end is the end
    expect((await w.store.getRoom(res.roomId))!.playback!.pos).toBe(12);
    const picture = world();
    const p = await picture.service.createRoom(ann, request());
    if (!p.ok) throw new Error(p.error);
    await picture.service.finishUpload(p.roomId, jpeg(400, 300));
    expect(await picture.service.setPlayback(ann, p.roomId, { pos: 1, paused: false })).toEqual({ ok: false, error: 'bad-request' });
  });

  it('may make the owner the one who is followed when the first owner leaves', async () => {
    const w = world();
    const res = await ready(w);
    await w.service.leave(ann, res.roomId);
    expect(await w.service.setPlayback(bob, res.roomId, { pos: 2, paused: true })).toEqual({ ok: true });
  });
});

describe('where the video should be', () => {
  it('is where the host left it when paused, and moves on with the server\'s clock when playing, round and round', () => {
    expect(playbackNow({ pos: 4, paused: true, at: 1000 }, 99_000, 10)).toBe(4);
    expect(playbackNow({ pos: 4, paused: false, at: 1000 }, 3000, 10)).toBe(6);
    expect(playbackNow({ pos: 4, paused: false, at: 1000 }, 8000, 10)).toBe(1);
    expect(playbackNow({ pos: 4, paused: false, at: 5000 }, 1000, 10)).toBe(4);                // a clock that is behind does not run backwards
    expect(playbackNow({ pos: 4, paused: false, at: 0 }, 5000, 0)).toBe(4);                      // nothing known about the length: where it was
  });
});

describe('telling a video file by its first bytes', () => {
  it('knows the containers it allows', () => {
    expect(looksLike(MP4(20), 'video/mp4')).toBe(true);
    expect(looksLike(MP4(20), 'video/quicktime')).toBe(true);
    expect(looksLike(WEBM(20), 'video/mp4')).toBe(false);
    expect(looksLike(new Uint8Array(3), 'video/mp4')).toBe(false);
    expect(looksLike(MP4(20), 'video/x-flv')).toBe(false);
  });
});

describe('the video routes of the API', () => {
  const setup = (look?: VideoModeration) => {
    const w = world({}, undefined, undefined, undefined, undefined, look);
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
    const as = (p: { id: string; name: string }) => `Bearer dev:${p.id}:${p.name}`;
    const post = (path: string, who: { id: string; name: string }, body: unknown) =>
      route({ method: 'POST', path, query: new URLSearchParams(), authorization: as(who), body: new TextEncoder().encode(JSON.stringify(body)) });
    return { w, route, post };
  };

  it('takes the file at the signed address (the local server), then the check and the host\'s word at the room\'s', async () => {
    const { w, route, post } = setup();
    const created = await post('/rooms', ann, videoRequest());
    const body = created.body as { ok: true; roomId: string; upload: { url: string } };
    expect(body.ok).toBe(true);
    const url = new URL(body.upload.url);
    expect(url.pathname).toBe(`/media/${body.roomId}/video`);
    const bad = await route({ method: 'PUT', path: url.pathname, query: new URLSearchParams({ exp: url.searchParams.get('exp')!, sig: 'wrong' }), body: MP4(5000) });
    expect(bad.status).toBe(403);
    const put = await route({ method: 'PUT', path: url.pathname, query: url.searchParams, body: MP4(5000) });
    expect(put.status).toBe(200);
    const check = await post(`/rooms/${body.roomId}/video`, ann, {});
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ ok: true, state: 'ready' });
    expect((await post(`/rooms/${body.roomId}/playback`, ann, { pos: 2, paused: true })).status).toBe(200);
    expect((await post(`/rooms/${body.roomId}/playback`, bob, { pos: 2, paused: true })).status).toBe(404);          // not a member
    expect(w.messages(body.roomId).some((m) => m.t === 'playback')).toBe(true);
  });

  it('answers a turned-down or unreadable video with the status the game reads', async () => {
    const { w, post } = setup(lookAt({ state: 'unreadable' }).check);
    const created = (await post('/rooms', ann, videoRequest())).body as { roomId: string };
    await w.media.put(created.roomId, MP4(5000), 'video/mp4');
    expect((await post(`/rooms/${created.roomId}/video`, ann, {})).body).toEqual({ ok: true, state: 'checking' });
    const res = await post(`/rooms/${created.roomId}/video`, ann, {});
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ ok: false, error: 'unreadable' });
  });

  it('answers a switched-off or oversized video with the status the game reads', async () => {
    const off = world({ videoRoomsPerWeek: 0 });
    const route = createRouter({ service: off.service, auth: new DevAuth(), media: off.media });
    const create = (video: unknown) => route({ method: 'POST', path: '/rooms', query: new URLSearchParams(), authorization: 'Bearer dev:ann:Ann', body: new TextEncoder().encode(JSON.stringify(request({}, { video } as Partial<CreateRoomRequest>))) });
    expect((await create({ type: 'video/mp4', bytes: 5, ms: 5 })).status).toBe(503);
    const on = world();
    const route2 = createRouter({ service: on.service, auth: new DevAuth(), media: on.media });
    const big = await route2({ method: 'POST', path: '/rooms', query: new URLSearchParams(), authorization: 'Bearer dev:ann:Ann', body: new TextEncoder().encode(JSON.stringify(videoRequest({ bytes: 2_000_000 }))) });
    expect(big.status).toBe(413);
  });
});
