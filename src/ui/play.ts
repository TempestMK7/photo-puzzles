import { sizeIndexOf } from '../core/achievements';
import { sizeLabels } from '../core/besttimes';
import type { HelpKind } from '../core/help';
import { countsForBestTimes, findKind, generalValue, optionsOf, puzzleSeedText, recordKey, SIZE, type KindDef, type KindId } from '../core/kinds';
import { formatTime, type Prefs } from '../core/prefs';
import { randomSeedText, seedFromText } from '../core/rng';
import { loadPhoto } from '../image';
import type { OnlineApi } from '../online/api';
import { PLAYER_COLORS } from '../online/config';
import { PlaybackSync } from '../online/playbackSync';
import { type Invite, type VideoRange } from '../online/protocol';
import type { OnlineRoom, RoomView } from '../online/room';
import type { OnlineSession } from '../online/session';
import { fitView, type View } from '../render';
import { needsStill, startSession, type PuzzleSession } from '../sessions';
import type { OnlineHooks } from '../sessions/types';
import { openVideo, type PhotoEntry, type PhotoLibrary, type PlaySource } from '../store/photos';
import type { SaveRecord, SaveStore } from '../store/saves';
import { cancelEffects, playEffect } from '../sounds';
import type { AchievementStore } from '../store/achievements';
import type { BestTimeStore } from '../store/besttimes';
import { Autosave } from '../store/autosave';
import { launchConfetti } from './confetti';
import { h, svg } from './dom';
import { HELP_ICONS } from './icons';
import { settingsButton } from './settings';
import { sayError } from './online';
import { OnlineBar } from './onlinebar';
import { RefWindow } from './refwindow';
import { openHowTo } from './howto';
import { howtoNew, nextStep, type Step } from '../core/tutorial';
import type { Tutorial } from './tutorial';

const HOWTO_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/></svg>';

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
  /** Who is playing: their hints and bombs are theirs to use here (nothing is shown without it). */
  player?: OnlineSession;
  /** Makes a button for the inventory (credits, hints, bombs), for the top bar of this screen. */
  inventory?: () => HTMLButtonElement;
  /** The walk-through of the game: What the player has been shown, and the bubble that points things out. */
  tutorial?: Tutorial;
  /** An ad for hints or a bomb can be watched now (the buttons of hints and bombs glow then). */
  helpAdReady?: () => boolean;
  /** Opens the inventory at the hints or the bombs (a button with none left leads there). */
  openHelp?: (kind: HelpKind) => void;
  /** The achievements: told when a hint or a bomb is used and when a puzzle is solved. */
  achievements?: AchievementStore;
  /** The best time of each kind and size: a puzzle played alone is entered when it is solved. */
  bestTimes?: BestTimeStore;
}

/** What a session of this kind is given to start from the room's board (what `serialize` makes when a puzzle is saved: see each session). */
function onlineRestore(kind: KindId, game: unknown): unknown {
  switch (kind) {
    case 'jigsaw':
      return { game, sel: -1, cam: null };
    case 'overlap':
      return { game, activeStack: 0 };
    case 'strips':
      return { game, tab: 0 };
    default:
      return game;
  }
}

/** The screen where a puzzle is played: it owns the canvas, the clock, the video bar and the dialogs; the puzzle itself is a PuzzleSession. */
export class PlayScreen {
  readonly el: HTMLElement;
  private canvas = h('canvas', { class: 'board' });
  private ctx = this.canvas.getContext('2d')!;
  private titleEl = h('div', { class: 'title' });
  private timeEl = h('span', { class: 'time' }, '0:00');
  private tabsEl = h('nav', { class: 'tabs', hidden: true, 'aria-label': 'Tabs' });
  private rotateBtn = h('button', { type: 'button', class: 'toggle', title: 'Turn the chosen piece (or right-click, R)', onclick: () => this.secondary(), hidden: true }, 'Rotate');
  private statusEl = h('span', { class: 'swaps' }, '');
  private dialogEl = h('div', { class: 'dialog', hidden: true });
  private viewBar = h('div', { class: 'viewbar', hidden: true });
  // the playback bar of a video puzzle: pause / play, the time, a draggable position, the length, sound on / off
  /** Opens a bar above the timeline with two dots that choose the part of the video that plays (the whole of it to begin with). */
  private restrictBtn = h('button', { type: 'button', class: 'restrict', title: 'Choose the part of the video that plays over and over', 'aria-pressed': 'false', onclick: () => this.toggleRestrict() }, 'Duration');
  private rangeFill = h('div', { class: 'fill' });
  private rangeLo = h('input', { type: 'range', class: 'lo', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Start of the part that plays' });
  private rangeHi = h('input', { type: 'range', class: 'hi', min: 0, max: 1000, value: 1000, step: 1, 'aria-label': 'End of the part that plays' });
  private rangeBar = h('div', { class: 'rangebar', hidden: true }, this.rangeFill, this.rangeLo, this.rangeHi);
  /** The part of the video that is looped over (nothing: the whole of it). */
  private range: VideoRange | null = null;
  private pauseBtn = h('button', { type: 'button', class: 'icon', title: 'Pause', 'aria-label': 'Pause', onclick: () => this.togglePause() }, '❚❚');
  private curEl = h('span', { class: 'vt' }, '0:00');
  private totalEl = h('span', { class: 'vt' }, '0:00');
  private seekEl = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Video position' });
  private seekWrap = h('div', { class: 'seekwrap' }, this.rangeBar, this.seekEl);
  private muteBtn = h('button', { type: 'button', class: 'icon', title: 'Sound', 'aria-label': 'Sound', onclick: () => this.toggleMute() });
  /** A puzzle played with friends from a video: shown when the player has gone their own way, to be taken back to where the host is. */
  private syncBtn = h('button', { type: 'button', class: 'sync', hidden: true, title: 'Go back to where the host’s video is, and follow it again', onclick: () => void this.sync?.resync() }, '↻ Sync with host');
  private vbar = h('div', { class: 'vbar', hidden: true }, this.restrictBtn, this.pauseBtn, this.curEl, this.seekWrap, this.totalEl, this.muteBtn, this.syncBtn);
  private sync: PlaybackSync | null = null;
  private syncTimer = 0;
  // the zoom control of a board with a camera (Jigsaw), bottom right
  private overlay: HTMLCanvasElement | null = null;
  private front: HTMLCanvasElement | null = null;
  private zoomLabel = h('button', { type: 'button', class: 'zlabel', title: 'Show everything', 'aria-label': 'Show everything', onclick: () => this.zoomFit() }, '100%');
  private zoomEl = h(
    'div',
    { class: 'zoom', hidden: true },
    h('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.4) }, '−'),
    this.zoomLabel,
    h('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.4) }, '+'),
  );
  /** The line over the board that says what the chosen hint or bomb does (or why one was not used). */
  private helpNote = h('div', { class: 'helpnote', hidden: true, role: 'status' });
  /** The sorting trays (a Jigsaw): the bar of them at the left, and the title and buttons over the header of the one that is open. */
  private trayBar = h('nav', { class: 'traybar', hidden: true, 'aria-label': 'Sorting trays' });
  private trayHead = h('div', { class: 'trayhead', hidden: true });
  private stage = h('div', { class: 'stage' }, this.canvas, this.dialogEl, this.viewBar, this.zoomEl, this.trayBar, this.trayHead, this.helpNote);
  /** The original picture or video in a window of its own, for looking at while solving. */
  private ref = new RefWindow(this.stage, () => this.toggleRef(false));
  private refBtn = h('button', { type: 'button', class: 'toggle', title: 'Look at the original photo', 'aria-pressed': 'false', onclick: () => this.toggleRef() }, 'Show Photo');
  private main = h('main', {}, this.tabsEl, this.stage, this.vbar);
  // hints and bombs (Tile Swap, Overlap, Strips, Jigsaw): the player picks one, then taps the board; it comes out of their account (see core/help.ts)
  /** Opens the window with the controls and rules of this puzzle type; it glows until it has been opened for the type. */
  private howBtn = h('button', { type: 'button', class: 'toggle howto-btn', title: 'How to play this puzzle: the controls and the rules', 'aria-label': 'How To Play', onclick: () => this.openHowTo() }, svg(HOWTO_ICON, 'ico'), h('span', { class: 'label' }, 'How To Play'));
  private invBtn: HTMLButtonElement | undefined;
  /** The steps of the walk-through that the player has put away for this puzzle, the one that is showing, and whether the How To Play window is open. */
  private putAway = new Set<Step>();
  private tipKey = '';
  private howtoOpen = false;
  private hintBtn = this.helpButton('hint', 'Hint');
  private bombBtn = this.helpButton('bomb', 'Bomb');
  private helpEl = h('span', { class: 'helps', hidden: true }, this.hintBtn, this.bombBtn);
  /** The one that is chosen, whether the press that is down may still be a tap (and where it began), and whether one is being used (the server is asked first). */
  private armed: HelpKind | null = null;
  private helpTap: { x: number; y: number } | null = null;
  private helpBusy = false;
  private waiting = 0;
  private helpShown = '';
  private noteTimer = 0;
  /** What the solved puzzle gave, for the end-of-puzzle window of a puzzle played with friends. */
  private earned = 0;
  /** A puzzle played with friends: its room, the picture it was cut from, and whether the end has been shown. */
  private online: { room: OnlineRoom; shown: boolean; blob: Blob; saved: boolean } | null = null;
  /** The button of the end-of-puzzle window that keeps the picture (greyed out when the picture is in the player's library). */
  private saveDialogBtn: HTMLButtonElement | null = null;
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
  /** Keeps the puzzle once the player has been still for 1.5 s, and at the latest 5 s after the first move that has not been kept (see `Autosave`). */
  private autosave = new Autosave(() => this.keep());

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
        // two groups at the right (side by side, or one under the other on a phone: style.css): what is done to the board, then what is the player's
        h('div', { class: 'view-group' }, this.rotateBtn, this.refBtn),
        h('div', { class: 'tool-group' }, this.howBtn, this.helpEl, (this.invBtn = deps.inventory?.()), settingsButton(deps.prefs, () => this.settingsChanged())),
      ),
      this.main,
    );
    if (deps.online) {
      this.bar = new OnlineBar(deps.online.api, () => void this.savePicture());
      this.stage.append(this.bar.el);
      // the bar of trays lies under the first row of the online bar (which wraps on a narrow screen), whatever its height is
      const row = this.bar.el.firstElementChild as HTMLElement | null;
      if (row && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => this.stage.style.setProperty('--obar', `${row.offsetHeight ? row.offsetHeight + 6 : 0}px`)).observe(row);
      }
    }
    deps.player?.onChange(() => {
      this.refreshHelp();
      this.coachTick();
    });
    deps.tutorial?.onChange(() => this.coachTick());
    if (deps.player) deps.player.onSpendRefused = (item) => this.session && this.flash(`The server had no ${item}s left for one that was used.`);
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => {
      this.touches.delete(e.pointerId);
      if (e.pointerId === this.rightPointer) this.rightPointer = -1;
      if (e.pointerId === this.activePointer) this.activePointer = -1;
      this.helpTap = null;
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
    // the two dots of the range: neither goes past the other (at least a tenth of a second apart); letting go says it to the room
    const nudge = (which: 'lo' | 'hi') => () => {
      const lo = this.rangeLo as HTMLInputElement;
      const hi = this.rangeHi as HTMLInputElement;
      const v = this.src?.video;
      const gap = Math.max(1, v && v.duration > 0 ? Math.ceil((0.1 / v.duration) * 1000) : 1);
      if (which === 'lo' && Number(lo.value) > Number(hi.value) - gap) lo.value = String(Math.max(0, Number(hi.value) - gap));
      if (which === 'hi' && Number(hi.value) < Number(lo.value) + gap) hi.value = String(Math.min(1000, Number(lo.value) + gap));
      this.rangeFromDots();
    };
    this.rangeLo.addEventListener('input', nudge('lo'));
    this.rangeHi.addEventListener('input', nudge('hi'));
    for (const dot of [this.rangeLo, this.rangeHi]) dot.addEventListener('change', () => this.sync?.byPlayer());      // (the host says it; a follower goes their own way)
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
        if (this.armed) this.arm(null);                          // a chosen hint or bomb goes first
        else if (this.ref.open) this.toggleRef(false);                // the window goes first, then the puzzle
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
    this.refreshRefLabel();
    this.setupVideo();
    await this.begin();
  }

  /** What the puzzle is made from, as the buttons say it. */
  private mediaWord(): 'Photo' | 'Video' {
    return this.entry?.video ? 'Video' : 'Photo';
  }

  /** The button for the original says what it shows: the photo or the video that the puzzle is cut from. */
  private refreshRefLabel(): void {
    const word = this.mediaWord();
    this.refBtn.textContent = `Show ${word}`;
    this.refBtn.title = `Look at the original ${word.toLowerCase()}`;
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
    this.setRange(null);
    this.rangeBar.hidden = true;
    this.refreshRestrict();
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
        this.keepInRange(v);
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

  /** Shows or hides the bar of the two dots above the timeline (the part that was chosen goes on being played when they are hidden). */
  private toggleRestrict(): void {
    this.rangeBar.hidden = !this.rangeBar.hidden;
    this.refreshRestrict();
  }

  private refreshRestrict(): void {
    this.restrictBtn.classList.toggle('on', !this.rangeBar.hidden || !!this.range);
    this.restrictBtn.setAttribute('aria-pressed', String(!this.rangeBar.hidden));
    this.vbar.classList.toggle('ranging', !this.rangeBar.hidden);
  }

  /** The dots have moved: the part of the video that is looped over is what lies between them (the whole video when they are at the ends). */
  private rangeFromDots(): void {
    const v = this.src?.video;
    const lo = Number((this.rangeLo as HTMLInputElement).value);
    const hi = Number((this.rangeHi as HTMLInputElement).value);
    const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
    this.range = dur > 0 && (lo > 0 || hi < 1000) ? { start: (lo / 1000) * dur, end: (hi / 1000) * dur } : null;
    this.paintRange();
  }

  /** Puts the dots where a range is (from the host, or none: the ends). */
  private setRange(r: VideoRange | null): void {
    const v = this.src?.video;
    const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
    const same = (!r && !this.range) || (!!r && !!this.range && Math.abs(r.start - this.range.start) < 0.01 && Math.abs(r.end - this.range.end) < 0.01);
    if (same) return;
    this.range = r && dur > 0 ? { start: Math.max(0, r.start), end: Math.min(dur, r.end) } : null;
    (this.rangeLo as HTMLInputElement).value = String(this.range && dur > 0 ? Math.round((this.range.start / dur) * 1000) : 0);
    (this.rangeHi as HTMLInputElement).value = String(this.range && dur > 0 ? Math.round((this.range.end / dur) * 1000) : 1000);
    this.paintRange();
  }

  private paintRange(): void {
    const lo = Number((this.rangeLo as HTMLInputElement).value);
    const hi = Number((this.rangeHi as HTMLInputElement).value);
    this.rangeFill.style.left = `${lo / 10}%`;
    this.rangeFill.style.width = `${Math.max(0, hi - lo) / 10}%`;
    this.refreshRestrict();
  }

  /** The video goes round the part that was chosen: at its end (or before its start) it goes back to the start of the part. */
  private keepInRange(v: HTMLVideoElement): void {
    const r = this.range;
    if (!r || !(v.duration > 0)) return;
    if (v.currentTime >= r.end || v.currentTime < r.start - 0.05) v.currentTime = r.start;
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
    const range = (): VideoRange | null => this.range;
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
        get range() {
          return range();
        },
        setRange: (r) => this.setRange(r),
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
    this.putAway.clear();
    const { prefs, saves } = this.deps;
    const kind = this.kind;
    this.loading = true;
    this.autosave.reset();
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
        traysChanged: () => this.refreshTrays(),
        progress: () => this.after(),
      });
    this.session?.dispose?.();
    cancelEffects();
    this.overlay?.remove();
    this.front?.remove();
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
    this.front = session.front ?? null;
    if (this.front) {
      this.front.className = 'board overlay';
      this.stage.insertBefore(this.front, this.dialogEl);
    }
    this.buildTabs();
    this.refreshTrays();
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
    this.arm(null);
    this.helpShown = '';
    this.refreshHelp();
    this.coachTick();
  }

  // ---------------------------------------------------------------------------------------------------------------- hints and bombs

  private helpButton(kind: HelpKind, label: string): HTMLButtonElement {
    // (the word goes on a narrow screen to save room: the icon says it, and so does the label that a screen reader reads)
    return h('button', { type: 'button', class: 'toggle', 'aria-pressed': 'false', 'aria-label': label, onclick: () => this.pressHelp(kind) }, svg(HELP_ICONS[kind], 'ico'), h('span', { class: 'label' }, label), h('span', { class: 'n' }, '0'));
  }

  /** A button of the header was pressed: chooses that one, or puts the choice away. */
  private pressHelp(kind: HelpKind): void {
    const a = this.deps.player?.summary();
    if (a && (kind === 'hint' ? a.hints : a.bombs) < 1) {                  // none left: the inventory says how to get more (and has the ad for them)
      this.deps.openHelp?.(kind);
      return;
    }
    this.arm(this.armed === kind ? null : kind);
  }

  /** Whether this puzzle has hints and bombs for this player to use: the puzzle has them (not Sliding Tiles, not Rotascope), the host of a puzzle played with friends allowed them, and this is a build with accounts. */
  private helpAvailable(): boolean {
    const p = this.deps.player;
    return !!this.session?.canHelp && !!p?.hasAccounts && !!this.deps.online && (!this.online || this.online.room.descriptor.helpers === true);
  }

  /** The two buttons show how many the player has, and are off when there are none or the puzzle is over. */
  private refreshHelp(): void {
    const p = this.deps.player;
    const available = this.helpAvailable();
    const a = p?.summary();
    const over = !!this.session?.solved;
    const ad = !!this.deps.helpAdReady?.();
    const key = available && a ? `${a.hints}|${a.bombs}|${over}|${ad}` : '';
    if (key === this.helpShown) return;
    this.helpShown = key;
    this.helpEl.hidden = !available;
    if (!available || !a) {
      this.arm(null);
      return;
    }
    const set = (kind: HelpKind, btn: HTMLButtonElement, n: number): void => {
      btn.querySelector('.n')!.textContent = String(n);
      btn.disabled = over;
      btn.classList.toggle('empty', n < 1);
      btn.classList.toggle('ad', ad && n < 1);                           // (none left and an ad for more can be watched: it glows)
      btn.title = n < 1 ? `You have no ${kind}s left. ${ad ? 'Press to watch an ad for more.' : 'Press to see how to get more.'}` : kind === 'hint' ? 'Place one piece where it belongs' : 'Place the pieces round a point you choose';
      if (btn.disabled && this.armed === kind) this.arm(null);
    };
    set('hint', this.hintBtn, a.hints);
    set('bomb', this.bombBtn, a.bombs);
  }

  /** Chooses a hint or a bomb (the next tap on the board uses it), or puts the choice away. */
  private arm(kind: HelpKind | null): void {
    this.armed = kind;
    this.helpTap = null;
    for (const [k, b] of [['hint', this.hintBtn], ['bomb', this.bombBtn]] as const) {
      b.classList.toggle('on', kind === k);
      b.setAttribute('aria-pressed', String(kind === k));
    }
    this.canvas.classList.toggle('helping', !!kind);
    this.canvas.classList.toggle('helping-hint', kind === 'hint');          // (the cursor is the hint's or the bomb's own: style.css)
    this.canvas.classList.toggle('helping-bomb', kind === 'bomb');
    this.instruct();
    this.coachTick();
  }

  /** The line over the board: what the chosen one will do, or nothing. */
  private instruct(): void {
    window.clearTimeout(this.noteTimer);
    const text = this.armed === 'hint' ? 'Choose the piece to place. Esc cancels.' : this.armed === 'bomb' ? 'Choose where to drop the bomb: it places the pieces round that point. Esc cancels.' : '';
    this.helpNote.textContent = text;
    this.helpNote.hidden = !text;
  }

  /** Says something over the board for a moment (why a hint or a bomb was not used), and then goes back to what was there. */
  private flash(text: string, ms = 2600): void {
    window.clearTimeout(this.noteTimer);
    this.helpNote.textContent = text;
    this.helpNote.hidden = false;
    this.noteTimer = window.setTimeout(() => this.instruct(), ms);
  }

  /** The tap that uses the chosen hint or bomb, at a board point. Played alone, the server takes it from the account first; played with friends, the room does that with the operation. */
  private async useHelp(p: { x: number; y: number }): Promise<void> {
    const kind = this.armed;
    const session = this.session;
    const player = this.deps.player;
    const api = this.deps.online?.api;
    if (!kind || !session?.canHelp || !session.help || !player || !api || this.helpBusy) return;
    if (!session.canHelp(kind, p)) {
      this.flash(kind === 'hint' ? 'There is no piece to place there.' : 'There is nothing to place round that point.');
      return;
    }
    const a = player.summary();
    if ((kind === 'hint' ? a.hints : a.bombs) < 1) {
      this.arm(null);
      return;
    }
    this.helpBusy = true;
    try {
      // the counter goes down at once. Played alone, the spend is kept and sent to the server when it can be (now, or when there is a connection again); with friends the room takes it
      // with the operation, and the cursor shows that the player waits for its answer, until it has come
      if (this.online) player.countDown(kind);
      else player.spend(kind);
      session.help(kind, p);
      this.deps.achievements?.record({ type: 'help', help: kind });
      this.deps.tutorial?.store.done(kind);
      this.arm(null);
      this.after();
      if (this.online) {
        window.setTimeout(() => void player.refreshProfile(), 1500);
        this.waitFor(this.online.room.whenSent());
      }
    } finally {
      this.helpBusy = false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- how to play, and the walk-through

  private openHowTo(): void {
    this.deps.tutorial?.store.seenHowto(this.kind.id);
    this.howtoOpen = true;
    this.coachTick();
    openHowTo(this.kind.id, () => {
      this.howtoOpen = false;
      this.coachTick();
    });
  }

  private hideTip(): void {
    const t = this.deps.tutorial;
    if (this.tipKey && t) t.coach.hide();
    if (t) t.step = null;
    this.tipKey = '';
  }

  /**
   * Lights the How To Play button of a type of puzzle that has never been opened, and points out what comes next to a player who is new (how to play, then a hint, then a bomb, then
   * an ad for more: `nextStep`) with a bubble. The bubble is not there while a window is open or the puzzle is over.
   */
  private coachTick(): void {
    const t = this.deps.tutorial;
    if (!t) return;
    const data = t.store.data;
    this.howBtn.classList.toggle('glow', howtoNew(data, this.kind.id));
    if (t.adDialog) return;                                              // (the inventory window has the bubble)
    const a = this.deps.player?.summary();
    const quiet = this.el.hidden || !this.session || this.session.solved || this.loading || this.howtoOpen || !this.dialogEl.hidden;
    // (a player who has put the bubble about How To Play away is taken for one who has seen it, for the rest of this puzzle)
    const seen = this.putAway.has('howto') ? { ...data, howto: [...data.howto, '*'] } : data;
    let step = quiet ? null : nextStep(seen, { helpers: this.helpAvailable(), hints: a?.hints ?? 0, bombs: a?.bombs ?? 0, adReady: !!this.deps.helpAdReady?.() });
    if (step && this.putAway.has(step)) step = null;
    const key = step ? `${step}|${this.armed ?? ''}` : '';
    t.step = step;
    if (key === this.tipKey) return;
    this.tipKey = key;
    if (!step) {
      t.coach.hide();
      return;
    }
    const away = (done?: 'hint' | 'bomb'): (() => void) => () => {
      if (done) t.store.done(done);
      this.putAway.add(step!);
      this.tipKey = '';
      this.coachTick();
    };
    switch (step) {
      case 'howto':
        t.coach.show({ target: () => this.howBtn, title: 'New here?', text: 'Press How To Play to see the controls and the rules of this puzzle.', dismiss: 'Got it', onDismiss: away() });
        break;
      case 'hint':
      case 'bomb': {
        const hint = step === 'hint';
        t.coach.show({
          target: () => (hint ? this.hintBtn : this.bombBtn),
          title: hint ? 'Hints' : 'Bombs',
          text:
            this.armed === step
              ? hint
                ? 'Now tap the piece you want placed. It goes straight to where it belongs.'
                : 'Now tap a spot on the board. Every piece around it goes where it belongs.'
              : hint
                ? 'Stuck? Press Hint, then tap a piece to put it in its place.'
                : 'Want to clear a whole area? Press Bomb, then tap a spot: the pieces around it go where they belong.',
          dismiss: 'Skip',
          onDismiss: away(step),
        });
        break;
      }
      case 'ad':
        t.coach.show({ target: () => this.invBtn ?? null, title: 'Need more?', text: 'Hints and bombs run out. Open the Inventory to watch a short ad for more.', dismiss: 'Not now', onDismiss: away() });
        break;
    }
  }

  /** The cursor over the board is a wait cursor until `done` (what the player did is being sent to the room and answered). */
  private waitFor(done: Promise<void>): void {
    this.waiting++;
    this.canvas.classList.add('waiting');
    void done.finally(() => {
      if (--this.waiting === 0) this.canvas.classList.remove('waiting');
    });
  }

  /** A puzzle that was played alone is solved: the server adds its hints. How many were given (none if it could not be told). */
  private async awardSolved(): Promise<number> {
    const { player, online, prefs } = this.deps;
    if (!player || !online || player.kind() !== 'account') return 0;
    const res = await online.api.awardSolved(optionsOf(prefs.data.settings, this.kind)[SIZE] ?? 0);
    if (!res.ok) return 0;
    player.setSummary(res.account);
    return res.given;
  }

  /**
   * What the end-of-puzzle window says about hints: what the puzzle gave (a free account stops at so many a day, and the window says how many it can still earn), that it has had all of today's, or
   * - to someone who is not signed in, who earns none - how to earn them.
   */
  private earnLines(given: number): HTMLElement[] {
    const { player, online } = this.deps;
    if (!player?.hasAccounts || !online) return [];
    const a = player.summary();
    if (a.type === 'guest') return [h('p', { class: 'best' }, 'Sign in to earn hints by solving puzzles.')];
    const plural = `${given} hint${given === 1 ? '' : 's'}`;
    if (given > 0) return [h('p', { class: 'best' }, `+${plural} earned${a.earnInfinite ? '' : a.earnLeft > 0 ? ` · ${a.earnLeft} more can be earned today` : ' · that is all you can earn today'}`)];
    if (!a.earnInfinite && a.earnLeft === 0) return [h('p', { class: 'best' }, `You have earned today's ${a.earnPerDay} hints. You can earn more tomorrow.`)];
    return [];
  }

  // ---------------------------------------------------------------------------------------------------------------- playing with friends

  /**
   * Plays a puzzle with friends: the picture comes from the server, the board is the room's, and what the player does goes to the room (see online/room.ts). The time shown is the
   * room's (only time with someone connected counts), for fun: there is no best time and nothing saved here, the server keeps the puzzle.
   */
  async startOnline(room: OnlineRoom, invite: Invite | null): Promise<void> {
    const token = ++this.token;
    this.beginRun++;
    const d = room.descriptor;
    this.kind = findKind(d.settings.kind) ?? findKind('jigsaw')!;
    this.titleEl.textContent = `${this.kind.name} · with friends`;
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
    this.entry = { id: room.id, name: 'Online puzzle', addedAt: Date.now(), thumbUrl: url, previewUrl: url, video: !!src.video, duration: src.video?.duration ?? 0 };
    this.src = src;
    this.refreshRefLabel();
    this.online = { room, shown: false, blob, saved: false };
    void this.refreshSaved();
    this.saveKey = '';
    // a video plays (with its sound, looped) and the board is drawn again for each new picture of it; where it is, is the host's to say
    const still = !!src.video && needsStill(this.kind.id);
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
      reserved: () => room.othersReserved().map((r) => ({ ...r, name: room.member(r.by)?.name ?? 'Someone' })),
      send: (op) => room.send(op),
      hand: (pose) => room.hand(pose),
      holding: (piece) => room.holding(piece),
      notify: (text) => bar.say(text),
      colorOf: (id) => PLAYER_COLORS[(room.member(id)?.color ?? 0) % PLAYER_COLORS.length],
      self: room.me,
    };
    this.session?.dispose?.();
    cancelEffects();
    this.overlay?.remove();
    this.front?.remove();
    this.session = startSession(this.kind.id, {
      source: this.frameCanvas ?? src.source,
      video: src.video ?? undefined,
      width: src.width,
      height: src.height,
      seed: d.settings.seed,
      opts: d.settings.opts,
      restore: onlineRestore(this.kind.id, d.state.game),
      flag: (key) => this.flag(key),
      requestDraw: () => this.requestDraw(),
      progress: () => this.after(),
      traysChanged: () => this.refreshTrays(),
      online: hooks,
    });
    this.mount(0, false);
    this.timeEl.hidden = false;
    const showTime = () => (this.timeEl.textContent = formatTime(room.playedMs()));
    showTime();
    this.clock = window.setInterval(showTime, 500);
    room.onChange = () => this.onlineChanged();
    room.onRefused = (error, holder) => {
      if (error === 'busy') bar.say(`${room.member(holder ?? '')?.name ?? 'Someone'} is moving a piece`);
      else if (error === 'no-group') bar.say('Someone moved that piece first');
      else if (error === 'no-credits') {
        bar.say('You have none of those left.');
        void this.deps.player?.refreshProfile();
      } else if (error === 'helpers-off') bar.say(sayError(error));
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
      src = await openVideo(url, blob);
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
    const d = o.room.descriptor;
    this.deps.achievements?.record({ type: 'solved', kind: this.kind.id, size: sizeIndexOf(this.kind, d.settings.opts), video: d.media.type === 'video', online: true, once: d.id });
    const player = this.deps.player;
    // the server gave the hints to everyone with an account (as many as each may earn today) before it said that the puzzle was solved: what this player was given is what their count grew by
    const before = player?.summary().hints ?? 0;
    const settled = player?.kind() === 'account' ? Promise.race([player.refreshProfile(), new Promise<void>((r) => window.setTimeout(r, 1500))]) : Promise.resolve();
    window.setTimeout(
      () =>
        void settled.then(() => {
          this.earned = Math.max(0, (player?.summary().hints ?? 0) - before);
          this.showOnlineDialog();
        }),
      700,
    );              // after the last move has finished showing
  }

  private showOnlineDialog(): void {
    if (!this.online) return;
    this.celebrate();
    this.dialogEl.replaceChildren(
      h('h2', {}, 'Solved!'),
      h('p', {}, `You finished it together in ${formatTime(this.online.room.playedMs())}.`),
      ...this.earnLines(this.earned),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', onclick: () => this.viewPicture() }, `View ${this.mediaWord()}`),
        (this.saveDialogBtn = h('button', { type: 'button', disabled: this.online.saved, title: this.online.saved ? 'This is in your library already' : '', onclick: () => void this.savePicture() }, this.online.room.descriptor.media.type === 'video' ? 'Save video' : 'Save picture')),
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

  /**
   * The id of this puzzle's picture in the player's own list, if it is there: as the picture the puzzle was made from, or (saved before, here or on another visit) the same file, which is one
   * picture and not two. The server keeps the picture for a while: a player who has it can make a puzzle of their own from it without sending it (they joined this one, which is what allows it).
   */
  private async libraryId(): Promise<string | null> {
    const o = this.online;
    if (!o) return null;
    const fileId = o.room.descriptor.media.fileId;
    const have = o.room.descriptor.media.sourceId;
    const id = have && (await this.deps.photos.entry(have)) ? have : await this.deps.photos.idOf(o.blob);
    if (id && fileId) await this.deps.photos.setServerFile(id, fileId);
    return id ?? null;
  }

  /** Greys out the buttons that keep the picture when it is in the player's library already. */
  private async refreshSaved(): Promise<void> {
    const o = this.online;
    if (!o) return;
    const saved = (await this.libraryId()) !== null;
    if (this.online !== o) return;                                      // (the player has left meanwhile)
    o.saved = saved;
    this.bar?.setSaved(saved);
    if (this.saveDialogBtn) {
      this.saveDialogBtn.disabled = saved;
      this.saveDialogBtn.title = saved ? 'This is in your library already' : '';
    }
  }

  /** Keeps the picture of the puzzle in the player's own list, unless it is there already. */
  private async savePicture(): Promise<void> {
    const o = this.online;
    if (!o) return;
    const fileId = o.room.descriptor.media.fileId;
    if (await this.libraryId()) {
      void this.refreshSaved();
      this.bar?.say('You already have this picture');
      return;
    }
    const video = o.room.descriptor.media.type === 'video';
    const type = o.blob.type || (video ? 'video/mp4' : 'image/jpeg');
    const ext = video ? ({ 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv' } as Record<string, string>)[type] ?? 'mp4' : type === 'image/png' ? 'png' : 'jpg';
    const done = await this.deps.photos.add([new File([o.blob], `Online puzzle.${ext}`, { type })], undefined, undefined, fileId);
    if (done.ids.length) {
      this.deps.photoAdded(done.ids[0]);
      this.bar?.say(video ? 'Saved to your library' : 'Saved to your pictures');
      void this.refreshSaved();
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
    this.autosave.touch();
  }

  /** Keeps the puzzle now if anything has happened since it was last kept (the page is hidden or closed, or the player leaves). */
  private saveNow(): void {
    this.autosave.flush();
  }

  /** Keeps the puzzle as it is (or, if it is solved, forgets it: there is nothing to carry on). */
  private keep(): void {
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

  /** A setting of the settings window (grid lines, animations...): on unless the player turned it off. */
  private flag(key: string): boolean {
    return generalValue(this.deps.prefs.data.settings, key) !== 0;
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

  /** Something in the settings window was changed: the puzzle looks at the settings again. */
  private settingsChanged(): void {
    this.session?.settingsChanged();
    this.requestDraw();
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
    this.arm(null);
    this.hideTip();
    const o = this.online;
    if (o) {
      o.room.detach();
      this.bar?.hide();
      // a puzzle that is over is not kept in the list; one that is not stays, and can be opened again
      if (o.room.solved || o.room.status === 'closed') void this.deps.online?.api.leave(o.room.id);
      this.online = null;
      this.timeEl.textContent = '0:00';
    }
    this.saveNow();
    this.token++;
    this.beginRun++;
    this.stopClock();
    this.closeSource();
    this.session?.dispose?.();
    cancelEffects();
    this.overlay?.remove();
    this.front?.remove();
    this.overlay = null;
    this.front = null;
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
    this.placeTray();
  }

  // ---------------------------------------------------------------------------------------------------------------- sorting trays

  /** The bar of trays at the left: a tray icon, a button for each tray (open ones lit, with how many pieces lie in it), and a plus to add one. Made again whenever the list changes. */
  private refreshTrays(): void {
    const s = this.session;
    const trays = s?.trays?.();
    this.trayBar.hidden = !trays;
    if (!s || !trays) {
      this.trayHead.hidden = true;
      return;
    }
    const icon = svg('<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3 13l3-7h12l3 7v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/></svg>', 'tico');
    icon.title = 'Sorting trays: put pieces in them to keep them out of the way';
    const buttons = trays.map((t, i) =>
      h(
        'button',
        { type: 'button', class: `tray${t.open ? ' on' : ''}`, 'aria-pressed': String(t.open), title: `${t.open ? 'Close' : 'Open'} tray ${i + 1}${t.pieces ? ` (${t.pieces} piece${t.pieces === 1 ? '' : 's'})` : ' (empty)'}`, onclick: () => this.openTray(t.id) },
        h('span', { class: 'tn' }, String(i + 1)),
        h('span', { class: 'tc' }, t.pieces ? String(t.pieces) : ''),
      ),
    );
    const add = h('button', { type: 'button', class: 'tray add', title: trays.length >= 10 ? 'There are as many trays as there can be' : 'Add a tray', 'aria-label': 'Add a tray', disabled: trays.length >= 10, onclick: () => this.addTray() }, '+');
    this.trayBar.replaceChildren(icon, ...buttons, add);
    this.placeTray();
  }

  private openTray(id: number): void {
    this.session?.openTray?.(id);
    this.after();
  }

  private addTray(): void {
    this.session?.addTray?.();
    this.after();
  }

  /** Puts the title and buttons of the open tray over its header (which the board's canvas leaves empty), or hides them when no tray is open. */
  private placeTray(): void {
    const s = this.session;
    const p = s?.trayPanel?.();
    if (!s || !p) {
      this.trayHead.hidden = true;
      return;
    }
    const index = (s.trays?.() ?? []).findIndex((t) => t.id === p.id);
    const st = this.trayHead.style;
    st.left = `${p.x}px`;
    st.top = `${p.y}px`;
    st.width = `${p.w}px`;
    st.height = `${p.header}px`;
    const title = `Tray ${index + 1} · ${p.pieces ? `${p.pieces} piece${p.pieces === 1 ? '' : 's'}` : 'empty'}`;
    if (this.trayHead.hidden || this.trayHead.dataset.title !== title) {
      this.trayHead.dataset.title = title;
      this.trayHead.replaceChildren(
        h('span', { class: 'tt' }, title),
        // a tray can be taken away only while nothing lies in it
        h('button', { type: 'button', class: 'small', hidden: p.pieces > 0, title: 'Take this empty tray away', onclick: () => this.removeTray(p.id) }, 'Remove tray'),
        h('button', { type: 'button', class: 'small', title: 'Close this tray', 'aria-label': 'Close this tray', onclick: () => this.openTray(p.id) }, '✕'),
      );
    }
    this.trayHead.hidden = false;
  }

  private removeTray(id: number): void {
    this.session?.removeTray?.(id);
    this.after();
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
        this.helpTap = null;
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
    if (this.armed) {                                           // a hint or a bomb is chosen: a tap uses it (a press that moves is not one: it is judged when it ends)
      this.helpTap = { x: e.clientX, y: e.clientY };
      return;
    }
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
    if (this.armed && e.pointerId === this.activePointer) {
      if (this.helpTap && Math.hypot(e.clientX - this.helpTap.x, e.clientY - this.helpTap.y) > 8) this.helpTap = null;
      return;
    }
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
    if (this.armed) {
      const tap = this.helpTap;
      this.helpTap = null;
      if (tap) void this.useHelp(this.boardPoint(e));
      return;
    }
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
    this.refreshHelp();
    this.coachTick();
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
    this.autosave.reset();
    void this.deps.saves.remove(this.saveKey);
    const { prefs } = this.deps;
    const key = recordKey(this.kind, entry.id, prefs.data.settings);
    prefs.recordTime(key, this.elapsed);                         // the best of this file (the main screen's list shows it)
    const size = sizeIndexOf(this.kind, optionsOf(prefs.data.settings, this.kind));
    const times = this.deps.bestTimes;
    const counts = countsForBestTimes(optionsOf(prefs.data.settings, this.kind));
    const isBest = (counts && times?.record(this.kind.id, size, { ms: this.elapsed, moves: this.session.moves?.(), file: entry.name, video: entry.video, at: Date.now() })) || false;
    const label = `${this.kind.name} ${sizeLabels(this.kind)[size]?.name ?? ''}`.trim();
    this.deps.achievements?.record({ type: 'solved', kind: this.kind.id, size, video: entry.video, online: false });
    const award = this.awardSolved();
    // after the last move has finished showing (and the server has said what the puzzle gave, if it does so quickly)
    window.setTimeout(() => void Promise.race([award, new Promise<number>((r) => window.setTimeout(() => r(0), 800))]).then((n) => this.showDialog(isBest, counts ? times?.get(this.kind.id, size)?.ms ?? this.elapsed : undefined, label, n)), 700);
  }

  private showDialog(isBest: boolean, best: number | undefined, label: string, earned = 0): void {
    if (!this.session) return;
    this.celebrate();
    this.dialogEl.replaceChildren(
      h('h2', {}, 'Solved!'),
      h('p', {}, `Time ${formatTime(this.elapsed)} · ${this.session.status()}`),
      h('p', { class: 'best' }, best === undefined ? 'Pieces were placed at the start, so this time does not count towards best times.' : isBest ? `New best time for ${label}!` : `Best ${label} time ${formatTime(best)}`),
      ...this.earnLines(earned),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', onclick: () => this.viewPicture() }, `View ${this.mediaWord()}`),
        h('button', { type: 'button', onclick: () => this.leave() }, 'Back To Main Screen'),
      ),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', class: 'primary', onclick: () => this.newPuzzle() }, 'New Puzzle (Same File)'),
        ...(this.entry && this.deps.otherPhoto(this.entry.id) ? [h('button', { type: 'button', title: 'The same settings on another file of your library', onclick: () => this.otherPhotoPuzzle() }, 'New Puzzle (Random Local File)')] : []),
      ),
    );
    this.dialogEl.hidden = false;
  }

  /** The end of a puzzle: the party blower and the confetti, as the dialog comes up. */
  private celebrate(): void {
    playEffect('solved');
    launchConfetti();
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
