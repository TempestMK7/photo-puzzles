import { ACHIEVEMENTS, progressOf, type AchievementDef } from '../core/achievements';
import type { AchievementStore } from '../store/achievements';
import { h, svg } from './dom';

const TROPHY =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v2a3 3 0 0 0 3 3"/><path d="M17 6h3v2a3 3 0 0 1-3 3"/><path d="M12 14v4"/><path d="M8 20h8"/></svg>';

/** How long a pop-up about an unlock stays. */
const TOAST_MS = 4500;

/**
 * The achievements on the screen: a button (for the main screen) and the dialog it opens, with the list, and the pop-up that tells the player about an unlock wherever they are in the
 * game. What is unlocked is `AchievementStore`'s.
 */
export class AchievementsUi {
  /** The dialog and the pop-up (put them in the page once). */
  readonly dialog: HTMLElement;
  readonly toast: HTMLElement;
  private readonly body = h('div', { class: 'body achievements' });
  private open = false;
  private toastTimer = 0;
  private queue: AchievementDef[] = [];

  constructor(private readonly store: AchievementStore) {
    this.dialog = h(
      'div',
      { class: 'inprogress achievements-dialog', role: 'dialog', 'aria-label': 'Achievements', hidden: true, onclick: (e: Event) => (e.target === this.dialog ? this.close() : undefined) },
      h('div', { class: 'card' }, h('header', {}, h('h2', {}, 'Achievements'), h('button', { type: 'button', onclick: () => this.close() }, 'Close')), this.body),
    );
    this.toast = h('div', { class: 'achievement-toast', role: 'status', hidden: true });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.open && this.close());
    store.onUnlock((list) => {
      this.queue.push(...list);
      if (!this.toastTimer) this.next();
      if (this.open) this.draw();
    });
  }

  /** A button that opens the list. */
  button(): HTMLButtonElement {
    return h('button', { type: 'button', class: 'inventory-btn achievements-btn', title: 'Achievements', onclick: () => this.show() }, svg(TROPHY, 'ico'), h('span', { class: 'label' }, 'Achievements'));
  }

  show(): void {
    this.open = true;
    this.draw();
    this.dialog.hidden = false;
    this.dialog.querySelector<HTMLElement>('button')?.focus();
  }

  close(): void {
    this.open = false;
    this.dialog.hidden = true;
  }

  /** The pop-ups one after another. */
  private next(): void {
    const a = this.queue.shift();
    if (!a) {
      this.toastTimer = 0;
      this.toast.hidden = true;
      return;
    }
    this.toast.replaceChildren(svg(TROPHY, 'ico'), h('span', {}, h('b', {}, 'Achievement unlocked'), h('br', {}), a.name));
    this.toast.hidden = false;
    this.toastTimer = window.setTimeout(() => this.next(), TOAST_MS);
  }

  private draw(): void {
    const { state } = this.store;
    const got = ACHIEVEMENTS.filter((a) => this.store.isUnlocked(a.id)).length;
    this.body.replaceChildren(
      h('p', { class: 'dim' }, `${got} of ${ACHIEVEMENTS.length} unlocked`),
      ...ACHIEVEMENTS.map((a) => {
        const done = this.store.isUnlocked(a.id);
        const p = progressOf(state, a);
        return h(
          'div',
          { class: 'ach' + (done ? ' done' : '') },
          h('span', { class: 'mark', 'aria-hidden': 'true' }, done ? '✓' : ''),
          h('span', { class: 'txt' }, h('b', {}, a.name), h('span', { class: 'dim' }, a.description)),
          ...(p && p.target > 1 && !done ? [h('span', { class: 'dim count' }, `${p.current} / ${p.target}`)] : []),
        );
      }),
    );
  }
}
