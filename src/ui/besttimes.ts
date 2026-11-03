import { sizeLabels } from '../core/besttimes';
import { KINDS, type KindId } from '../core/kinds';
import { formatTime } from '../core/prefs';
import type { BestTimeStore } from '../store/besttimes';
import { h, svg } from './dom';
import { KIND_ICONS } from './icons';

const CLOCK =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>';

/** The best times on the screen: a button (for the top bar) and the dialog it opens, with a tab for each kind of puzzle and, under it, a line for each of its sizes. What is kept is `BestTimeStore`'s. */
export class BestTimesUi {
  readonly dialog: HTMLElement;
  private readonly tabs = h('div', { class: 'tabs', role: 'tablist' });
  private readonly list = h('div', { class: 'body besttimes', role: 'tabpanel' });
  private kind: KindId = KINDS.find((k) => k.available)!.id;

  constructor(private readonly store: BestTimeStore) {
    this.dialog = h(
      'div',
      { class: 'inprogress besttimes-dialog', role: 'dialog', 'aria-label': 'Best times', hidden: true, onclick: (e: Event) => (e.target === this.dialog ? this.close() : undefined) },
      h('div', { class: 'card' }, h('header', {}, h('h2', {}, 'Best Times'), h('button', { type: 'button', onclick: () => this.close() }, 'Close')), this.tabs, this.list),
    );
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !this.dialog.hidden && this.close());
  }

  /** A button that opens the dialog. */
  button(): HTMLButtonElement {
    return h('button', { type: 'button', class: 'inventory-btn besttimes-btn', title: 'Best times', onclick: () => this.show() }, svg(CLOCK, 'ico'), h('span', { class: 'label' }, 'Best Times'));
  }

  /** Opens the dialog, at the tab of `kind` when it says one. */
  show(kind?: KindId): void {
    if (kind) this.kind = kind;
    this.draw();
    this.dialog.hidden = false;
    this.dialog.querySelector<HTMLElement>('button')?.focus();
  }

  close(): void {
    this.dialog.hidden = true;
  }

  private choose(kind: KindId): void {
    this.kind = kind;
    this.draw();
  }

  private draw(): void {
    this.tabs.replaceChildren(
      ...KINDS.filter((k) => k.available).map((k) =>
        h('button', { type: 'button', class: 'tab' + (k.id === this.kind ? ' on' : ''), role: 'tab', 'aria-selected': k.id === this.kind, title: k.name, 'aria-label': k.name, onclick: () => this.choose(k.id) }, svg(KIND_ICONS[k.id], 'icon')),
      ),
    );
    const kind = KINDS.find((k) => k.id === this.kind)!;
    this.list.replaceChildren(
      h('p', { class: 'dim' }, `${kind.name}: the fastest time for each size, whatever file it was solved with.`),
      ...sizeLabels(kind).map((s, i) => {
        const best = this.store.get(kind.id, i);
        return h(
          'div',
          { class: 'bt' + (best ? ' done' : '') },
          h('span', { class: 'size' }, s.name),
          h(
            'span',
            { class: 'txt' },
            h('span', { class: 'dim' }, s.detail),
            best ? h('b', {}, formatTime(best.ms), best.moves !== undefined ? ` · ${best.moves} ${best.moves === 1 ? 'move' : 'moves'}` : '') : h('span', { class: 'dim' }, 'No time yet'),
            ...(best ? [h('span', { class: 'dim' }, `${best.video ? 'Video' : 'Photo'} “${best.file}” · ${new Date(best.at).toLocaleDateString()}`)] : []),
          ),
        );
      }),
    );
  }
}
