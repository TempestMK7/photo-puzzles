import type { OnlineApi } from '../online/api';
import { NAME_MAX, cleanName } from '../online/protocol';
import type { OnlineSession } from '../online/session';
import { h } from './dom';
import { sayError } from './online';

/** The address of the page where an account is deleted without the app (a store wants one): the game's own address with this after it. */
export const DELETE_HASH = '#/delete-account';
const DELETED_KEY = 'photo-puzzles/online/account-deleted';
const DELETED_TEXT = 'Your account was deleted. The puzzles you made have ended, and you are out of the others. Your own pictures on this device are untouched.';

/** Whether the page was loaded after an account was deleted (the sign-in service's sign-out page takes the player away and brings them back, so the answer waits in the session). */
export function takeAccountDeletedNotice(): string | null {
  try {
    const was = window.sessionStorage.getItem(DELETED_KEY) !== null;
    window.sessionStorage.removeItem(DELETED_KEY);
    return was ? DELETED_TEXT : null;
  } catch {
    return null;
  }
}

export interface ProfileDeps {
  identity: OnlineSession;
  api: OnlineApi;
  /** Asks the player to sign in (the pop-up for it); true when they have. */
  signIn(): Promise<boolean>;
  /** Called when who the player is has changed (signed in or out, a new name), so that the rest of the screen can follow. */
  changed(): void;
}

/** The first letter of a name, in capitals, for the round badge. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

/**
 * The round badge on the main screen (the first letter of the account's name, or a G for a guest) and the profile it opens: the name the other players see, what the player is signed in
 * as, and the ways to sign in, sign out and delete the account.
 */
export class ProfileDialog {
  readonly el: HTMLElement;
  /** The badge for the main screen. */
  readonly badge = h('button', { type: 'button', class: 'avatar', 'aria-label': 'Your profile', onclick: () => this.open() });
  private nameInput = h('input', { type: 'text', class: 'plain', maxLength: NAME_MAX, 'aria-label': 'Your name', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.saveName() });
  private nameSave = h('button', { type: 'button', onclick: () => void this.saveName() }, 'Save');
  private bigBadge = h('div', { class: 'avatar big', 'aria-hidden': 'true' });
  private whoEl = h('div', { class: 'who' });
  private accountEl = h('section', {});
  private statusEl = h('div', { class: 'status', role: 'status' });
  private loadingEl = h('p', { class: 'chosen' }, 'Loading…');
  private content: HTMLElement[];
  private loading = false;
  private deleting = false;
  private busy = false;
  /** Signing in is asked for to go on with deleting an account (the page was opened at the address that stores list). */
  private wantsDeletion = false;

  constructor(private readonly deps: ProfileDeps) {
    this.content = [
      h('div', { class: 'identity' }, this.bigBadge, this.whoEl),
      h('label', { class: 'field' }, h('span', {}, 'The name other players see'), h('div', { class: 'row' }, this.nameInput, this.nameSave)),
      this.accountEl,
    ];
    this.el = h(
      'div',
      { class: 'inprogress online profile', role: 'dialog', 'aria-label': 'Your profile', hidden: true, onclick: (e: Event) => (e.target === this.el ? this.close() : undefined), onkeydown: (e: KeyboardEvent) => e.key === 'Escape' && this.close() },
      h('div', { class: 'card' }, h('header', {}, h('h2', {}, 'Your profile'), h('button', { type: 'button', class: 'close', onclick: () => this.close() }, 'Close')), h('div', { class: 'body' }, this.loadingEl, ...this.content, this.statusEl)),
    );
    this.refreshBadge();
  }

  /** The badge shows the first letter of the account's name, and a G when nobody is signed in. */
  refreshBadge(): void {
    const s = this.deps.identity;
    const account = s.kind() === 'account';
    const letter = account ? initialOf(s.name()) : 'G';
    this.badge.textContent = letter;
    this.badge.title = account ? `Signed in as ${s.name()}` : 'Not signed in: your profile';
    this.badge.classList.toggle('guest', !account);
    this.bigBadge.textContent = letter;
    this.bigBadge.classList.toggle('guest', !account);
  }

  open(): void {
    this.statusEl.textContent = '';
    this.deleting = false;
    this.show();
  }

  /** Opens the profile with something to tell the player. */
  notice(text: string): void {
    this.open();
    this.statusEl.textContent = text;
  }

  /**
   * Opens the profile for someone who came to delete their account (from the address that a store lists, or the game's own link): signed in, the question is asked at once;
   * otherwise they are asked to sign in first.
   */
  async openDeletion(): Promise<void> {
    this.statusEl.textContent = '';
    const s = this.deps.identity;
    if (s.kind() !== 'account') {
      if (!s.hasAccounts) {
        this.notice('There is no account to delete in this version of the game: nothing is kept about you.');
        return;
      }
      this.wantsDeletion = true;
      this.open();
      this.statusEl.textContent = 'To delete your account, sign in with it first.';
      return;
    }
    this.deleting = true;
    this.show();
  }

  private show(): void {
    const s = this.deps.identity;
    this.el.hidden = false;
    this.loading = !s.profileLoaded();
    this.render();
    if (this.loading) {
      void s.refreshProfile().then(() => {
        this.loading = false;
        this.refreshBadge();
        if (!this.el.hidden) this.render();
      });
    }
  }

  close(): void {
    this.el.hidden = true;
    this.wantsDeletion = false;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private render(): void {
    const s = this.deps.identity;
    const kind = s.kind();
    this.loadingEl.hidden = !this.loading;
    for (const el of this.content) el.hidden = this.loading;
    if (this.loading) return;
    this.refreshBadge();
    const email = s.email();
    this.whoEl.replaceChildren(
      h('strong', {}, s.name()),
      h('span', {}, kind === 'account' ? (email ?? 'Signed in') : kind === 'guest' ? 'Playing as a guest' : 'Not signed in'),
    );
    if (document.activeElement !== this.nameInput) this.nameInput.value = s.name();
    const parts: Node[] = [];
    if (kind === 'account') {
      parts.push(
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', onclick: () => this.signOut() }, 'Sign out'),
          h('button', { type: 'button', 'aria-expanded': String(this.deleting), onclick: () => ((this.deleting = !this.deleting), this.render()) }, 'Delete account…'),
        ),
      );
      if (this.deleting) {
        parts.push(
          h(
            'div',
            { class: 'warn', role: 'alertdialog', 'aria-label': 'Delete your account' },
            h('p', {}, 'This deletes your account for good. The puzzles you made end (and their pictures are deleted from the server), you are taken out of the puzzles you joined, and your name is forgotten. Your own pictures on this device stay.'),
            h('div', { class: 'row' }, h('button', { type: 'button', class: 'danger', onclick: () => void this.deleteAccount() }, 'Delete my account'), h('button', { type: 'button', onclick: () => ((this.deleting = false), this.render()) }, 'Keep it')),
          ),
        );
      }
    } else if (s.hasAccounts) {
      parts.push(
        h('p', { class: 'chosen' }, 'Anyone can join a friend’s puzzle. An account is needed to make one, and keeps your name.'),
        h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in or create an account'),
      );
    }
    this.accountEl.replaceChildren(...parts);
  }

  private say(text: string): void {
    this.statusEl.textContent = text;
  }

  private async saveName(): Promise<void> {
    const s = this.deps.identity;
    const ok = await s.setName(this.nameInput.value);
    this.nameInput.value = s.name();
    this.render();
    this.deps.changed();
    if (!ok) {
      this.say(cleanName(this.nameInput.value) ? 'Kept on this device; the online server could not be reached.' : 'Type the name the other players will see.');
      return;
    }
    this.say('Saved.');
  }

  private async signIn(): Promise<void> {
    if (!(await this.deps.signIn())) return;
    this.deps.changed();
    const goOn = this.wantsDeletion;
    this.wantsDeletion = false;
    this.statusEl.textContent = '';
    if (goOn) this.deleting = true;
    this.show();
  }

  private signOut(): boolean {
    const leaves = this.deps.identity.signOut();
    this.deleting = false;
    this.deps.changed();
    this.render();
    return leaves;
  }

  private async deleteAccount(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Deleting your account…');
    const res = await this.deps.api.deleteAccount();
    this.busy = false;
    if (!res.ok) {
      this.say(res.error === 'busy' ? 'Part of it could not be done. Press "Delete my account" again.' : sayError(res.error));
      return;
    }
    // signing out through the sign-in service's own page takes the page away and brings it back (the navigation starts after this): the message is shown then
    if (this.signOut()) {
      try {
        window.sessionStorage.setItem(DELETED_KEY, '1');
      } catch {
        /* the message is only lost */
      }
    }
    this.say(DELETED_TEXT);
  }
}
