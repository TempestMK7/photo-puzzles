import { FocusGame } from '../core/focus';
import { findKind, optionsOf, puzzleSeedText, recordKey } from '../core/kinds';
import { formatTime, type Prefs } from '../core/prefs';
import { randomSeedText, seedFromText } from '../core/rng';
import { draw, fitView, type Anim, type View } from '../render';
import type { PhotoEntry, PhotoLibrary, PlaySource } from '../store/photos';
import { h } from './dom';

export interface PlayDeps {
  prefs: Prefs;
  photos: PhotoLibrary;
  /** Back to the main screen. */
  onExit(): void;
}

/** The screen where a puzzle is played (Focus Point for now). */
export class PlayScreen {
  readonly el: HTMLElement;
  private canvas = h('canvas', { class: 'board' });
  private ctx = this.canvas.getContext('2d')!;
  private titleEl = h('div', { class: 'title' });
  private timeEl = h('span', { class: 'time' }, '0:00');
  private swapsEl = h('span', { class: 'swaps' }, '0 swaps');
  private dialogEl = h('div', { class: 'dialog', hidden: true });
  private viewBar = h('div', { class: 'viewbar', hidden: true });
  // the playback bar of a video puzzle: pause / play, the time, a draggable position, the length, sound on / off
  private pauseBtn = h('button', { type: 'button', class: 'icon', title: 'Pause', 'aria-label': 'Pause', onclick: () => this.togglePause() }, '❚❚');
  private curEl = h('span', { class: 'vt' }, '0:00');
  private totalEl = h('span', { class: 'vt' }, '0:00');
  private seekEl = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Video position' });
  private muteBtn = h('button', { type: 'button', class: 'icon', title: 'Sound', 'aria-label': 'Sound', onclick: () => this.toggleMute() });
  private vbar = h('div', { class: 'vbar', hidden: true }, this.pauseBtn, this.curEl, this.seekEl, this.totalEl, this.muteBtn);
  private stage = h('div', { class: 'stage' }, this.canvas, this.dialogEl, this.viewBar);
  private main = h('main', {}, this.stage, this.vbar);

  private entry: PhotoEntry | null = null;
  private src: PlaySource | null = null;
  private seeking = false;
  private pumpToken = 0;
  private game: FocusGame | null = null;
  private view: View = { scale: 1, ox: 0, oy: 0 };
  private anims = new Map<number, Anim>();
  private hover = -1;
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
        h('div', { class: 'stats' }, this.timeEl, this.swapsEl),
        h('button', { type: 'button', onclick: () => this.restart() }, 'Restart'),
      ),
      this.main,
    );
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || !this.game) return;
      const p = this.pieceAt(e);
      if (p !== this.hover) {
        this.hover = p;
        this.requestDraw();
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.requestDraw();
    });
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
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
      if (e.key === 'Escape' && !this.el.hidden) this.leave();
    });
  }

  /** Starts a puzzle of the saved type, difficulty and seed on this photo. */
  async start(entry: PhotoEntry): Promise<void> {
    const token = ++this.token;
    this.entry = entry;
    this.titleEl.textContent = `${findKind('focus')!.name} · ${entry.name}`;
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
    const kind = findKind('focus')!;
    const opts = optionsOf(prefs.data.settings, kind);
    this.game = new FocusGame(this.src.width, this.src.height, {
      seed: seedFromText(puzzleSeedText(prefs.data.seed, this.entry.id, kind.id)),
      pieces: opts.pieces,
      irregular: opts.irregular === 1,
    });
    this.anims.clear();
    this.hover = -1;
    this.dialogEl.hidden = true;
    this.viewBar.hidden = true;
    this.elapsed = 0;
    this.startedAt = performance.now();
    this.running = true;
    window.clearInterval(this.clock);
    this.clock = window.setInterval(() => this.tick(), 250);
    this.tick();
    this.resize();
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
    this.game = null;
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
    if (!this.src) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = w;
      this.canvas.height = hgt;
    }
    this.view = fitView(this.src.width, this.src.height, w, hgt, 12 * dpr);
    this.requestDraw();
  }

  private requestDraw(): void {
    if (!this.frame) this.frame = requestAnimationFrame((now) => this.render(now));
  }

  private render(now: number): void {
    this.frame = 0;
    if (!this.game || !this.src) return;
    if (draw(this.ctx, this.src.source, this.game, this.view, this.anims, this.hover, now)) this.requestDraw();
  }

  private pieceAt(e: PointerEvent): number {
    if (!this.game) return -1;
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    const x = ((e.clientX - r.left) * dpr - this.view.ox) / this.view.scale;
    const y = ((e.clientY - r.top) * dpr - this.view.oy) / this.view.scale;
    return this.game.pieceAt(x, y);
  }

  private pointerDown(e: PointerEvent): void {
    const game = this.game;
    if (!game || !this.dialogEl.hidden) return;
    const p = this.pieceAt(e);
    if (p < 0) return;
    const before = game.slotOf.map((_, i) => game.slotRect(i));
    const what = game.click(p);
    if (what === 'swap') {
      const now = performance.now();
      for (let i = 0; i < game.count; i++) {
        const to = game.slotRect(i);
        if (to !== before[i]) this.anims.set(i, { from: before[i], to, start: now });
      }
      this.swapsEl.textContent = `${game.swaps} ${game.swaps === 1 ? 'swap' : 'swaps'}`;
      if (game.solved) this.finish();
    }
    this.requestDraw();
  }

  // ---------------------------------------------------------------------------------------------------------------- the end

  private finish(): void {
    const game = this.game;
    const entry = this.entry;
    if (!game || !entry) return;
    this.elapsed = performance.now() - this.startedAt;
    this.stopClock();
    this.tick();
    const { prefs } = this.deps;
    const key = recordKey(findKind('focus')!, entry.id, prefs.data.settings);
    const isBest = prefs.recordTime(key, this.elapsed);
    window.setTimeout(() => this.showDialog(isBest, prefs.bestTime(key) ?? this.elapsed), 450);     // after the last swap has finished moving
  }

  private showDialog(isBest: boolean, best: number): void {
    const game = this.game;
    if (!game) return;
    this.dialogEl.replaceChildren(
      h('h2', {}, 'Solved!'),
      h('p', {}, `Time ${formatTime(this.elapsed)} · ${game.swaps} ${game.swaps === 1 ? 'swap' : 'swaps'}`),
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
