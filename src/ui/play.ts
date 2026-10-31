import { findKind, optionsOf, puzzleSeedText, recordKey, type KindDef } from '../core/kinds';
import { formatTime, type Prefs } from '../core/prefs';
import { randomSeedText, seedFromText } from '../core/rng';
import { loadPhoto } from '../image';
import type { OnlineApi } from '../online/api';
import { PLAYER_COLORS } from '../online/config';
import { PlaybackSync } from '../online/playbackSync';
import type { Invite } from '../online/protocol';
import type { OnlineRoom, RoomView } from '../online/room';
import { fitView, type View } from '../render';
import { needsStill, startSession, type PuzzleSession } from '../sessions';
import type { OnlineHooks } from '../sessions/types';
import { openVideo, type PhotoEntry, type PhotoLibrary, type PlaySource } from '../store/photos';
import type { SaveRecord, SaveStore } from '../store/saves';
import { h } from './dom';
import { sayError } from './online';
import { OnlineBar } from './onlinebar';
import { RefWindow } from './refwindow';

export interface PlayDeps {
  prefs: Prefs;
  photos: PhotoLibrary;
  /** Where puzzles left unfinished are kept. */
  saves: SaveStore;
  /** Back to the main screen. */
  onExit(): void;
  /** A photo to play next instead of the one with this id, or nothing if there is no other. */
  otherPhoto(id: string): PhotoEntry | undefined;
  /** Playing with friends is possible in this build: how to reach the server. */
  online?: { api: OnlineApi };
  /** A photo was added to the list from here (the picture of an online puzzle, kept). */
  photoAdded(id: string): void;
}

/** The screen where a puzzle is played: it owns the canvas, the clock, the video bar and the dialogs; the puzzle itself is a PuzzleSession. */
export class PlayScreen {
  readonly el: HTMLElement;
  private canvas = h('canvas', { class: 'board' });
  private ctx = this.canvas.getContext('2d')!;
  private titleEl = h('div', { class: 'title' });
  private timeEl = h('span', { class: 'time' }, '0:00');
  private togglesEl = h('div', { class: 'toggles' });
  private tabsEl = h('nav', { class: 'tabs', hidden: true, 'aria-label': 'Tabs' });
  private rotateBtn = h('button', { type: 'button', class: 'toggle', title: 'Turn the chosen piece (or right-click, R)', onclick: () => this.secondary(), hidden: true }, 'Rotate');
  private statusEl = h('span', { class: 'swaps' }, '');
  private dialogEl = h('div', { class: 'dialog', hidden: true });
  private viewBar = h('div', { class: 'viewbar', hidden: true });
  // the playback bar of a video puzzle: pause / play, the time, a draggable position, the length, sound on / off
  private pauseBtn = h('button', { type: 'button', class: 'icon', title: 'Pause', 'aria-label': 'Pause', onclick: () => this.togglePause() }, '❚❚');
  private curEl = h('span', { class: 'vt' }, '0:00');
  private totalEl = h('span', { class: 'vt' }, '0:00');
  private seekEl = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Video position' });
  private muteBtn = h('button', { type: 'button', class: 'icon', title: 'Sound', 'aria-label': 'Sound', onclick: () => this.toggleMute() });
  /** A puzzle played with friends from a video: shown when the player has gone their own way, to be taken back to where the host is. */
  private syncBtn = h('button', { type: 'button', class: 'sync', hidden: true, title: 'Go back to where the host’s video is, and follow it again', onclick: () => void this.sync?.resync() }, '↻ Sync with host');
  private vbar = h('div', { class: 'vbar', hidden: true }, this.pauseBtn, this.curEl, this.seekEl, this.totalEl, this.muteBtn, this.syncBtn);
  private sync: PlaybackSync | null = null;
  private syncTimer = 0;
  // the zoom control of a board with a camera (Jigsaw), bottom right
  private overlay: HTMLCanvasElement | null = null;
  private zoomLabel = h('button', { type: 'button', class: 'zlabel', title: 'Show everything', 'aria-label': 'Show everything', onclick: () => this.zoomFit() }, '100%');
  private zoomEl = h(
    'div',
    { class: 'zoom', hidden: true },
    h('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.4) }, '−'),
    this.zoomLabel,
    h('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.4) }, '+'),
  );
  private stage = h('div', { class: 'stage' }, this.canvas, this.dialogEl, this.viewBar, this.zoomEl);
  /** The original picture or video in a window of its own, for looking at while solving. */
  private ref = new RefWindow(this.stage, () => this.toggleRef(false));
  private refBtn = h('button', { type: 'button', class: 'toggle', title: 'Look at the original picture', 'aria-pressed': 'false', onclick: () => this.toggleRef() }, 'Original');
  private main = h('main', {}, this.tabsEl, this.stage, this.vbar);
  private restartBtn = h('button', { type: 'button', onclick: () => this.restart() }, 'Restart');
  /** A puzzle played with friends: its room, the picture it was cut from, and whether the end has been shown. */
  private online: { room: OnlineRoom; shown: boolean; blob: Blob } | null = null;
  private bar: OnlineBar | null = null;

  private entry: PhotoEntry | null = null;
  private src: PlaySource | null = null;
  private seeking = false;
  private pumpToken = 0;
  private kind: KindDef = findKind('focus')!;
  private session: PuzzleSession | null = null;
  private view: View = { scale: 1, ox: 0, oy: 0 };
  private activePointer = -1;
  private rightPointer = -1;
  private touches = new Map<number, { x: number; y: number }>();      // fingers down, in canvas pixels, while the board has a camera
  private lastButtons = 0;
  private frame = 0;
  /** A video puzzle's pieces are cut from this canvas, which holds the video's current picture (see SessionInit.source). */
  private frameCanvas: HTMLCanvasElement | null = null;
  private frameTime = -1;
  private startedAt = 0;
  private elapsed = 0;
  private running = false;
  private clock = 0;
  private token = 0;                // a start that was overtaken by another is dropped
  private beginRun = 0;             // likewise for a begin
  private loading = false;          // a puzzle is being set up: nothing is saved meanwhile
  private saveKey = '';
  private saveTimer = 0;

  constructor(private readonly deps: PlayDeps) {
    this.el = h(
      'section',
      { class: 'play' },
      h(
        'header',
        { class: 'bar' },
        h('button', { type: 'button', class: 'back', onclick: () => this.leave() }, '← Photos'),
        this.titleEl,
        h('div', { class: 'stats' }, this.timeEl, this.statusEl),
        this.togglesEl,
        this.refBtn,
        this.rotateBtn,
        this.restartBtn,
      ),
      this.main,
    );
    if (deps.online) {
      this.bar = new OnlineBar(deps.online.api, () => void this.savePicture());
      this.stage.append(this.bar.el);
    }
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => {
      this.touches.delete(e.pointerId);
      if (e.pointerId === this.rightPointer) this.rightPointer = -1;
      if (e.pointerId === this.activePointer) this.activePointer = -1;
      this.session?.pointerCancel();
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        const s = this.session;
        if (!s?.wheel || !this.dialogEl.hidden) return;
        e.preventDefault();
        s.wheel(this.boardPoint(e), e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1));
        this.after();
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.seekEl.addEventListener('pointerdown', () => (this.seeking = true));
    let moved = false;
    this.seekEl.addEventListener('input', () => {
      const v = this.src?.video;
      if (v && Number.isFinite(v.duration)) {
        v.currentTime = (Number(this.seekEl.value) / 1000) * v.duration;
        this.updateBar();
        moved = true;
      }
    });
    const endSeek = () => {
      this.seeking = false;
      if (moved) this.sync?.byPlayer();                         // the host says where the video is, a follower goes their own way
      moved = false;
    };
    this.seekEl.addEventListener('pointerup', endSeek);
    this.seekEl.addEventListener('pointercancel', endSeek);
    this.seekEl.addEventListener('change', endSeek);
    // a puzzle that is being played is kept when the page is hidden or closed, as well as shortly after each move and when leaving
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !this.el.hidden) this.saveNow();
    });
    window.addEventListener('pagehide', () => {
      if (!this.el.hidden) this.saveNow();
    });
    window.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') {
        if (this.ref.open) this.toggleRef(false);                // the window goes first, then the puzzle
        else this.leave();
      }
      else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) this.secondary();
      else if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) this.selectTab(e.key === '0' ? 9 : Number(e.key) - 1);
    });
  }

  /** Starts a puzzle of the saved type, difficulty and seed on this photo. */
  async start(entry: PhotoEntry): Promise<void> {
    const token = ++this.token;
    this.entry = entry;
    this.kind = findKind(this.deps.prefs.data.kind) ?? findKind('focus')!;
    this.titleEl.textContent = `${this.kind.name} · ${entry.name}`;
    let src: PlaySource;
    try {
      src = await this.deps.photos.load(entry);
    } catch (e) {
      if (token === this.token) {
        alert(e instanceof Error ? e.message : 'That file could not be opened');
        this.leave();
      }
      return;
    }
    if (token !== this.token) {
      src.dispose();
      return;
    }
    this.closeSource();
    this.src = src;
    this.setupVideo();
    await this.begin();
  }

  /** Opens or closes the window with the original picture (or video, which follows the one the puzzle is cut from). */
  private toggleRef(open = !this.ref.open): void {
    const { entry, src } = this;
    if (open && entry && src) this.ref.show({ image: entry.previewUrl, video: src.video ?? undefined, width: src.width, height: src.height });
    else this.ref.hide();
    this.refBtn.classList.toggle('on', this.ref.open);
    this.refBtn.setAttribute('aria-pressed', String(this.ref.open));
  }

  private closeSource(): void {
    this.stopSync();
    this.toggleRef(false);
    this.pumpToken++;
    this.src?.dispose();
    this.src = null;
    this.vbar.hidden = true;
  }

  // ---------------------------------------------------------------------------------------------------------------- video

  /** A video plays by itself (with its sound, looped); whenever it shows a new picture the board is drawn again. */
  private setupVideo(): void {
    const v = this.src?.video;
    this.vbar.hidden = !v;
    if (!v) return;
    v.muted = this.deps.prefs.data.muted;
    this.refreshMute();
    this.totalEl.textContent = formatTime((Number.isFinite(v.duration) ? v.duration : 0) * 1000);
    this.pauseBtn.textContent = '❚❚';
    v.addEventListener('play', () => this.refreshPause());
    v.addEventListener('pause', () => this.refreshPause());
    void v.play().catch(() => {
      v.muted = true;                              // the browser refused to start it with sound: start without
      this.refreshMute();
      void v.play().catch(() => undefined);
    });
    // Draw when the video shows a new picture. requestVideoFrameCallback says so exactly, but on a slow device it fires several times less often than the video shows
    // pictures, and `currentTime` alone moves between pictures in some browsers: so a draw is due when the callback has fired, or when the playing time is more than a
    // frame ahead of the last drawing.
    const token = ++this.pumpToken;
    let called = false;
    let drawnAt = -1;
    const callback = (): void => {
      if (token !== this.pumpToken) return;
      called = true;
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(callback);
    };
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(callback);
    const pump = (): void => {
      requestAnimationFrame(() => {
        if (token !== this.pumpToken) return;
        if (called || Math.abs(v.currentTime - drawnAt) > 0.04) {
          called = false;
          drawnAt = v.currentTime;
          const s = this.session;
          if (s?.videoFrame) s.videoFrame(performance.now());
          else this.requestDraw();
          this.ref.frame();
          this.updateBar();
        }
        pump();
      });
    };
    pump();
  }

  private togglePause(): void {
    const v = this.src?.video;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
    this.refreshPause();
    this.sync?.byPlayer();
  }

  /** The pause button shows what it would do (the video may have been paused or played by the sync, and not by the button). */
  private refreshPause(): void {
    const v = this.src?.video;
    if (!v) return;
    this.pauseBtn.textContent = v.paused ? '▶' : '❚❚';
    this.pauseBtn.title = v.paused ? 'Play' : 'Pause';
    this.pauseBtn.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
  }

  /** Follows the host's video (or, for the host, says where it is): the video of a puzzle played with friends. */
  private startSync(room: OnlineRoom, v: HTMLVideoElement): void {
    this.stopSync();
    const sync = new PlaybackSync(
      {
        get currentTime() {
          return v.currentTime;
        },
        get paused() {
          return v.paused;
        },
        get duration() {
          return Number.isFinite(v.duration) ? v.duration : 0;
        },
        seek: (t) => {
          v.currentTime = t;
        },
        play: () =>
          void v.play().catch(() => {
            v.muted = true;                                  // the browser refused to start it with sound: start without
            this.refreshMute();
            void v.play().catch(() => undefined);
          }),
        pause: () => v.pause(),
      },
      room,
    );
    sync.onChange = () => (this.syncBtn.hidden = !sync.apart);
    room.onPlayback = () => sync.heard();
    this.sync = sync;
    sync.start();
    this.syncBtn.hidden = !sync.apart;
    this.syncTimer = window.setInterval(() => sync.tick(), 1000);
  }

  private stopSync(): void {
    window.clearInterval(this.syncTimer);
    this.syncTimer = 0;
    if (this.online) this.online.room.onPlayback = () => undefined;
    this.sync = null;
    this.syncBtn.hidden = true;
  }

  private toggleMute(): void {
    const v = this.src?.video;
    if (!v) return;
    v.muted = !v.muted;
    this.deps.prefs.data.muted = v.muted;
    this.deps.prefs.save();
    this.refreshMute();
  }

  private refreshMute(): void {
    const muted = this.src?.video?.muted ?? this.deps.prefs.data.muted;
    this.muteBtn.textContent = muted ? '🔇' : '🔊';
    this.muteBtn.title = muted ? 'Sound off' : 'Sound on';
  }

  private updateBar(): void {
    const v = this.src?.video;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    this.curEl.textContent = formatTime(v.currentTime * 1000);
    if (!this.seeking && dur > 0) this.seekEl.value = String(Math.round((v.currentTime / dur) * 1000));
  }

  /**
   * Starts the puzzle of the saved type, difficulty and seed on this photo: as it was left if it was left unfinished, else from the start. `fresh` (Restart, New
   * puzzle) throws the unfinished one away.
   */
  private async begin(fresh = false): Promise<void> {
    const entry = this.entry;
    const src = this.src;
    if (!entry || !src) return;
    const run = ++this.beginRun;
    const { prefs, saves } = this.deps;
    const kind = this.kind;
    this.loading = true;
    window.clearTimeout(this.saveTimer);
    this.saveKey = recordKey(kind, entry.id, prefs.data.settings);
    let rec: SaveRecord | undefined;
    if (fresh) await saves.remove(this.saveKey);
    else rec = await saves.get(this.saveKey);
    if (rec && (rec.seed !== prefs.data.seed || rec.width !== src.width || rec.height !== src.height)) rec = undefined;      // another puzzle: that one is not this one
    if (needsStill(kind.id) && src.video) await this.freezeVideo(src.video);
    if (run !== this.beginRun || src !== this.src) return;
    this.frameCanvas = null;
    if (src.video) {
      this.frameCanvas = document.createElement('canvas');
      this.frameCanvas.width = src.width;
      this.frameCanvas.height = src.height;
      this.frameTime = -1;
      this.copyFrame();
    }
    const make = (restore: unknown): PuzzleSession =>
      startSession(kind.id, {
        source: this.frameCanvas ?? src.source,
        video: src.video ?? undefined,
        width: src.width,
        height: src.height,
        seed: seedFromText(puzzleSeedText(prefs.data.seed, entry.id, kind.id)),
        opts: optionsOf(prefs.data.settings, kind),
        restore,
        flag: (key) => this.flag(key),
        requestDraw: () => this.requestDraw(),
        tabsChanged: () => this.refreshTabs(),
        progress: () => this.after(),
      });
    this.session?.dispose?.();
    this.overlay?.remove();
    try {
      this.session = make(rec?.state);
    } catch {
      rec = undefined;                                          // a save that does not fit (an older version): start over
      this.session = make(undefined);
    }
    this.loading = false;
    this.mount(rec?.elapsed ?? 0, true);
  }

  /** Puts the session that was just made on the screen. `timed`: the clock runs, from `elapsed` (a puzzle played with friends has none). */
  private mount(elapsed: number, timed: boolean): void {
    const session = this.session!;
    this.overlay = session.overlay ?? null;
    if (this.overlay) {
      this.overlay.className = 'board overlay';
      this.stage.insertBefore(this.overlay, this.dialogEl);
    }
    this.buildToggles();
    this.buildTabs();
    this.rotateBtn.hidden = !session.rotatable;
    this.zoomEl.hidden = !session.zoomBy;
    this.touches.clear();
    this.rightPointer = -1;
    this.activePointer = -1;
    this.dialogEl.hidden = true;
    this.viewBar.hidden = true;
    this.elapsed = elapsed;
    this.startedAt = performance.now() - this.elapsed;
    this.running = timed;
    window.clearInterval(this.clock);
    if (timed) this.clock = window.setInterval(() => this.tick(), 250);
    this.tick();
    this.statusEl.textContent = session.status();
    this.resize();
    if (session.zoomLabel) this.zoomLabel.textContent = session.zoomLabel();
  }

  // ---------------------------------------------------------------------------------------------------------------- playing with friends

  /**
   * Plays a puzzle with friends: the picture comes from the server, the board is the room's, and what the player does goes to the room (see online/room.ts). The time shown is the
   * room's (only time with someone connected counts), for fun: there is no best time and nothing saved here, the server keeps the puzzle.
   */
  async startOnline(room: OnlineRoom, invite: Invite | null): Promise<void> {
    const token = ++this.token;
    this.beginRun++;
    this.kind = findKind('jigsaw')!;
    this.titleEl.textContent = 'Jigsaw · with friends';
    const d = room.descriptor;
    let blob: Blob;
    let src: PlaySource;
    let url: string;
    try {
      if (d.media.type === 'video' && d.media.video) {
        ({ blob, src, url } = await this.loadOnlineVideo(room, token));
      } else {
        const res = await fetch(d.media.url);
        if (!res.ok) throw new Error('The picture could not be loaded');
        blob = await res.blob();
        const canvas = await loadPhoto(blob);
        if (canvas.width !== d.settings.width || canvas.height !== d.settings.height) throw new Error('The picture does not match this puzzle');
        url = URL.createObjectURL(blob);
        src = { source: canvas, width: canvas.width, height: canvas.height, video: null, dispose: () => URL.revokeObjectURL(url) };
      }
    } catch (e) {
      if (token === this.token) this.showMessage(e instanceof Error ? e.message : 'The picture could not be loaded');
      return;
    }
    if (token !== this.token) {
      src.dispose();
      return;
    }
    this.closeSource();
    this.dialogEl.hidden = true;
    this.entry = { id: room.id, name: 'Online puzzle', sample: false, thumbUrl: url, previewUrl: url, video: !!src.video, duration: src.video?.duration ?? 0 };
    this.src = src;
    this.online = { room, shown: false, blob };
    this.saveKey = '';
    // a video plays (with its sound, looped) and the board is drawn again for each new picture of it; where it is, is the host's to say
    const still = !!src.video && needsStill('jigsaw');
    if (src.video) {
      this.setupVideo();
      if (still) await this.freezeVideo(src.video);                     // a browser that cannot draw video pieces cuts the first picture
      if (token !== this.token) return;
      this.frameCanvas = document.createElement('canvas');
      this.frameCanvas.width = src.width;
      this.frameCanvas.height = src.height;
      this.frameTime = -1;
      this.copyFrame();
    } else {
      this.frameCanvas = null;
    }
    const bar = this.bar!;
    const hooks: OnlineHooks = {
      blockedBy: () => room.holderOther()?.name ?? null,
      send: (op) => room.send(op),
      hand: (pose) => room.hand(pose),
      holding: (piece) => room.holding(piece),
      notify: (text) => bar.say(text),
      colorOf: (id) => PLAYER_COLORS[(room.member(id)?.color ?? 0) % PLAYER_COLORS.length],
    };
    this.session?.dispose?.();
    this.overlay?.remove();
    this.session = startSession('jigsaw', {
      source: this.frameCanvas ?? src.source,
      video: src.video ?? undefined,
      width: src.width,
      height: src.height,
      seed: d.settings.seed,
      opts: d.settings.opts,
      restore: { game: d.state.game, sel: -1, cam: null },
      flag: (key) => this.flag(key),
      requestDraw: () => this.requestDraw(),
      progress: () => this.after(),
      online: hooks,
    });
    this.mount(0, false);
    this.restartBtn.hidden = true;
    this.timeEl.hidden = false;
    const showTime = () => (this.timeEl.textContent = formatTime(room.playedMs()));
    showTime();
    this.clock = window.setInterval(showTime, 500);
    room.onChange = () => this.onlineChanged();
    room.onRefused = (error, holder) => {
      if (error === 'busy') bar.say(`${room.member(holder ?? '')?.name ?? 'Someone'} is moving a piece`);
      else if (error !== 'offline') bar.say(sayError(error));
    };
    room.attach(this.session as PuzzleSession & RoomView);
    if (src.video && !still) this.startSync(room, src.video);
    bar.show(room, invite);
    this.onlineChanged();
  }

  /** The video of a puzzle played with friends: the whole file is fetched (with its progress on the screen), and then played from the player's own memory. */
  private async loadOnlineVideo(room: OnlineRoom, token: number): Promise<{ blob: Blob; src: PlaySource; url: string }> {
    const d = room.descriptor;
    const info = d.media.video!;
    const say = (text: string) => {
      if (token === this.token) this.showProgress(text);
    };
    say('Loading the video… 0%');
    // a request object, not fetch: it says how far it has got, and keeps a file of two minutes' video (a couple of hundred MB) in a blob that the browser may keep on disk
    const file = await new Promise<Blob>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', d.media.url);
      x.responseType = 'blob';
      x.onprogress = (e) => {
        if (token !== this.token) {
          x.abort();
          reject(new Error('The video was not loaded'));
          return;
        }
        say(`Loading the video… ${Math.min(100, Math.round((e.lengthComputable ? e.loaded / e.total : e.loaded / info.bytes) * 100))}%`);
      };
      x.onerror = () => reject(new Error('The video could not be loaded'));
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.response as Blob) : reject(new Error('The video could not be loaded')));
      x.send();
    });
    const blob = new Blob([file], { type: info.type });
    const url = URL.createObjectURL(blob);
    let src: PlaySource;
    try {
      src = await openVideo(url);
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
    const inner = src.dispose;
    src.dispose = () => {
      inner();
      URL.revokeObjectURL(url);
    };
    if (src.width !== d.settings.width || src.height !== d.settings.height) {
      src.dispose();
      throw new Error('The video does not match this puzzle');
    }
    return { blob, src, url };
  }

  /** What is going on while a puzzle is being got ready, with a way out. */
  private showProgress(text: string): void {
    this.dialogEl.replaceChildren(h('p', {}, text), h('div', { class: 'buttons' }, h('button', { type: 'button', onclick: () => this.leave() }, 'Back')));
    this.dialogEl.hidden = false;
  }

  /** The room says something changed: the players, the connection, who holds a piece, whether the puzzle is over. */
  private onlineChanged(): void {
    const o = this.online;
    if (!o) return;
    this.bar?.refresh();
    if (o.room.solved || this.session?.solved) this.finishOnline();
    else if (o.room.status === 'closed') {
      this.showMessage(o.room.closedReason === 'owner' ? 'The puzzle was closed by the player who made it.' : o.room.closedReason === 'removed' ? 'The player who made this puzzle sent you out of it.' : 'This puzzle has ended.');
    }
  }

  private finishOnline(): void {
    const o = this.online;
    if (!o || o.shown) return;
    o.shown = true;
    window.setTimeout(() => this.showOnlineDialog(), 700);              // after the last move has finished showing
  }

  private showOnlineDialog(): void {
    if (!this.online) return;
    this.dialogEl.replaceChildren(
      h('h2', {}, 'Solved!'),
      h('p', {}, `You finished it together in ${formatTime(this.online.room.playedMs())}.`),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', onclick: () => this.viewPicture() }, 'View'),
        h('button', { type: 'button', onclick: () => void this.savePicture() }, this.online.room.descriptor.media.type === 'video' ? 'Save video' : 'Save picture'),
        h('button', { type: 'button', class: 'primary', onclick: () => this.leave() }, 'Leave'),
      ),
    );
    this.dialogEl.hidden = false;
  }

  /** A message over the board with a way out. */
  private showMessage(text: string): void {
    this.dialogEl.replaceChildren(h('p', {}, text), h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'primary', onclick: () => this.leave() }, 'Back')));
    this.dialogEl.hidden = false;
  }

  /** Keeps the picture of the puzzle in the player's own list, unless it is there already. */
  private async savePicture(): Promise<void> {
    const o = this.online;
    if (!o) return;
    const have = o.room.descriptor.media.sourceId;
    if (have && (await this.deps.photos.entry(have))) {
      this.bar?.say('You already have this picture');
      return;
    }
    // the same picture from this puzzle (saved before, here or on another visit) is one picture, not two
    if (await this.deps.photos.has(o.blob)) {
      this.bar?.say('You already have this picture');
      return;
    }
    const video = o.room.descriptor.media.type === 'video';
    const type = o.blob.type || (video ? 'video/mp4' : 'image/jpeg');
    const ext = video ? ({ 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' } as Record<string, string>)[type] ?? 'mp4' : type === 'image/png' ? 'png' : 'jpg';
    const done = await this.deps.photos.add([new File([o.blob], `Online puzzle.${ext}`, { type })]);
    if (done.ids.length) {
      this.deps.photoAdded(done.ids[0]);
      this.bar?.say(video ? 'Saved to your library' : 'Saved to your pictures');
    } else this.bar?.say(video ? 'The video could not be saved' : 'The picture could not be saved');
  }

  /** A video that a puzzle is cut from stops at its first picture, so the same pieces come back every time. */
  private async freezeVideo(v: HTMLVideoElement): Promise<void> {
    this.pumpToken++;
    v.pause();
    this.vbar.hidden = true;
    await new Promise<void>((resolve) => {
      const give = window.setTimeout(resolve, 800);
      v.addEventListener(
        'seeked',
        () => {
          window.clearTimeout(give);
          resolve();
        },
        { once: true },
      );
      v.currentTime = 0;
    });
  }

  // ---------------------------------------------------------------------------------------------------------------- saving

  private scheduleSave(): void {
    if (this.loading || !this.session || this.online) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 1500);
  }

  /** Keeps the puzzle as it is (or, if it is solved, forgets it: there is nothing to carry on). */
  private saveNow(): void {
    window.clearTimeout(this.saveTimer);
    const { entry, session, src } = this;
    if (!entry || !session || !src || this.loading || !this.saveKey || this.online) return;
    const { prefs, saves } = this.deps;
    if (session.solved) {
      void saves.remove(this.saveKey);
      return;
    }
    void saves.put({
      key: this.saveKey,
      photoId: entry.id,
      kind: this.kind.id,
      seed: prefs.data.seed,
      width: src.width,
      height: src.height,
      elapsed: this.running ? performance.now() - this.startedAt : this.elapsed,
      savedAt: Date.now(),
      status: session.status(),
      state: session.serialize(),
    });
  }

  /** A display setting of the chosen type (grid lines, animations): on unless the player turned it off. */
  private flag(key: string): boolean {
    return optionsOf(this.deps.prefs.data.settings, this.kind)[key] !== 0;
  }

  private buildToggles(): void {
    this.togglesEl.replaceChildren(
      ...(this.session?.toggles ?? []).map((t) =>
        h('button', { type: 'button', class: 'toggle', title: t.title, dataset: { key: t.key }, onclick: () => this.toggle(t.key) }, t.label),
      ),
    );
    this.refreshToggles();
  }

  // ---------------------------------------------------------------------------------------------------------------- tabs

  /** A row of numbered tabs when the puzzle has pages (Strips): each shows how many loose pieces lie on it. */
  private buildTabs(): void {
    const info = this.session?.tabInfo?.() ?? null;
    this.tabsEl.hidden = !info;
    if (!info) return;
    this.tabsEl.replaceChildren(
      ...info.counts.map((_, i) =>
        h('button', { type: 'button', class: 'tab', dataset: { tab: String(i) }, title: `Tab ${i + 1}`, onclick: () => this.selectTab(i) }, h('span', { class: 'tn' }, String((i + 1) % 10 === 0 ? 10 : i + 1)), h('span', { class: 'tc' })),
      ),
    );
    this.refreshTabs();
  }

  private refreshTabs(): void {
    const info = this.session?.tabInfo?.() ?? null;
    if (!info) return;
    this.tabsEl.querySelectorAll<HTMLElement>('.tab').forEach((btn, i) => {
      btn.classList.toggle('on', i === info.active);
      btn.classList.toggle('empty', info.counts[i] === 0);
      const tc = btn.querySelector('.tc');
      if (tc) tc.textContent = info.counts[i] > 0 ? String(info.counts[i]) : '';
    });
  }

  private selectTab(i: number): void {
    this.session?.selectTab?.(i);
    this.refreshTabs();
    this.requestDraw();
  }

  /** The tab button under the pointer while something is dragged, or -1. */
  private tabUnder(e: PointerEvent): number {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.tab');
    return el ? Number(el.dataset.tab) : -1;
  }

  private toggle(key: string): void {
    const { prefs } = this.deps;
    prefs.data.settings[`${this.kind.id}.${key}`] = this.flag(key) ? 0 : 1;
    prefs.save();
    this.refreshToggles();
    this.session?.settingsChanged();
    this.requestDraw();
  }

  private refreshToggles(): void {
    this.togglesEl.querySelectorAll('button').forEach((btn) => {
      const on = this.flag((btn as HTMLElement).dataset.key ?? '');
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  private restart(): void {
    void this.begin(true);
  }

  private newPuzzle(): void {
    this.deps.prefs.data.seed = randomSeedText();
    this.deps.prefs.save();
    void this.begin(true);
  }

  /** A new puzzle on another photo, with the type and settings this one had (the photo is remembered as the chosen one, for when the player is back at the list). */
  private otherPhotoPuzzle(): void {
    const next = this.entry && this.deps.otherPhoto(this.entry.id);
    if (!next) return;
    const { prefs } = this.deps;
    prefs.data.photo = next.id;
    prefs.data.seed = randomSeedText();
    prefs.save();
    this.dialogEl.hidden = true;
    void this.start(next);
  }

  private leave(): void {
    const o = this.online;
    if (o) {
      o.room.detach();
      this.bar?.hide();
      // a puzzle that is over is not kept in the list; one that is not stays, and can be opened again
      if (o.room.solved || o.room.status === 'closed') void this.deps.online?.api.leave(o.room.id);
      this.online = null;
      this.restartBtn.hidden = false;
      this.timeEl.textContent = '0:00';
    }
    this.saveNow();
    this.token++;
    this.beginRun++;
    this.stopClock();
    this.closeSource();
    this.session?.dispose?.();
    this.overlay?.remove();
    this.overlay = null;
    this.session = null;
    this.deps.onExit();
  }

  private stopClock(): void {
    this.running = false;
    window.clearInterval(this.clock);
  }

  private tick(): void {
    if (this.running) this.elapsed = performance.now() - this.startedAt;
    this.timeEl.textContent = formatTime(this.elapsed);
  }

  // ---------------------------------------------------------------------------------------------------------------- drawing and input

  private resize(): void {
    if (!this.src || !this.session) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
    this.syncView();
    this.requestDraw();
  }

  /** The view of the board on the canvas: the session's own when it has a camera, else the whole board fitted in. */
  private syncView(): void {
    const s = this.session;
    if (!s) return;
    if (s.view) this.view = s.view(this.canvas.width, this.canvas.height);
    else {
      const size = s.layout(this.canvas.width, this.canvas.height);
      this.view = fitView(size.width, size.height, this.canvas.width, this.canvas.height, 12 * (window.devicePixelRatio || 1));
    }
  }

  private requestDraw(): void {
    if (!this.frame) this.frame = requestAnimationFrame((now) => this.render(now));
  }

  /** Copies the video's picture into the canvas the pieces are cut from, if it has changed since the last copy (one video-frame copy per picture, not one per piece). */
  private copyFrame(): void {
    const v = this.src?.video;
    const c = this.frameCanvas;
    if (!v || !c || v.readyState < 2 || v.currentTime === this.frameTime) return;
    this.frameTime = v.currentTime;
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
  }

  private render(now: number): void {
    this.frame = 0;
    if (!this.session || !this.src) return;
    if (!this.session.overlay) this.copyFrame();             // (a session that draws on the graphics card takes the video's pictures itself)
    this.syncView();
    if (this.session.draw(this.ctx, this.view, now)) this.requestDraw();
  }

  /** Canvas pixels under a pointer or mouse event. */
  private canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  }

  /** Board units under a pointer event. */
  private boardPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
    this.syncView();
    const p = this.canvasPoint(e);
    return { x: (p.x - this.view.ox) / this.view.scale, y: (p.y - this.view.oy) / this.view.scale };
  }

  private pointerDown(e: PointerEvent): void {
    const session = this.session;
    if (!session || !this.dialogEl.hidden) return;
    if (e.button === 2 && session.rightDown) {                 // a board with a camera: the right button moves it
      e.preventDefault();
      this.rightPointer = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      session.rightDown(this.boardPoint(e));
      this.after();
      return;
    }
    const turnWithSecondFinger = e.pointerType === 'touch' && this.activePointer >= 0 && e.pointerId !== this.activePointer && !!session.holding?.();
    if (e.pointerType === 'touch' && session.pinch && !turnWithSecondFinger) {   // a second finger zooms (and moves) a board with a camera, unless a piece is in hand: then it turns it
      this.touches.set(e.pointerId, this.canvasPoint(e));
      if (this.touches.size === 2) {
        if (this.activePointer >= 0) session.pointerCancel();
        this.activePointer = -1;
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (this.touches.size > 2) return;
    } else if (e.button === 2 || (this.activePointer >= 0 && e.pointerId !== this.activePointer)) {      // right button, or a second finger
      e.preventDefault();
      session.secondary();
      this.after();
      return;
    }
    if (e.button !== 0) return;
    this.activePointer = e.pointerId;
    this.lastButtons = e.buttons;
    this.canvas.setPointerCapture(e.pointerId);
    session.pointerDown(this.boardPoint(e), e.pointerType === 'touch');
    this.after();
  }

  private pointerMove(e: PointerEvent): void {
    const session = this.session;
    if (!session) return;
    if (e.pointerId === this.rightPointer) {
      session.rightMove?.(this.boardPoint(e));
      this.after();
      return;
    }
    if (this.touches.has(e.pointerId) && this.touches.size === 2 && session.pinch) {
      const [a, b] = [...this.touches.values()];
      const was = { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
      this.touches.set(e.pointerId, this.canvasPoint(e));
      const [c, d] = [...this.touches.values()];
      const now = { mid: { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }, dist: Math.hypot(c.x - d.x, c.y - d.y) };
      if (was.dist > 0 && now.dist > 0) session.pinch(was.mid, now.mid, now.dist / was.dist);
      this.after();
      return;
    }
    if (this.activePointer >= 0 && e.pointerId !== this.activePointer) return;
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, this.canvasPoint(e));
    // pressing the right button while the left one is held does not start a new pointer: it shows up as a change of the pressed buttons
    if (e.pointerId === this.activePointer && (e.buttons & 2) !== 0 && (this.lastButtons & 2) === 0) session.secondary();
    this.lastButtons = e.buttons;
    if (e.pointerId === this.activePointer) session.dragOverTab?.(this.tabUnder(e));
    session.pointerMove(this.boardPoint(e));
    this.after();
  }

  private pointerUp(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    if (e.pointerId === this.rightPointer) {
      this.rightPointer = -1;
      this.session?.rightUp?.(this.boardPoint(e));
      this.after();
      return;
    }
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = -1;
    this.session?.pointerUp(this.boardPoint(e));
    this.after();
  }

  private zoomBy(factor: number): void {
    this.session?.zoomBy?.(factor);
    this.after();
  }

  private zoomFit(): void {
    this.session?.zoomFit?.();
    this.after();
  }

  private secondary(): void {
    this.session?.secondary();
    this.after();
  }

  /** After anything the player did: the progress text, and whether the puzzle is finished. */
  private after(): void {
    const session = this.session;
    if (!session) return;
    this.statusEl.textContent = session.status();
    if (session.zoomLabel) this.zoomLabel.textContent = session.zoomLabel();
    this.refreshTabs();
    if (this.online) {
      if (session.solved) this.finishOnline();
    } else if (session.solved && this.running) this.finish();
    else this.scheduleSave();
    this.requestDraw();
  }

  // ---------------------------------------------------------------------------------------------------------------- the end

  private finish(): void {
    const entry = this.entry;
    if (!this.session || !entry) return;
    this.elapsed = performance.now() - this.startedAt;
    this.stopClock();
    this.tick();
    window.clearTimeout(this.saveTimer);
    void this.deps.saves.remove(this.saveKey);
    const { prefs } = this.deps;
    const key = recordKey(this.kind, entry.id, prefs.data.settings);
    const isBest = prefs.recordTime(key, this.elapsed);
    window.setTimeout(() => this.showDialog(isBest, prefs.bestTime(key) ?? this.elapsed), 700);     // after the last move has finished showing
  }

  private showDialog(isBest: boolean, best: number): void {
    if (!this.session) return;
    this.dialogEl.replaceChildren(
      h('h2', {}, 'Solved!'),
      h('p', {}, `Time ${formatTime(this.elapsed)} · ${this.session.status()}`),
      h('p', { class: 'best' }, isBest ? 'New best time!' : `Best time ${formatTime(best)}`),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', onclick: () => this.viewPicture() }, 'View'),
        h('button', { type: 'button', class: 'primary', onclick: () => this.newPuzzle() }, 'New puzzle'),
        ...(this.entry && this.deps.otherPhoto(this.entry.id) ? [h('button', { type: 'button', title: 'The same settings on another photo', onclick: () => this.otherPhotoPuzzle() }, 'Other photo')] : []),
        h('button', { type: 'button', onclick: () => this.leave() }, 'Photos'),
      ),
    );
    this.dialogEl.hidden = false;
  }

  /** Looking at the finished picture: the dialog steps aside and a bar brings it back. */
  private viewPicture(): void {
    this.dialogEl.hidden = true;
    this.viewBar.replaceChildren(h('button', { type: 'button', class: 'primary', onclick: () => this.backToDialog() }, 'Continue'));
    this.viewBar.hidden = false;
  }

  private backToDialog(): void {
    this.viewBar.hidden = true;
    this.dialogEl.hidden = false;
  }
}
