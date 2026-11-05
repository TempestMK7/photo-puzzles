import type { Step } from '../core/tutorial';
import type { TutorialStore } from '../store/tutorial';
import { Coach } from './coach';

/**
 * What the screens share to walk the player through the game: what has been shown (`store`), the bubble (`coach`), and, while the play screen points at the Inventory button
 * and the player has opened it, `adDialog` (the Inventory window then points at its own button for an ad, and tells the play screen when it is closed).
 */
export class Tutorial {
  readonly coach = new Coach();
  /** The Inventory window is open and is pointing at the button for an ad. */
  adDialog = false;
  /** The step that the play screen is pointing out now. */
  step: Step | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(readonly store: TutorialStore) {
    store.onChange(() => this.changed());
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Something that the screens decide by has changed: they look again. */
  changed(): void {
    for (const fn of this.listeners) fn();
  }
}
