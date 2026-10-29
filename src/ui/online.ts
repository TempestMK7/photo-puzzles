import { findKind, optionsOf, puzzleSeedText } from '../core/kinds';
import type { Prefs } from '../core/prefs';
import { seedFromText } from '../core/rng';
import type { CallError, OnlineApi } from '../online/api';
import { cloudConfig } from '../online/config';
import { pictureForUpload } from '../online/picture';
import { DEFAULT_LIMITS, NAME_MAX, cleanName, parseInvite, type Invite, type RoomDescriptor, type RoomSettings, type RoomSummary } from '../online/protocol';
import type { Realtime } from '../online/realtime';
import { OnlineRoom } from '../online/room';
import type { OnlineSession } from '../online/session';
import type { PhotoEntry, PhotoLibrary } from '../store/photos';
import { h } from './dom';

export interface OnlineDeps {
  prefs: Prefs;
  photos: PhotoLibrary;
  api: OnlineApi;
  realtime: Realtime;
  identity: OnlineSession;
  /** The photo chosen on the main screen. */
  chosen(): PhotoEntry | undefined;
  /** A room is ready to be played (`invite` only for the one who has just made it). */
  onPlay(room: OnlineRoom, invite: Invite | null): void;
}

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

/** How long until a time, as a short phrase for a list ("about 5 h"). The server's clock and this one may differ by a little: nothing here needs to be exact. */
export function timeLeft(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `about ${hours} h` : `about ${Math.round(hours / 24)} days`;
}

/** What to tell the player when the server said no. */
export function sayError(error: CallError, failure?: { retryAt?: number }): string {
  switch (error) {
    case 'offline':
      return 'Could not reach the online server.';
    case 'sign-in':
      return 'Please sign in again.';
    case 'account-required':
      return 'Making a puzzle needs an account.';
    case 'update-required':
      return 'This version of the game is too old to play online. Please update it.';
    case 'unauthorized':
      return 'You cannot do that in this puzzle.';
    case 'not-found':
      return 'There is no puzzle with that code (or it has ended).';
    case 'expired':
      return 'That puzzle has ended.';
    case 'quota':
      return failure?.retryAt ? `You have made all your online puzzles for this week. The next one is free ${new Date(failure.retryAt).toLocaleString()}.` : 'You have made all your online puzzles for this week.';
    case 'limit':
      return 'You are in as many online puzzles as you can be (leave one first), or the puzzle is too big.';
    case 'full':
      return 'That puzzle is full.';
    case 'rate-limited':
      if (failure?.retryAt) {
        const minutes = Math.max(1, Math.ceil((failure.retryAt - Date.now()) / 60_000));
        return `Too many tries from here. Wait ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`;
      }
      return 'Too many tries. Wait a little.';
    case 'knock-denied':
      return 'They did not let you in.';
    case 'not-ready':
      return 'That puzzle is not ready yet. Try again in a moment.';
    case 'knock-pending':
      return 'Waiting for someone in the puzzle to let you in…';
    case 'bad-request':
      return 'That did not work.';
    default:
      return 'That could not be done right now.';
  }
}

/** The pop-up for playing with friends: make a puzzle, join one with a code or a link, and the puzzles the player is in. */
export class OnlinePanel {
  readonly el: HTMLElement;
  private nameInput = h('input', { type: 'text', class: 'plain', maxLength: NAME_MAX, 'aria-label': 'Your name', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.saveName() });
  private nameLabel = h('span', {}, 'Your name');
  private nameSave = h('button', { type: 'button', onclick: () => void this.saveName() }, 'Save');
  private nameField = h('label', { class: 'field' }, this.nameLabel, h('div', { class: 'row' }, this.nameInput, this.nameSave));
  /** Who is signed in, and the way out (a player with an account). */
  private whoEl = h('div', { class: 'who' });
  /** What stands where "Start a Jigsaw" is for a player who has no account: joining needs only a name, making a puzzle needs an account. */
  private needAccount = h(
    'section',
    { hidden: true },
    h('h3', {}, 'Start a Jigsaw'),
    h('p', { class: 'chosen' }, 'Making a puzzle needs an account. Joining one only needs a name.'),
    h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in or create an account'),
  );
  private startSection: HTMLElement;
  private joinSection: HTMLElement;
  private listSection: HTMLElement;
  /** An invite link that the player came with, to go back to after signing in. */
  private pendingHash = '';
  private chosenEl = h('div', { class: 'chosen' });
  private consent = h('input', { type: 'checkbox', id: 'online-consent' });
  private startBtn = h('button', { type: 'button', class: 'primary', onclick: () => void this.start() }, 'Start');
  private codeInput = h('input', { type: 'text', class: 'plain', placeholder: 'Code or link', 'aria-label': 'Code or link', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.join(this.codeInput.value) });
  private joinBtn = h('button', { type: 'button', onclick: () => void this.join(this.codeInput.value) }, 'Join');
  private statusEl = h('div', { class: 'status', role: 'status' });
  private listEl = h('ul', { class: 'rooms' });
  private busy = false;
  /** The player has pressed "Delete account" and has not yet said whether they mean it. */
  private deleting = false;
  /** Bumped by Close and by a new try: an older try that is still waiting (for a knock to be answered) gives up. */
  private attempt = 0;

  constructor(private readonly deps: OnlineDeps) {
    this.startSection = h(
      'section',
      {},
      h('h3', {}, 'Start a Jigsaw'),
      this.chosenEl,
      h(
        'label',
        { class: 'consent', for: 'online-consent' },
        this.consent,
        h('span', {}, 'I agree that this picture is sent to the online server, where the players of this puzzle can see it. It is deleted when the puzzle is solved or when nobody has touched it for a day.'),
      ),
      this.startBtn,
    );
    this.joinSection = h('section', {}, h('h3', {}, 'Join a friend'), h('div', { class: 'row' }, this.codeInput, this.joinBtn));
    this.listSection = h('section', {}, h('h3', {}, 'Your online puzzles'), this.listEl);
    this.el = h(
      'div',
      { class: 'inprogress online', role: 'dialog', 'aria-label': 'Play with friends', hidden: true, onclick: (e: Event) => (e.target === this.el ? this.close() : undefined) },
      h(
        'div',
        { class: 'card' },
        h('header', {}, h('h2', {}, 'Play with friends'), h('button', { type: 'button', class: 'close', onclick: () => this.close() }, 'Close')),
        h('div', { class: 'body' }, this.whoEl, this.nameField, this.needAccount, this.startSection, this.joinSection, this.statusEl, this.listSection),
      ),
    );
  }

  open(): void {
    this.statusEl.textContent = '';
    this.deleting = false;
    this.el.hidden = false;
    this.refreshAccount();
    void this.prepare();
  }

  /** Asks the server about the account (one that has no name yet is asked for one), and then shows what the player can do. */
  private async prepare(): Promise<void> {
    const s = this.deps.identity;
    if (s.kind() === 'account') {
      await s.refreshProfile();
      if (!this.isOpen) return;
      this.refreshAccount();
    }
    if (s.needsName()) {
      this.say('Choose the name the other players will see, and press Save.');
      return;
    }
    this.refresh();
    if (s.kind() !== 'none') void this.loadList();
  }

  /** Opens the panel for someone who came with an invite link and has not chosen a name: they can, and then press Join. */
  confirmJoin(text: string): void {
    this.open();
    this.codeInput.value = text;
    this.statusEl.textContent = 'Choose your name (or keep this one), then press Join.';
  }

  /** Opens the panel with something to tell the player. */
  notice(text: string): void {
    this.open();
    this.statusEl.textContent = text;
  }

  /** What the panel shows for who the player is: the account, the name, and what they can do (an account makes puzzles; anyone can join one). */
  private refreshAccount(): void {
    const s = this.deps.identity;
    const kind = s.kind();
    const who = s.who();
    const needs = s.needsName();
    const parts: Node[] = [];
    if (kind === 'account' && who) {
      parts.push(
        h(
          'div',
          { class: 'line' },
          h('span', {}, 'Signed in as ', h('strong', {}, who.name)),
          h('button', { type: 'button', class: 'small', onclick: () => this.signOut() }, 'Sign out'),
          h('button', { type: 'button', class: 'small', 'aria-expanded': String(this.deleting), onclick: () => ((this.deleting = !this.deleting), this.refreshAccount()) }, 'Delete account…'),
        ),
      );
      if (this.deleting) {
        parts.push(
          h(
            'div',
            { class: 'warn', role: 'alertdialog', 'aria-label': 'Delete your account' },
            h('p', {}, 'This deletes your account for good. The puzzles you made end (and their pictures are deleted from the server), you are taken out of the puzzles you joined, and your name is forgotten. Your own pictures on this device stay.'),
            h('div', { class: 'row' }, h('button', { type: 'button', class: 'small danger', onclick: () => void this.deleteAccount() }, 'Delete my account'), h('button', { type: 'button', class: 'small', onclick: () => ((this.deleting = false), this.refreshAccount()) }, 'Keep it')),
          ),
        );
      }
    }
    this.whoEl.replaceChildren(...parts);
    if (document.activeElement !== this.nameInput) this.nameInput.value = s.name();
    this.nameLabel.textContent = needs ? 'Choose a display name' : 'Your name';
    this.needAccount.hidden = needs || s.canCreate() || !s.hasAccounts;
    this.startSection.hidden = needs || !s.canCreate();
    this.joinSection.hidden = needs;
    this.listSection.hidden = needs || kind === 'none';
  }

  private async saveName(): Promise<void> {
    const s = this.deps.identity;
    const was = s.needsName();
    const ok = await s.setName(this.nameInput.value);
    this.nameInput.value = s.name();
    this.refreshAccount();
    if (!ok) {
      this.say(cleanName(this.nameInput.value) ? 'Kept on this device; the online server could not be reached.' : 'Type the name the other players will see.');
      return;
    }
    this.say('Saved.');
    if (was) void this.prepare();
  }

  private async signIn(): Promise<void> {
    await this.deps.identity.signIn(this.pendingHash);
    this.open();                                                                  // a sign-in page takes the player away and brings them back; a stand-in only needs the panel to be drawn again
  }

  private signOut(): void {
    this.deps.identity.signOut();
    this.open();
  }

  private async deleteAccount(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true, 'Deleting your account…');
    const res = await this.deps.api.deleteAccount();
    this.setBusy(false);
    if (!res.ok) {
      this.say(res.error === 'busy' ? 'Part of it could not be done. Press "Delete my account" again.' : sayError(res.error));
      return;
    }
    // with Cognito the sign-out takes the page away and brings it back: the message is shown then
    if (cloudConfig()) {
      try {
        window.sessionStorage.setItem(DELETED_KEY, '1');
      } catch {
        /* the message is only lost */
      }
    }
    this.signOut();
    this.say(DELETED_TEXT);
  }

  close(): void {
    this.attempt++;
    this.el.hidden = true;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  private say(text: string): void {
    this.statusEl.textContent = text;
  }

  private setBusy(on: boolean, text = ''): void {
    this.busy = on;
    this.startBtn.disabled = on;
    this.joinBtn.disabled = on;
    this.say(text);
  }

  /** What is shown about the chosen photo and the settings the puzzle would have. */
  private refresh(): void {
    const entry = this.deps.chosen();
    const kind = findKind('jigsaw')!;
    const opts = optionsOf(this.deps.prefs.data.settings, kind);
    const note = opts.pieces > DEFAULT_LIMITS.jigsawPieces ? ` (online puzzles have at most ${DEFAULT_LIMITS.jigsawPieces} pieces: it will have that many)` : '';
    this.chosenEl.textContent = !entry
      ? 'Choose a picture on the main screen first.'
      : entry.video
        ? 'Videos cannot be played online yet: choose a picture.'
        : `${entry.name}: about ${Math.min(opts.pieces, DEFAULT_LIMITS.jigsawPieces)} pieces${opts.turning ? ', turned pieces' : ''}${note}. The settings are the Jigsaw settings of the main screen.`;
    this.startBtn.disabled = this.busy || !entry || entry.video;
  }

  private async loadList(): Promise<void> {
    const res = await this.deps.api.list();
    if (!res.ok) {
      // a sign-in that the server does not take any more: the button to sign in again is shown
      if (res.error === 'sign-in') this.refreshAccount();
      const local = !cloudConfig();
      this.listEl.replaceChildren(h('li', { class: 'empty' }, res.error === 'offline' ? `Could not reach the online server.${local ? ' Is it running (npm run server)?' : ''}` : sayError(res.error)));
      return;
    }
    this.renderList(res.rooms);
  }

  private renderList(rooms: RoomSummary[]): void {
    this.listEl.replaceChildren(
      ...(rooms.length
        ? rooms.map((r) =>
            h(
              'li',
              {},
              h(
                'span',
                { class: 'what' },
                `Jigsaw · ${r.settings.opts.pieces} pieces · ${r.members.map((m) => m.name).join(', ')}`,
                h(
                  'small',
                  { title: 'A puzzle that nobody touches for a day ends; a solved one stays for a while so that the others can still look at it' },
                  r.status === 'solved' ? ` · solved, ${timeLeft(r.expiresAt)} to look at it` : `${r.online ? ` · ${r.online} here now` : ''} · ends in ${timeLeft(r.expiresAt)} unless someone plays`,
                ),
              ),
              h('button', { type: 'button', class: 'small primary', onclick: () => void this.openRoom(r.id) }, r.status === 'solved' ? 'Watch' : 'Open'),
              h('button', { type: 'button', class: 'small', title: 'Leave this puzzle for good', onclick: () => void this.forget(r.id) }, 'Leave'),
            ),
          )
        : [h('li', { class: 'empty' }, 'None yet.')]),
    );
  }

  private async forget(id: string): Promise<void> {
    await this.deps.api.leave(id);
    void this.loadList();
  }

  private async openRoom(id: string): Promise<void> {
    this.setBusy(true, 'Opening…');
    const res = await this.deps.api.getRoom(id);
    this.setBusy(false);
    if (!res.ok) {
      this.say(sayError(res.error));
      return;
    }
    this.enter(res.room, null);
  }

  private enter(descriptor: RoomDescriptor, invite: Invite | null): void {
    this.close();
    this.deps.onPlay(new OnlineRoom(this.deps.api, this.deps.realtime, descriptor, this.deps.identity.who()?.id ?? ''), invite);
  }

  // ---------------------------------------------------------------------------------------------------------------- making a puzzle

  private async start(): Promise<void> {
    const entry = this.deps.chosen();
    const { api, prefs, photos } = this.deps;
    if (!entry || entry.video || this.busy) return;
    if (!this.deps.identity.canCreate()) {
      this.say('Making a puzzle needs an account.');
      return;
    }
    if (!(this.consent as HTMLInputElement).checked) {
      this.say('Tick the box to agree that the picture is sent to the server.');
      return;
    }
    this.setBusy(true, 'Preparing the picture…');
    try {
      const src = await photos.load(entry);
      const blob = await pictureForUpload(src.source, src.width, src.height);
      src.dispose();
      const kind = findKind('jigsaw')!;
      const opts: Record<string, number> = {};
      const all = optionsOf(prefs.data.settings, kind);
      for (const o of kind.options) if (!o.display) opts[o.key] = all[o.key];
      opts.pieces = Math.min(opts.pieces, DEFAULT_LIMITS.jigsawPieces);
      const settings: RoomSettings = { kind: 'jigsaw', seed: seedFromText(puzzleSeedText(prefs.data.seed, entry.id, 'jigsaw')), width: src.width, height: src.height, opts };
      this.say('Making the puzzle…');
      const made = await api.createRoom({ settings, sourceId: entry.id, consent: true });
      if (!made.ok) return this.fail(made);
      this.say('Sending the picture…');
      const up = await api.upload(made.upload.url, blob);
      if (!up.ok) return this.fail(up);
      const got = await api.getRoom(made.roomId);
      if (!got.ok) return this.fail(got);
      this.setBusy(false);
      this.enter(got.room, made.invite);
    } catch (e) {
      this.setBusy(false, e instanceof Error ? e.message : 'That did not work.');
    }
  }

  private fail(r: { error: CallError; retryAt?: number }): void {
    this.setBusy(false, sayError(r.error, r));
  }

  // ---------------------------------------------------------------------------------------------------------------- joining

  /** Joins with what the player typed or a link opened the game with. A code alone knocks: this waits until a member lets the player in. Needs no account: a guest is made if there is none. */
  async join(text: string): Promise<void> {
    const inv = parseInvite(text);
    if (!inv) {
      this.say('That is not a five-digit code or an invite link.');
      return;
    }
    if (!this.isOpen) this.open();
    const mine = ++this.attempt;
    const s = this.deps.identity;
    this.setBusy(true, 'Joining…');
    if (!(await s.ensureGuest())) {
      if (mine === this.attempt) this.setBusy(false, sayError('offline'));
      return;
    }
    await s.refreshProfile();
    if (mine !== this.attempt) return;
    this.refreshAccount();
    if (s.needsName()) {
      // an account that has no name yet is asked for one before it shows up in somebody's puzzle
      this.setBusy(false);
      this.codeInput.value = text;
      this.say('Choose the name the other players will see, press Save, and then press Join.');
      return;
    }
    for (;;) {
      const res = await this.deps.api.join(inv);
      if (mine !== this.attempt) return;
      if (res.ok) {
        this.setBusy(false);
        this.enter(res.room, null);
        return;
      }
      if (res.error !== 'knock-pending') {
        this.setBusy(false);
        this.say(sayError(res.error));
        return;
      }
      this.say('Waiting for someone in the puzzle to let you in… (close this window to stop waiting)');
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (mine !== this.attempt) return;
    }
  }
}
