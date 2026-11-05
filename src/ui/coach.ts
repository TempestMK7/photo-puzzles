import { h } from './dom';

/** What the bubble says, and the thing it points at (looked for again each time, because a screen may rebuild its buttons). */
export interface Tip {
  target: () => HTMLElement | null;
  text: string;
  title?: string;
  /** The label of the button that puts the bubble away (there is none when this is left out: pressing what it points at does that). */
  dismiss?: string;
  onDismiss?: () => void;
}

/**
 * A bubble with an arrow that points at a button, to walk the player through something. One at a time; it follows its target (a window may be resized or scrolled) and is
 * hidden while the target is not on the screen. The target pulses.
 */
export class Coach {
  private readonly el = h('div', { class: 'coach', role: 'status', hidden: true });
  private tip: Tip | null = null;
  private marked: HTMLElement | null = null;
  private timer = 0;

  /** The tip that is showing, if any. */
  get current(): Tip | null {
    return this.tip;
  }

  show(tip: Tip): void {
    this.tip = tip;
    if (!this.el.isConnected) document.body.append(this.el);
    this.el.replaceChildren(
      h('span', { class: 'arrow' }),
      ...(tip.title ? [h('strong', {}, tip.title)] : []),
      h('p', {}, tip.text),
      ...(tip.dismiss ? [h('button', { type: 'button', class: 'small', onclick: () => this.dismiss() }, tip.dismiss)] : []),
    );
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.place(), 250);
    this.place();
  }

  /** Puts the bubble away without telling anyone (what it pointed at was pressed, say). */
  hide(): void {
    this.tip = null;
    window.clearInterval(this.timer);
    this.el.hidden = true;
    this.mark(null);
  }

  private dismiss(): void {
    const done = this.tip?.onDismiss;
    this.hide();
    done?.();
  }

  private mark(el: HTMLElement | null): void {
    if (this.marked === el) return;
    this.marked?.classList.remove('coach-target');
    el?.classList.add('coach-target');
    this.marked = el;
  }

  /** Puts the bubble under its target (over it if there is no room under), with the arrow at the target's middle. */
  private place(): void {
    const target = this.tip?.target() ?? null;
    const r = target?.getBoundingClientRect();
    if (!target || !target.isConnected || !r || (r.width === 0 && r.height === 0)) {
      this.el.hidden = true;
      this.mark(null);
      return;
    }
    this.mark(target);
    this.el.hidden = false;
    const width = Math.min(280, window.innerWidth - 16);
    this.el.style.width = `${width}px`;
    const height = this.el.offsetHeight;
    const mid = r.left + r.width / 2;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, mid - width / 2));
    const below = r.bottom + 12 + height <= window.innerHeight - 8 || r.top - 12 - height < 8;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${below ? r.bottom + 12 : r.top - 12 - height}px`;
    this.el.classList.toggle('above', !below);
    this.el.style.setProperty('--arrow', `${Math.max(14, Math.min(width - 14, mid - left))}px`);
  }
}
