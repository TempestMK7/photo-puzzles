import { playbackNow, type Playback } from './protocol';

/** The video that is played, as the sync needs to move it (a test puts a fake in its place). */
export interface SyncVideo {
  readonly currentTime: number;
  readonly paused: boolean;
  readonly duration: number;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
}

/** What the sync needs of the room (`OnlineRoom` has all of it). */
export interface SyncRoom {
  /** This player is the host: the one whose video the others follow. */
  readonly host: boolean;
  /** The server's clock, in ms. */
  readonly serverNow: number;
  /** Where the host's video is, as the host last said. */
  readonly playback: Playback | null;
  sendPlayback(pos: number, paused: boolean): void;
  /** Asks the server where the host's video is now. */
  refreshPlayback(): Promise<Playback | null>;
}

/** A video that is further than this (seconds) from where the host's is gets moved. Smaller is the ordinary unevenness of two devices and is left alone, so that nothing stutters. */
export const DRIFT_SECONDS = 0.7;
/** A paused video is put exactly where the host paused (anything beyond this is moved). */
export const PAUSED_SECONDS = 0.05;
/** The host says where the video is this often while it plays, so that a game that was slow to hear (or stalled) catches up. */
export const HEARTBEAT_MS = 15_000;

/**
 * The video of a puzzle played with friends. The **host** (the player who made the puzzle) plays, pauses and moves their video freely and says each of those to the room. Everyone
 * else **follows** the host: the video starts where the host's is and goes on in step, until the player plays, pauses or moves it themselves; then it is theirs, and `following` is false
 * until they ask to be taken back to the host (`resync`, behind a button). The host's words are kept even while a player is on their own, so the way back is always exact.
 */
export class PlaybackSync {
  private follows = true;
  private lastSent = 0;
  /** Called when `following` changed (the screen shows or hides the button that takes the player back to the host). */
  onChange: () => void = () => undefined;

  constructor(
    private readonly video: SyncVideo,
    private readonly room: SyncRoom,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Not the host, and the video is not the host's any more. The host is never "apart". */
  get apart(): boolean {
    return !this.room.host && !this.follows;
  }

  /** Puts the video where the host's was (a player; the host too, who picks up where the video was left), and the host says where it is. */
  start(): void {
    this.follow();
    if (this.room.host) this.say();
  }

  /** The room heard the host. A player who follows is moved to match. */
  heard(): void {
    if (!this.room.host && this.follows) this.follow();
  }

  /** The player played, paused or moved the video with their own hands. */
  byPlayer(): void {
    if (this.room.host) {
      this.say();
    } else if (this.follows) {
      this.follows = false;
      this.onChange();
    }
  }

  /** The button: back to the host. Asks the server first (the player may have lost touch for a while), and goes with what was last said if it cannot be reached. */
  async resync(): Promise<void> {
    if (this.room.host) return;
    await this.room.refreshPlayback();
    this.follows = true;
    this.follow();
    this.onChange();
  }

  /** Called every second or so while the video is on the screen: the host repeats where the video is now and then, a follower is moved back if it has drifted. */
  tick(): void {
    if (this.room.host) {
      if (!this.video.paused && this.now() - this.lastSent >= HEARTBEAT_MS) this.say();
    } else if (this.follows) {
      this.follow();
    }
  }

  private say(): void {
    this.lastSent = this.now();
    this.room.sendPlayback(this.video.currentTime, this.video.paused);
  }

  private follow(): void {
    const p = this.room.playback;
    if (!p) return;
    const duration = this.video.duration;
    const target = playbackNow(p, this.room.serverNow, duration);
    if (p.paused) {
      if (!this.video.paused) this.video.pause();
      if (this.distance(target) > PAUSED_SECONDS) this.video.seek(target);
    } else {
      if (this.distance(target) > DRIFT_SECONDS) this.video.seek(target);
      if (this.video.paused) this.video.play();
    }
  }

  /** How far the video is from a place in it, the short way round (it loops). */
  private distance(target: number): number {
    const d = Math.abs(this.video.currentTime - target);
    const length = this.video.duration;
    return length > 0 ? Math.min(d, Math.max(0, length - d)) : d;
  }
}
