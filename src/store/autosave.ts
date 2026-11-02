/**
 * When to keep a puzzle that is being played. Each move asks (`touch`), and the puzzle is kept once the player has been still for `idleMs`; but a player who never stops (placing piece
 * after piece) is kept at least every `maxMs` since the first move that has not been kept yet, so that a page that is closed or reloaded loses at most that much. Nothing is kept again when
 * nothing has happened since it was last kept.
 */
export class Autosave {
  private dirty = false;
  private first = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly save: () => void,
    private readonly idleMs = 1500,
    private readonly maxMs = 5000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Something happened that the kept puzzle does not have. */
  touch(): void {
    const now = this.clock();
    if (!this.dirty) {
      this.dirty = true;
      this.first = now;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.idleMs, this.maxMs - (now - this.first))));
  }

  /** Keeps the puzzle now, if anything has happened since it was last kept (the page is being hidden or left). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.save();
  }

  /** Forgets what is waiting to be kept (another puzzle is being started, or this one is over). */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
  }
}
