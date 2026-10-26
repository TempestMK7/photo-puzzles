import { findKind, KINDS, optionValue, recordKey, type KindDef } from '../core/kinds';
import { randomSeedText } from '../core/rng';
import { isVideoFile } from '../image';
import { formatTime, type Prefs } from '../core/prefs';
import type { PhotoEntry, PhotoLibrary } from '../store/photos';
import { h, svg } from './dom';
import { KIND_ICONS } from './icons';

export interface LibraryDeps {
  prefs: Prefs;
  photos: PhotoLibrary;
  /** Start the chosen puzzle type on this photo. */
  onPlay(entry: PhotoEntry): void;
}

/** Resolves when the screen has been drawn (or soon anyway: a page in the background does not draw). */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      window.clearTimeout(t);
      resolve();
    });
  });

/**
 * The main screen: the puzzle types along the top, the list of photos on the left, the chosen photo in the middle and everything else (seed, difficulty,
 * adding photos, Play) on the right. Narrow screens stack the same parts.
 */
export class LibraryScreen {
  readonly el: HTMLElement;
  private entries: PhotoEntry[] = [];
  private kindsEl = h('nav', { class: 'kinds', 'aria-label': 'Puzzle types' });
  private listEl = h('ul', { class: 'plist', role: 'listbox', 'aria-label': 'Photos', tabIndex: 0 });
  private previewImg = h('img', { alt: '' });
  private previewVideo = h('video', { muted: true, loop: true, playsInline: true, autoplay: true, hidden: true, 'aria-label': 'Preview' });
  private nameEl = h('div', { class: 'pname' });
  private bestEl = h('div', { class: 'pbest' });
  private blurbEl = h('p', { class: 'blurb' });
  private optionsEl = h('div', { class: 'options' });
  private seedInput = h('input', { type: 'text', class: 'seed', maxLength: 12, spellcheck: false, 'aria-label': 'Seed' });
  private noteEl = h('div', { class: 'note', 'aria-live': 'polite' });
  private playBtn = h('button', { type: 'button', class: 'primary', onclick: () => this.play() }, 'Play');
  private footEl = h('div', { class: 'pfoot' });
  /** Taking photos out: not at all, choosing which ones, or asking whether to go ahead with the ones chosen. */
  private removing: 'no' | 'choose' | 'sure' = 'no';
  private marked = new Set<string>();
  private fileInput = h('input', { type: 'file', accept: 'image/*,video/*,.webm,.mp4,.m4v,.mov,.mkv', multiple: true, hidden: true, onchange: () => this.filesChosen() });
  private photoNoteEl = h('div', { class: 'note', 'aria-live': 'polite' });
  private noteTimers = new Map<HTMLElement, number>();
  /** Reading the list, adding and removing take turns. */
  private queue: Promise<void> = Promise.resolve();
  private loading = false;
  /** The pop-up over the screen while the first photo is being read. */
  private loadingEl = h('div', { class: 'loading', role: 'status', hidden: true }, h('div', { class: 'card' }, h('div', { class: 'spin', 'aria-hidden': 'true' }), h('div', {}, 'Loading your photos…')));

  constructor(private readonly deps: LibraryDeps) {
    const { prefs } = deps;
    this.seedInput.value = prefs.data.seed;
    this.seedInput.addEventListener('change', () => this.commitSeed());
    this.seedInput.addEventListener('input', () => {
      this.seedInput.value = this.seedInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    this.el = h(
      'section',
      { class: 'library' },
      h('header', { class: 'bar' }, h('h1', {}, 'Photo Puzzles')),
      this.kindsEl,
      h(
        'div',
        { class: 'main' },
        h('aside', { class: 'photos' }, this.listEl, this.photoNoteEl, this.footEl),
        h('section', { class: 'preview' }, h('div', { class: 'frame' }, this.previewImg, this.previewVideo), this.nameEl, this.bestEl, this.blurbEl),
        h(
          'aside',
          { class: 'side' },
          h('label', { class: 'field' }, h('span', {}, 'Seed'), this.seedInput),
          h(
            'div',
            { class: 'row' },
            h('button', { type: 'button', onclick: () => this.reroll() }, 'Reroll'),
            h('button', { type: 'button', onclick: () => void this.copySeed() }, 'Copy'),
          ),
          this.optionsEl,
          h('div', { class: 'spacer' }),
          this.noteEl,
          this.playBtn,
        ),
      ),
      this.fileInput,
      this.loadingEl,
    );
    this.listEl.addEventListener('keydown', (e) => this.listKey(e));
    this.buildKinds();
    this.renderFoot();
  }

  /**
   * Reads the photo list into the drawer one photo at a time, so it fills in as they come: a pop-up says that photos are loading until the first one is there, and the note
   * under the list counts the rest.
   */
  load(): Promise<void> {
    return this.queued(() => this.loadNow());
  }

  private async loadNow(): Promise<void> {
    this.loading = true;
    this.entries = [];
    this.listEl.replaceChildren();
    this.loadingEl.hidden = false;
    this.renderChosen();
    this.renderFoot();
    let sliceStart = performance.now();
    try {
      await this.deps.photos.each(async (e, done, total) => {
        this.entries.push(e);
        const li = this.itemFor(e);
        this.listEl.append(li);
        this.loadingEl.hidden = true;
        if (e.id === this.deps.prefs.data.photo) {
          li.scrollIntoView({ block: 'nearest' });
          this.renderChosen();
        }
        if (done < total) this.photoNote(`Loading photos: ${done} of ${total}`, true);
        if (done === 1 || performance.now() - sliceStart > 16) {         // let the screen draw what is there now, but not after every photo
          await nextFrame();
          sliceStart = performance.now();
        }
      });
    } finally {
      this.loading = false;
      this.loadingEl.hidden = true;
      this.photoNote('');
    }
    this.refresh();
  }

  private queued(run: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Shows the list as it is now (after adding / removing). */
  private refresh(selectId?: string): void {
    for (const id of [...this.marked]) if (!this.entries.some((e) => e.id === id)) this.marked.delete(id);
    if (selectId) this.deps.prefs.data.photo = selectId;
    if (!this.entries.some((e) => e.id === this.deps.prefs.data.photo)) this.deps.prefs.data.photo = this.entries[0]?.id ?? '';
    this.renderList();
    this.renderChosen();
    this.renderFoot();
  }

  /** Called when the screen is left: the preview video stops decoding while a puzzle plays. */
  hide(): void {
    this.previewVideo.pause();
  }

  /** Called when the screen comes back (a record may have changed). */
  show(): void {
    this.seedInput.value = this.deps.prefs.data.seed;
    this.renderList();
    this.renderChosen();
  }

  // ---------------------------------------------------------------------------------------------------------------- parts

  private get kind(): KindDef {
    return findKind(this.deps.prefs.data.kind) ?? KINDS[0];
  }

  private get chosen(): PhotoEntry | undefined {
    return this.entries.find((e) => e.id === this.deps.prefs.data.photo);
  }

  private buildKinds(): void {
    this.kindsEl.replaceChildren(
      ...KINDS.map((k) =>
        h(
          'button',
          {
            type: 'button',
            class: 'kind' + (k.id === this.kind.id ? ' on' : '') + (k.available ? '' : ' soon'),
            disabled: !k.available,
            title: k.available ? k.blurb : `${k.name}: coming soon`,
            'aria-pressed': k.id === this.kind.id,
            onclick: () => this.chooseKind(k),
          },
          svg(KIND_ICONS[k.id], 'icon'),
          h('span', { class: 'kname' }, k.name),
          k.available ? null : h('span', { class: 'badge' }, 'soon'),
        ),
      ),
    );
  }

  private chooseKind(k: KindDef): void {
    if (!k.available) return;
    this.deps.prefs.data.kind = k.id;
    this.deps.prefs.save();
    this.buildKinds();
    this.renderList();
    this.renderChosen();
  }

  private recordFor(entry: PhotoEntry): number | undefined {
    const { prefs } = this.deps;
    return prefs.bestTime(recordKey(this.kind, entry.id, prefs.data.settings));
  }

  private renderList(): void {
    this.listEl.classList.toggle('removing', this.removing !== 'no');
    this.listEl.replaceChildren(...this.entries.map((e) => this.itemFor(e)));
    this.listEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  private itemFor(e: PhotoEntry): HTMLElement {
    const best = this.recordFor(e);
    return h(
      'li',
      {
        class:
          'item' + (e.id === this.deps.prefs.data.photo ? ' on' : '') + (best !== undefined ? ' done' : '') + (e.video ? ' video' : '') + (e.sample ? ' sample' : '') + (this.marked.has(e.id) ? ' marked' : ''),
        role: 'option',
        'aria-selected': e.id === this.deps.prefs.data.photo,
        dataset: { id: e.id },
        onclick: () => (this.removing === 'no' ? this.choosePhoto(e.id) : this.mark(e)),
        ondblclick: () => (this.removing === 'no' ? this.play() : undefined),
      },
      h('span', { class: 'chk', 'aria-hidden': 'true' }),
      h('img', { src: e.thumbUrl, alt: '', width: 56, height: 56, loading: 'lazy' }),
      h('span', { class: 'txt' }, h('span', { class: 'n' }, e.name), h('span', { class: 'b' }, (e.video ? `Video ${formatTime(e.duration * 1000)} · ` : '') + (best !== undefined ? `Best ${formatTime(best)}` : 'Not solved'))),
    );
  }

  private renderChosen(): void {
    const e = this.chosen;
    const { prefs } = this.deps;
    if (e?.video) {                                                // a video plays (silently, looped) in the preview
      this.previewImg.hidden = true;
      if (this.previewVideo.dataset.url !== e.previewUrl) {
        this.previewVideo.dataset.url = e.previewUrl;
        this.previewVideo.src = e.previewUrl;
      }
      this.previewVideo.hidden = false;
      void this.previewVideo.play().catch(() => undefined);
    } else {
      this.previewVideo.pause();
      this.previewVideo.hidden = true;
      if (this.previewVideo.dataset.url) {
        delete this.previewVideo.dataset.url;
        this.previewVideo.removeAttribute('src');
        this.previewVideo.load();
      }
      this.previewImg.src = e?.previewUrl ?? '';
      this.previewImg.hidden = !e;
    }
    this.nameEl.textContent = e?.name ?? (this.loading ? 'Loading photos…' : 'No photos yet');
    const best = e ? this.recordFor(e) : undefined;
    this.bestEl.textContent = e ? (best !== undefined ? `Best time ${formatTime(best)}` : 'Not solved yet') : '';
    this.blurbEl.textContent = this.kind.blurb;
    this.playBtn.disabled = !e;
    this.optionsEl.replaceChildren(
      ...this.kind.options.map((o) => {
        const v = optionValue(prefs.data.settings, this.kind.id, o);
        const key = `${this.kind.id}.${o.key}`;
        if (o.toggle) {
          return h(
            'label',
            { class: 'field check' },
            h('input', {
              type: 'checkbox',
              checked: v !== 0,
              onchange: (ev: Event) => this.setOption(key, (ev.target as HTMLInputElement).checked ? 1 : 0),
            }),
            h('span', {}, o.label),
          );
        }
        if (o.choices) {
          return h(
            'label',
            { class: 'field' },
            h('span', {}, o.label),
            h(
              'select',
              { onchange: (ev: Event) => this.setOption(key, Number((ev.target as HTMLSelectElement).value)) },
              ...o.choices.map((name, i) => h('option', { value: String(i), selected: i === v }, name)),
            ),
          );
        }
        const out = h('output', {}, String(v));
        return h(
          'label',
          { class: 'field' },
          h('span', {}, o.label, ' ', out),
          h('input', {
            type: 'range',
            min: o.min,
            max: o.max,
            step: o.step ?? 1,
            value: v,
            oninput: (ev: Event) => (out.value = (ev.target as HTMLInputElement).value),
            onchange: (ev: Event) => this.setOption(key, Number((ev.target as HTMLInputElement).value)),
          }),
        );
      }),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------- actions

  /** Ticks or unticks a photo that is to be removed (the sample pictures stay). */
  private mark(e: PhotoEntry): void {
    if (e.sample || this.removing !== 'choose') return;
    if (this.marked.has(e.id)) this.marked.delete(e.id);
    else this.marked.add(e.id);
    this.listEl.querySelectorAll<HTMLElement>('.item').forEach((li) => li.classList.toggle('marked', this.marked.has(li.dataset.id ?? '')));
    this.renderFoot();
  }

  private choosePhoto(id: string): void {
    this.deps.prefs.data.photo = id;
    this.deps.prefs.save();
    this.listEl.querySelectorAll('.item').forEach((li) => li.classList.toggle('on', (li as HTMLElement).dataset.id === id));
    this.renderChosen();
  }

  private listKey(e: KeyboardEvent): void {
    const i = this.entries.findIndex((x) => x.id === this.deps.prefs.data.photo);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = this.entries[Math.min(this.entries.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        this.choosePhoto(next.id);
        this.listEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter' && this.removing === 'no') {
      e.preventDefault();
      this.play();
    }
  }

  private setOption(key: string, value: number): void {
    this.deps.prefs.data.settings[key] = value;
    this.deps.prefs.save();
    this.renderList();        // the records belong to a difficulty
    this.renderChosen();
  }

  private commitSeed(): void {
    const v = this.seedInput.value.trim();
    if (v) this.deps.prefs.data.seed = v;
    else this.seedInput.value = this.deps.prefs.data.seed;
    this.deps.prefs.save();
  }

  private reroll(): void {
    this.deps.prefs.data.seed = randomSeedText();
    this.seedInput.value = this.deps.prefs.data.seed;
    this.deps.prefs.save();
  }

  private async copySeed(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.deps.prefs.data.seed);
      this.note('Seed copied');
    } catch {
      this.note('Could not copy');
    }
  }

  private play(): void {
    const e = this.chosen;
    if (!e) return;
    this.commitSeed();
    this.deps.onPlay(e);
  }

  private filesChosen(): void {
    const files = [...(this.fileInput.files ?? [])];
    this.fileInput.value = '';
    void this.addFiles(files);
  }

  /** Adds picture files (from the button or dropped on the page) and chooses the last one. Files given while others are still being added wait their turn. */
  addFiles(files: File[]): Promise<void> {
    return this.queued(() => this.addNow(files));
  }

  private async addNow(files: File[]): Promise<void> {
    const pictures = files.filter((f) => f.type.startsWith('image/') || isVideoFile(f) || !f.type);       // no type at all: some pickers give none, so try it
    if (!pictures.length) {
      if (files.length) this.photoNote('Those are not pictures or videos');
      return;
    }
    const ids: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < pictures.length; i++) {
      // the note stays up for as long as the work goes on (a long video, or many files), and each one appears in the list the moment it is ready
      this.photoNote(pictures.length === 1 ? 'Adding…' : `Adding ${i + 1} of ${pictures.length}…`, true);
      const done = await this.deps.photos.add([pictures[i]], (text) => this.photoNote(text, true));
      ids.push(...done.ids);
      failed.push(...done.failed);
      if (done.ids.length) {
        const id = done.ids[done.ids.length - 1];
        const added = await this.deps.photos.entry(id);
        if (added && !this.entries.some((x) => x.id === id)) this.entries.push(added);           // the newest goes last
        this.refresh(id);
      }
    }
    this.photoNote(failed.length ? `Could not open ${failed.join('; ')}` : ids.length === 1 ? 'Added 1 photo' : `Added ${ids.length} photos`);
  }

  // ---------------------------------------------------------------------------------------------------------------- the buttons under the list

  private setRemoving(mode: 'no' | 'choose' | 'sure'): void {
    const wasNo = this.removing === 'no';
    this.removing = mode;
    if (mode === 'no') this.marked.clear();
    if (wasNo !== (mode === 'no')) this.renderList();
    this.renderFoot();
  }

  /** Add / Remove at the bottom of the photo panel. Remove is a mode: tick the photos to go, then confirm (an in-page question: a web view may swallow confirm()). */
  private renderFoot(): void {
    const mine = this.entries.filter((e) => !e.sample);
    const n = this.marked.size;
    const btn = (label: string, onclick: () => void, extra: Record<string, unknown> = {}) => h('button', { type: 'button', onclick, ...extra }, label);
    if (this.removing === 'no') {
      this.footEl.replaceChildren(
        btn('Add photos…', () => this.fileInput.click()),
        btn('Remove photos', () => this.setRemoving('choose'), { disabled: mine.length === 0, title: mine.length ? 'Choose photos and videos to remove' : 'Only the sample pictures are here' }),
      );
    } else if (this.removing === 'choose') {
      this.footEl.replaceChildren(
        h('div', { class: 'msg' }, n ? `${n} selected` : 'Tap the photos to remove'),
        btn('Cancel', () => this.setRemoving('no')),
        btn(n === mine.length ? 'None' : 'All', () => {
          if (n === mine.length) this.marked.clear();
          else for (const e of mine) this.marked.add(e.id);
          this.renderList();
          this.renderFoot();
        }),
        btn(n ? `Remove ${n}` : 'Remove', () => this.setRemoving('sure'), { class: 'danger', disabled: n === 0 }),
      );
    } else {
      this.footEl.replaceChildren(
        h('div', { class: 'msg' }, n === 1 ? 'Remove 1 photo and its saved puzzles?' : `Remove ${n} photos and their saved puzzles?`),
        btn('Keep them', () => this.setRemoving('choose')),
        btn('Remove', () => void this.removeMarked(), { class: 'danger' }),
      );
    }
  }

  private removeMarked(): Promise<void> {
    return this.queued(() => this.removeNow());
  }

  private async removeNow(): Promise<void> {
    const ids = [...this.marked].filter((id) => this.entries.some((e) => e.id === id && !e.sample));
    for (const id of ids) await this.deps.photos.remove(id);
    this.entries = this.entries.filter((e) => !ids.includes(e.id));
    this.removing = 'no';
    this.marked.clear();
    this.refresh();
    this.photoNote(ids.length === 1 ? 'Removed 1 photo' : `Removed ${ids.length} photos`);
  }

  /** Shows a message; it goes away by itself, unless it says that something is still going on. */
  private note(text: string, busy = false, el: HTMLElement = this.noteEl): void {
    el.textContent = text;
    window.clearTimeout(this.noteTimers.get(el));
    if (!busy) this.noteTimers.set(el, window.setTimeout(() => (el.textContent = ''), 3000));
  }

  /** The same, in the photo panel above its buttons. */
  private photoNote(text: string, busy = false): void {
    this.note(text, busy, this.photoNoteEl);
  }
}
