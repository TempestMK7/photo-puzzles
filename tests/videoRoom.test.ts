import { describe, expect, it } from 'vitest';
import { playbackNow, type CreateRoomRequest, type VideoType } from '../src/online/protocol';
import { looksLike } from '../server/src/service';
import { createRouter, DevAuth } from '../server/src/router';
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
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const frames = (n = 4): string[] => Array.from({ length: n }, () => base64(jpeg(160, 90)));

const videoRequest = (video: Partial<NonNullable<CreateRoomRequest['video']>> = {}, extra: Partial<CreateRoomRequest> = {}): CreateRoomRequest =>
  request({}, { video: { type: 'video/mp4', bytes: 5000, ms: 12_000, ...video }, ...extra });

/** A video room whose file has been put in storage (the creator's game does that straight to the bucket in the cloud). */
async function made(w: World, req = videoRequest(), bytes: Uint8Array = MP4(req.video?.bytes ?? 0), type: VideoType = 'video/mp4') {
  const res = await w.service.createRoom(ann, req);
  if (!res.ok) throw new Error(`create failed: ${res.error}`);
  await w.media.put(res.roomId, bytes, type);
  return res;
}

describe('making a puzzle from a video', () => {
  it('is switched off until the operator sets a limit', async () => {
    const w = world({ videoRoomsPerWeek: 0 });
    expect(await w.service.createRoom(ann, videoRequest())).toEqual({ ok: false, error: 'video-off' });
    expect((await w.service.createRoom(ann, request())).ok).toBe(true);                               // pictures are as before
  });

  it('gives the creator a place to send the file, and the puzzle cannot be joined until it has arrived and been looked at', async () => {
    const w = world();
    const res = await w.service.createRoom(ann, videoRequest());
    if (!res.ok) throw new Error(res.error);
    expect(res.upload.url).toContain(`/media/${res.roomId}/video`);
    expect(await w.service.join(bob, { protocol: 1, code: res.invite.code, secret: res.invite.secret })).toEqual({ ok: false, error: 'not-ready' });
    expect(await w.service.finishVideo(ann, res.roomId, { frames: frames() })).toEqual({ ok: false, error: 'not-ready' });           // no file yet
    await w.media.put(res.roomId, MP4(5000), 'video/mp4');
    expect(await w.service.finishVideo(ann, res.roomId, { frames: frames() })).toEqual({ ok: true });
    const room = await joined(w, res, bob);
    expect(room.media.type).toBe('video');
    expect(room.media.video).toEqual({ type: 'video/mp4', bytes: 5000, ms: 12_000 });
    expect(room.playback).toMatchObject({ pos: 0, paused: false });
  });

  it('turns away a video that is too long or too large, or of a kind that is not allowed, and counts videos by themselves', async () => {
    const w = world({ videoRoomsPerWeek: 1, freeRoomsPerWeek: 3 });
    expect(await w.service.createRoom(ann, videoRequest({ bytes: 1_000_001 }))).toEqual({ ok: false, error: 'too-big' });
    expect(await w.service.createRoom(ann, videoRequest({ ms: 30_001 }))).toEqual({ ok: false, error: 'too-big' });
    expect(await w.service.createRoom(ann, videoRequest({ type: 'video/x-flv' as VideoType }))).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.createRoom(ann, videoRequest({ bytes: 0 }))).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.createRoom(ann, videoRequest({ ms: Number.NaN }))).toEqual({ ok: false, error: 'bad-request' });
    expect((await w.service.createRoom(ann, videoRequest())).ok).toBe(true);
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
      const w = world();
      const res = await made(w, videoRequest(), bytes, type);
      expect(await w.service.finishVideo(ann, res.roomId, { frames: frames() }), what).toEqual({ ok: false, error: 'bad-request' });
      expect(w.media.has(res.roomId), what).toBe(false);
      expect(await w.store.getRoom(res.roomId), what).toBeUndefined();
    }
  });

  it('wants a few pictures, each a picture, and only from the owner', async () => {
    const w = world();
    const res = await made(w);
    expect(await w.service.finishVideo(ann, res.roomId, { frames: frames(2) })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.finishVideo(ann, res.roomId, { frames: frames(13) })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.service.finishVideo(bob, res.roomId, { frames: frames() })).toEqual({ ok: false, error: 'not-found' });
    expect(await w.service.finishVideo(ann, res.roomId, { frames: [...frames(3), 'not base64!'] })).toEqual({ ok: false, error: 'bad-request' });
    expect(await w.store.getRoom(res.roomId)).toBeUndefined();                       // the last one ended it
    const w2 = world();
    const r2 = await made(w2);
    expect(await w2.service.finishVideo(ann, r2.roomId, { frames: [...frames(3), base64(new Uint8Array([1, 2, 3, 4]))] })).toEqual({ ok: false, error: 'bad-request' });
  });

  it('looks at every picture, and ends the puzzle and tells the operator when one is turned down; a check that cannot be made leaves it as it is', async () => {
    const told: string[] = [];
    let n = 0;
    const w = world({}, undefined, undefined, async (t) => void told.push(t), { check: async () => (++n === 3 ? { ok: false, label: 'Explicit Nudity' } : { ok: true }) });
    const res = await made(w);
    expect(await w.service.finishVideo(ann, res.roomId, { frames: frames(4) })).toEqual({ ok: false, error: 'rejected' });
    expect(n).toBe(3);
    expect(told[0]).toContain('Explicit Nudity');
    expect(w.media.has(res.roomId)).toBe(false);

    const down = world({}, undefined, undefined, undefined, { check: async () => { throw new Error('down'); } });
    const r2 = await made(down);
    expect(await down.service.finishVideo(ann, r2.roomId, { frames: frames() })).toEqual({ ok: false, error: 'busy' });
    expect(await down.store.getRoom(r2.roomId)).toBeDefined();
  });

  it('is taken by the local server as the file itself, of exactly the size that was said', async () => {
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
    await w.service.finishVideo(ann, res.roomId, { frames: frames() });
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
    expect(looksLike(WEBM(20), 'video/webm')).toBe(true);
    expect(looksLike(WEBM(20), 'video/x-matroska')).toBe(true);
    expect(looksLike(WEBM(20), 'video/mp4')).toBe(false);
    expect(looksLike(MP4(20), 'video/webm')).toBe(false);
    expect(looksLike(new Uint8Array(3), 'video/mp4')).toBe(false);
    expect(looksLike(MP4(20), 'video/x-flv')).toBe(false);
  });
});

describe('the video routes of the API', () => {
  const setup = () => {
    const w = world();
    const route = createRouter({ service: w.service, auth: new DevAuth(), media: w.media });
    const as = (p: { id: string; name: string }) => `Bearer dev:${p.id}:${p.name}`;
    const post = (path: string, who: { id: string; name: string }, body: unknown) =>
      route({ method: 'POST', path, query: new URLSearchParams(), authorization: as(who), body: new TextEncoder().encode(JSON.stringify(body)) });
    return { w, route, post };
  };

  it('takes the file at the signed address (the local server), and the pictures and the host\'s word at the room\'s', async () => {
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
    expect((await post(`/rooms/${body.roomId}/video`, ann, { frames: frames() })).status).toBe(200);
    expect((await post(`/rooms/${body.roomId}/playback`, ann, { pos: 2, paused: true })).status).toBe(200);
    expect((await post(`/rooms/${body.roomId}/playback`, bob, { pos: 2, paused: true })).status).toBe(404);          // not a member
    expect(w.messages(body.roomId).some((m) => m.t === 'playback')).toBe(true);
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
