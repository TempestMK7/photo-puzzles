import { describe, expect, it } from 'vitest';
import { DRIFT_SECONDS, HEARTBEAT_MS, PlaybackSync, type SyncRoom, type SyncVideo } from '../src/online/playbackSync';
import type { Playback } from '../src/online/protocol';

class FakeVideo implements SyncVideo {
  currentTime = 0;
  paused = true;
  duration = 20;
  seeks: number[] = [];
  seek(t: number): void {
    this.currentTime = t;
    this.seeks.push(t);
  }
  play(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
}

class FakeRoom implements SyncRoom {
  host = false;
  serverNow = 100_000;
  playback: Playback | null = null;
  sent: { pos: number; paused: boolean }[] = [];
  fresh: Playback | null = null;
  refreshed = 0;
  sendPlayback(pos: number, paused: boolean): void {
    this.sent.push({ pos, paused });
  }
  async refreshPlayback(): Promise<Playback | null> {
    this.refreshed++;
    if (this.fresh) this.playback = this.fresh;
    return this.playback;
  }
}

const setup = (host = false) => {
  const video = new FakeVideo();
  const room = new FakeRoom();
  room.host = host;
  let clock = 0;
  const sync = new PlaybackSync(video, room, () => clock);
  const changes: boolean[] = [];
  sync.onChange = () => changes.push(sync.apart);
  return { video, room, sync, changes, time: (t: number) => (clock = t) };
};

describe('a player who joins somebody else\'s video puzzle', () => {
  it('starts where the host is, and playing if the host is playing: the host\'s position moves on with the server\'s clock', () => {
    const t = setup();
    t.room.playback = { pos: 5, paused: false, at: 90_000 };            // said ten seconds ago
    t.sync.start();
    expect(t.video.currentTime).toBeCloseTo(15);
    expect(t.video.paused).toBe(false);
    expect(t.sync.apart).toBe(false);
  });

  it('starts paused at the host\'s place if the host paused', () => {
    const t = setup();
    t.video.paused = false;
    t.room.playback = { pos: 7.25, paused: true, at: 1000 };
    t.sync.start();
    expect(t.video.paused).toBe(true);
    expect(t.video.currentTime).toBe(7.25);
  });

  it('follows the host while the player does nothing: pause, play and moving, and leaves small differences alone', () => {
    const t = setup();
    t.room.playback = { pos: 2, paused: false, at: 100_000 };
    t.sync.start();
    t.video.seeks.length = 0;
    t.video.currentTime = 2.3;                                           // a little behind: not worth a jump
    t.room.playback = { pos: 2.5, paused: false, at: 100_000 };
    t.sync.heard();
    expect(t.video.seeks).toEqual([]);
    t.room.playback = { pos: 12, paused: false, at: 100_000 };           // the host moved on
    t.sync.heard();
    expect(t.video.seeks).toEqual([12]);
    t.room.playback = { pos: 12, paused: true, at: 100_000 };
    t.sync.heard();
    expect(t.video.paused).toBe(true);
    expect(t.video.currentTime).toBe(12);
  });

  it('goes on its own when the player pauses or moves it, and the host\'s words no longer move it', () => {
    const t = setup();
    t.room.playback = { pos: 2, paused: false, at: 100_000 };
    t.sync.start();
    t.video.pause();                                                     // the player's own hand
    t.sync.byPlayer();
    expect(t.sync.apart).toBe(true);
    expect(t.changes).toEqual([true]);
    t.room.playback = { pos: 9, paused: false, at: 100_000 };
    t.sync.heard();
    t.sync.tick();
    expect(t.video.paused).toBe(true);
    expect(t.video.currentTime).toBe(2);
    t.sync.byPlayer();                                                   // more of their own: nothing more to say
    expect(t.changes).toEqual([true]);
    expect(t.room.sent).toEqual([]);                                     // and a player says nothing to the room
  });

  it('is taken back to the host by the button, using what the server says now', async () => {
    const t = setup();
    t.room.playback = { pos: 2, paused: false, at: 100_000 };
    t.sync.start();
    t.video.pause();
    t.sync.byPlayer();
    t.room.fresh = { pos: 6, paused: false, at: 98_000 };               // the host is at 8 s now
    await t.sync.resync();
    expect(t.room.refreshed).toBe(1);
    expect(t.sync.apart).toBe(false);
    expect(t.changes).toEqual([true, false]);
    expect(t.video.currentTime).toBeCloseTo(8);
    expect(t.video.paused).toBe(false);
    t.room.playback = { pos: 1, paused: true, at: 100_000 };             // and follows again
    t.sync.heard();
    expect(t.video.paused).toBe(true);
  });

  it('is brought back by the check now and then when it has drifted, the short way round the loop', () => {
    const t = setup();
    t.room.playback = { pos: 19.5, paused: false, at: 100_000 };
    t.sync.start();
    t.video.seeks.length = 0;
    t.video.currentTime = 0.4;                                           // 0.9 s ahead across the loop point: more than the drift
    t.sync.tick();
    expect(t.video.seeks).toHaveLength(1);
    t.video.seeks.length = 0;
    t.video.currentTime = 19.5 + 0.2 - 20 + DRIFT_SECONDS / 2;           // within the drift: left alone
    t.sync.tick();
    expect(t.video.seeks).toEqual([]);
  });

  it('does nothing before the host has said anything', () => {
    const t = setup();
    t.sync.start();
    t.sync.heard();
    t.sync.tick();
    expect(t.video.seeks).toEqual([]);
    expect(t.video.paused).toBe(true);
  });
});

describe('the host', () => {
  it('says where the video is when the puzzle starts, and each time the player plays, pauses or moves it', () => {
    const t = setup(true);
    t.video.currentTime = 3;
    t.video.paused = false;
    t.sync.start();
    expect(t.room.sent).toEqual([{ pos: 3, paused: false }]);
    t.video.pause();
    t.video.currentTime = 4.5;
    t.sync.byPlayer();
    expect(t.room.sent.at(-1)).toEqual({ pos: 4.5, paused: true });
    expect(t.sync.apart).toBe(false);
  });

  it('picks up where the video was left when the puzzle is opened again, as if it had gone on playing', () => {
    const t = setup(true);
    t.room.playback = { pos: 4, paused: false, at: 96_000 };
    t.sync.start();
    expect(t.video.currentTime).toBeCloseTo(8);
    expect(t.video.paused).toBe(false);
    expect(t.room.sent).toEqual([{ pos: t.video.currentTime, paused: false }]);
  });

  it('repeats it now and then while the video plays, and not while it is paused', () => {
    const t = setup(true);
    t.video.paused = false;
    t.time(1000);
    t.sync.start();
    t.room.sent.length = 0;
    t.time(1000 + HEARTBEAT_MS - 1);
    t.sync.tick();
    expect(t.room.sent).toHaveLength(0);
    t.time(1000 + HEARTBEAT_MS);
    t.video.currentTime = 15;
    t.sync.tick();
    expect(t.room.sent).toEqual([{ pos: 15, paused: false }]);
    t.video.pause();
    t.time(1000 + 5 * HEARTBEAT_MS);
    t.sync.tick();
    expect(t.room.sent).toHaveLength(1);
  });

  it('is never taken anywhere by the others\' words, or by the button', async () => {
    const t = setup(true);
    t.room.playback = { pos: 9, paused: true, at: 1 };
    t.video.currentTime = 2;
    t.sync.heard();
    t.sync.tick();
    await t.sync.resync();
    expect(t.video.currentTime).toBe(2);
    expect(t.room.refreshed).toBe(0);
  });
});
