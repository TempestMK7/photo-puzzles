import { cleanPuzzleSettings } from '../core/kinds';
import type { Prefs } from '../core/prefs';
import type { OnlineApi } from './api';
import type { OnlineSession } from './session';

/** How long after the last change the settings are sent (a slider moves through many values). */
const SEND_DELAY_MS = 1500;

/**
 * Keeps the puzzle options that the player used last (what the main screen shows: sizes and fast mode options, not how the game looks) for the signed-in account, so that any device starts with them.
 * The first time an account is seen in a run of the game, what the server holds is taken in (and shown); an account that has none yet is given this device's. After that every change is sent,
 * a moment after the last one. A guest has no account to keep them for: theirs stay on the device. Nothing here is needed to play: what cannot be sent is sent with the next change.
 */
export class SettingsSync {
  /** The account whose settings were taken in (or given) in this run. */
  private syncedFor = '';
  /** What the server holds, as text, to send only what is new. */
  private held = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly prefs: Prefs,
    private readonly identity: OnlineSession,
    private readonly api: Pick<OnlineApi, 'saveSettings'>,
    /** The settings were replaced by the account's: the main screen shows them. */
    private readonly applied: () => void,
  ) {
    identity.onChange(() => this.heard());
    prefs.onSave(() => this.changed());
  }

  private account(): string | null {
    const who = this.identity.kind() === 'account' ? this.identity.who() : null;
    return who && this.identity.summary().type !== 'guest' ? who.id : null;      // (a guest's summary is what shows until the server has been asked)
  }

  /** The server has said something about the account: the first time for an account, its settings are taken in. */
  private heard(): void {
    const id = this.account();
    if (!id || id === this.syncedFor) return;
    this.syncedFor = id;
    const theirs = this.identity.summary().settings;
    if (theirs) {
      this.held = JSON.stringify(sorted(cleanPuzzleSettings(theirs)));
      Object.assign(this.prefs.data.settings, cleanPuzzleSettings(theirs));
      this.prefs.save();
      this.applied();
    } else {
      this.held = '';
      this.changed();                                                              // (this device's are the account's first)
    }
  }

  private changed(): void {
    if (!this.syncedFor || this.account() !== this.syncedFor) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.send(), SEND_DELAY_MS);
  }

  private async send(): Promise<void> {
    const clean = sorted(cleanPuzzleSettings(this.prefs.data.settings));
    const text = JSON.stringify(clean);
    if (text === this.held || !Object.keys(clean).length || this.account() !== this.syncedFor) return;
    const res = await this.api.saveSettings(clean);
    if (res.ok) this.held = text;
  }
}

const sorted = (s: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(s).sort(([a], [b]) => (a < b ? -1 : 1)));
