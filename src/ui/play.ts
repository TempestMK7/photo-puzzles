import { findKind, optionsOf, puzzleSeedText, recordKey, type KindDef } from '../core/kinds';
import { formatTime, type Prefs } from '../core/prefs';
import { randomSeedText, seedFromText } from '../core/rng';
import { fitView, type View } from '../render';
import { startSession, type PuzzleSession } from '../sessions';
import type { PhotoEntry, PhotoLibrary, PlaySource } from '../store/photos';
import { h } from './dom';

export interface PlayDeps {
  prefs: Prefs;
  photos: PhotoLibrary;
  /** Back to the main screen. */
  onExit(): void;
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
  private vbar = h('div', { class: 'vbar', hidden: true }, this.pauseBtn, this.curEl, this.seekEl, this.totalEl, this.muteBtn);
  // the zoom control of a board with a camera (Jigsaw), bottom right
  private zoomLabel = h('button', { type: 'button', class: 'zlabel', title: 'Show everything', 'aria-label': 'Show everything', onclick: () => this.zoomFit() }, '100%');
  private zoomEl = h(
    'div',
    { class: 'zoom', hidden: true },
    h('button', { type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.4) }, '−'),
    this.zoomLabel,
    h('button', { type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.4) }, '+'),
  );
  private stage = h('div', { class: 'stage' }, this.canvas, this.dialogEl, this.viewBar, this.zoomEl);
  private main = h('main', {}, this.tabsEl, this.stage, this.vbar);

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
  private startedAt = 0;
  private elapsed = 0;
  private running = false;
  private clock = 0;
  private token = 0;                // a start that was overtaken by another is dropped

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
        this.rotateBtn,
        h('button', { type: 'button', onclick: () => this.restart() }, 'Restart'),
      ),
      this.main,
    );
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
    this.seekEl.addEventListener('input', () => {
      const v = this.src?.video;
      if (v && Number.isFinite(v.duration)) {
        v.currentTime = (Number(this.seekEl.value) / 1000) * v.duration;
        this.updateBar();
      }
    });
    const endSeek = () => (this.seeking = false);
    this.seekEl.addEventListener('pointerup', endSeek);
    this.seekEl.addEventListener('pointercancel', endSeek);
    this.seekEl.addEventListener('change', endSeek);
    window.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') this.leave();
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
    this.begin();
  }

  private closeSource(): void {
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
    void v.play().catch(() => {
      v.muted = true;                              // the browser refused to start it with sound: start without
      this.refreshMute();
      void v.play().catch(() => undefined);
    });
    const token = ++this.pumpToken;
    const pump = (): void => {
      if (token !== this.pumpToken) return;
      const again = (): void => {
        this.requestDraw();
        this.updateBar();
        pump();
      };
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(again);
      else requestAnimationFrame(again);
    };
    pump();
  }

  private togglePause(): void {
    const v = this.src?.video;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
    this.pauseBtn.textContent = v.paused ? '\u25b6' : '❚❚';
    this.pauseBtn.title = v.paused ? 'Play' : 'Pause';
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

  /** The same photo again with the saved seed (Restart) - or with a fresh one (New puzzle). */
  private begin(): void {
    if (!this.entry || !this.src) return;
    const { prefs } = this.deps;
    const kind = this.kind;
    this.session = startSession(kind.id, {
      source: this.src.source,
      width: this.src.width,
      height: this.src.height,
      seed: seedFromText(puzzleSeedText(prefs.data.seed, this.entry.id, kind.id)),
      opts: optionsOf(prefs.data.settings, kind),
      flag: (key) => this.flag(key),
      requestDraw: () => this.requestDraw(),
      tabsChanged: () => this.refreshTabs(),
      progress: () => this.after(),
    });
    this.buildToggles();
    this.buildTabs();
    this.rotateBtn.hidden = !this.session.rotatable;
    this.zoomEl.hidden = !this.session.zoomBy;
    this.touches.clear();
    this.rightPointer = -1;
    if (this.session.stillSource && this.src.video) {          // the pieces were cut from this picture: the video stops here
      this.pumpToken++;
      this.src.video.pause();
      this.vbar.hidden = true;
    }
    this.dialogEl.hidden = true;
    this.viewBar.hidden = true;
    this.elapsed = 0;
    this.startedAt = performance.now();
    this.running = true;
    window.clearInterval(this.clock);
    this.clock = window.setInterval(() => this.tick(), 250);
    this.tick();
    this.statusEl.textContent = this.session.status();
    this.resize();
    if (this.session.zoomLabel) this.zoomLabel.textContent = this.session.zoomLabel();
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
    this.begin();
  }

  private newPuzzle(): void {
    this.deps.prefs.data.seed = randomSeedText();
    this.deps.prefs.save();
    this.begin();
  }

  private leave(): void {
    this.token++;
    this.stopClock();
    this.closeSource();
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

  private render(now: number): void {
    this.frame = 0;
    if (!this.session || !this.src) return;
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
    if (e.pointerType === 'touch' && session.pinch) {          // a second finger zooms (and moves) a board with a camera
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
    session.pointerDown(this.boardPoint(e));
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
    if (session.solved && this.running) this.finish();
    this.requestDraw();
  }

  // ---------------------------------------------------------------------------------------------------------------- the end

  private finish(): void {
    const entry = this.entry;
    if (!this.session || !entry) return;
    this.elapsed = performance.now() - this.startedAt;
    this.stopClock();
    this.tick();
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
