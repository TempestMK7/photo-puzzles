import { h } from './dom';

/** What the window shows: a picture, or a video that is being played elsewhere (the window follows it). */
export interface RefSource {
  image?: string;
  video?: HTMLVideoElement;
  width: number;
  height: number;
}

const MIN_W = 150;

/**
 * A small window over the board that shows the original picture, for looking at while solving. It can be dragged by its title and made bigger or smaller by the corner.
 * A video is not played a second time: the picture of the video that the puzzle is cut from is mirrored (captureStream), so the window shows exactly the same moment
 * whether the video plays or is paused - and costs no second decoder, which matters on a slow device. Where that is not available the pictures are copied across.
 */
export class RefWindow {
  readonly el: HTMLElement;
  private img = h('img', { alt: 'The original picture', draggable: false });
  private vid = h('video', { muted: true, playsInline: true, autoplay: true, 'aria-label': 'The original video' });
  private canvas = h('canvas', { 'aria-label': 'The original video' });
  private body = h('div', { class: 'refbody' });
  private source: RefSource | null = null;
  private copyFrom: HTMLVideoElement | null = null;
  private width = 280;
  private left = -1;
  private top = 8;

  constructor(
    private readonly host: HTMLElement,
    private readonly onClose: () => void,
  ) {
    const title = h('div', { class: 'reftitle' }, h('span', {}, 'Original'));
    const close = h('button', { type: 'button', class: 'refclose', title: 'Close', 'aria-label': 'Close the original', onclick: () => this.onClose() }, '×');
    title.append(close);
    const grip = h('div', { class: 'refgrip', title: 'Drag to resize' });
    this.body.append(this.img, this.vid, this.canvas, grip);
    this.el = h('div', { class: 'refwin', hidden: true, role: 'dialog', 'aria-label': 'Original' }, title, this.body);
    this.drag(title, (dx, dy, from) => {
      this.left = from.left + dx;
      this.top = from.top + dy;
      this.place();
    });
    this.drag(grip, (dx, _dy, from) => {
      this.width = from.width + dx;
      this.place();
    });
    window.addEventListener('resize', () => this.place());
    host.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  show(source: RefSource): void {
    this.release();
    this.source = source;
    this.body.style.setProperty('--ar', String(source.width / source.height));
    const v = source.video;
    this.img.hidden = !!v;
    this.vid.hidden = true;
    this.canvas.hidden = true;
    if (v) {
      const stream = (v as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
      if (stream) {
        this.vid.srcObject = stream;
        this.vid.hidden = false;
        void this.vid.play().catch(() => undefined);
      } else {
        this.canvas.width = Math.min(source.width, 640);
        this.canvas.height = Math.round((this.canvas.width * source.height) / source.width);
        this.canvas.hidden = false;
        this.copyFrom = v;
        this.frame();
      }
    } else this.img.src = source.image ?? '';
    this.el.hidden = false;
    if (this.left < 0) this.left = Math.max(0, this.host.clientWidth - this.width - 8);
    this.place();
  }

  hide(): void {
    this.el.hidden = true;
    this.release();
  }

  /** The video has a new picture (only needed where the window cannot mirror it by itself). */
  frame(): void {
    const v = this.copyFrom;
    if (v && this.open) this.canvas.getContext('2d')!.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
  }

  private release(): void {
    this.copyFrom = null;
    this.source = null;
    this.vid.pause();
    this.vid.srcObject = null;
    this.img.removeAttribute('src');
  }

  /** Keeps the window on the board, whatever its size. */
  private place(): void {
    const hw = this.host.clientWidth;
    const hh = this.host.clientHeight;
    if (!hw || !hh) return;
    const ar = this.source ? this.source.width / this.source.height : 1.5;
    this.width = Math.max(MIN_W, Math.min(this.width, hw - 8, (hh - 40) * ar));
    this.el.style.width = `${this.width}px`;
    const height = this.el.offsetHeight;                              // (after the width: the picture's height follows it)
    this.left = Math.max(0, Math.min(this.left, hw - this.width));
    this.top = Math.max(0, Math.min(this.top, hh - Math.min(height, hh - 4)));
    this.el.style.left = `${this.left}px`;
    this.el.style.top = `${this.top}px`;
  }

  /** Makes `handle` drag something: `move` gets how far the pointer has gone and where the window was. */
  private drag(handle: HTMLElement, move: (dx: number, dy: number, from: { left: number; top: number; width: number }) => void): void {
    let start: { x: number; y: number; left: number; top: number; width: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      start = { x: e.clientX, y: e.clientY, left: this.left, top: this.top, width: this.width };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (start) move(e.clientX - start.x, e.clientY - start.y, start);
    });
    const end = () => (start = null);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
