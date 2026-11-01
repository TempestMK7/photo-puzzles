import { describeDifficulty, findKind, optionsOf, puzzleSeedText, type KindId, type Settings } from '../core/kinds';
import type { Prefs } from '../core/prefs';
import { seedFromText } from '../core/rng';
import type { CallError, Offline, OnlineApi } from '../online/api';
import type { CreditKind } from './credits';
import { cloudConfig } from '../online/config';
import { pictureForUpload } from '../online/picture';
import { videoTypeOf } from '../online/videoFile';
import { DEFAULT_LIMITS, NAME_MAX, VIDEO_TYPES, cleanName, parseInvite, type AccountSummary, type AdRefusal, type ApiFailure, type CreateRoomResponse, type Invite, type RoomDescriptor, type RoomSettings, type RoomSummary } from '../online/protocol';
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
  /** Opens the profile (the name, signing out, deleting the account). */
  openProfile(): void;
  /** Asks the player to sign in or make an account; true when they have. */
  signIn(): Promise<boolean>;
  /** Opens the dialog that explains the credits of this kind (when starting a puzzle needs credits the account has not got). */
  openCredits?(kind: CreditKind): void;
}

/** How long the owner's game waits for the check of a video (it takes a minute or two) before it stops asking, and how often it asks. */
const CHECK_GIVE_UP_MS = 10 * 60_000;
const CHECK_EVERY_MS = 3000;

/** How long until a time, as a short phrase for a list ("about 5 h"). The server's clock and this one may differ by a little: nothing here needs to be exact. */
export function timeLeft(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `about ${hours} h` : `about ${Math.round(hours / 24)} days`;
}

/** What to tell the player when the server said no. */
/** What starting the chosen picture or video would cost this account, for the line under its name. */
export function costNote(video: boolean, a: AccountSummary): string {
  if (a.type === 'guest') return '';
  if (video) {
    if (!a.canVideo) return 'Video puzzles are for paid accounts.';
    return a.videoInfinite ? 'Starting it costs no credits.' : `Starting it costs 1 video credit (you have ${a.video}).`;
  }
  return a.photoInfinite ? 'Starting it costs no credits.' : `Starting it costs 1 photo credit (you have ${a.photo}).`;
}

const AD_REFUSALS: Record<AdRefusal, string> = {
  'has-credits': 'You can watch an ad when you have no credits left.',
  'daily-limit': 'You have watched all of today\u2019s ads. You can watch more tomorrow.',
  platform: 'Ads can only be watched in the Android and iOS apps.',
  plan: 'This account does not get credits for ads.',
  unverified: 'The ad could not be checked, so there are no credits for it.',
};

export function sayError(error: CallError, failure?: { retryAt?: number; credits?: 'photo' | 'video'; reason?: AdRefusal }): string {
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
    case 'no-credits':
      return failure?.credits === 'video' ? 'You have no video credits left.' : 'You have no photo credits left.';
    case 'plan-required':
      return 'Video puzzles are for paid accounts.';
    case 'ad-refused':
      return (failure?.reason && AD_REFUSALS[failure.reason]) || 'That ad could not be counted.';
    case 'ads-off':
      return 'Ads cannot be counted for credits yet.';
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
    case 'rejected':
      return 'That picture or video cannot be used for an online puzzle.';
    case 'unreadable':
      return 'The check could not read that video. Online puzzles take MP4 or MOV made with H.264.';
    case 'too-big':
      return 'That video is longer or larger than an online puzzle allows.';
    case 'paused':
      return 'Making new online puzzles is switched off for a while. You can still join your friends\u2019 puzzles.';
    case 'banned':
      return 'This account has been stopped from playing online.';
    case 'knock-denied':
      return 'They did not let you in.';
    case 'removed':
      return 'The owner of that puzzle sent you out of it.';
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

/** The puzzles that can be played together, and what a size sets in each (the first is how many pieces or cells it has). */
const ROOM_KINDS: Partial<Record<KindId, string[]>> = { jigsaw: ['pieces'], focus: ['pieces'], overlap: ['total', 'stacks'], strips: ['cells', 'length', 'tabs'] };

/** The puzzle a room is started with: the type chosen on the main screen if it can be played together, else a Jigsaw. */
function roomKind(prefs: Prefs): KindId {
  return prefs.data.kind in ROOM_KINDS ? (prefs.data.kind as KindId) : 'jigsaw';
}

/** The options of an online puzzle: the puzzle's own, with what the size sets as plain numbers (the sizes of the main screen are not the room's business), at most as many pieces as an online puzzle may have. */
function roomOpts(settings: Settings, id: KindId): Record<string, number> {
  const kind = findKind(id)!;
  const all = optionsOf(settings, kind);
  const opts: Record<string, number> = {};
  for (const o of kind.options) if (!o.display && !o.tiers) opts[o.key] = all[o.key];
  for (const key of ROOM_KINDS[id]!) opts[key] = all[key];
  const main = ROOM_KINDS[id]![0];
  opts[main] = Math.min(all[main], DEFAULT_LIMITS.jigsawPieces);
  return opts;
}

/** What a puzzle in the list is: "Jigsaw · 200 pieces". */
export function roomLabel(settings: Pick<RoomSettings, 'kind'> & { opts: Record<string, number> }): string {
  const kind = findKind(settings.kind);
  const o = settings.opts;
  const size = settings.kind === 'overlap' ? `${o.total} cells` : settings.kind === 'strips' ? `${o.cells} cells` : `${o.pieces} pieces`;
  return `${kind?.name ?? 'Puzzle'} · ${size}`;
}

/** The pop-up for playing with friends: make a puzzle, join one with a code or a link, and the puzzles the player is in. */

export class OnlinePanel {
  readonly el: HTMLElement;
  private nameInput = h('input', { type: 'text', class: 'plain', maxLength: NAME_MAX, 'aria-label': 'Your name', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.saveName() });
  private nameLabel = h('span', {}, 'Your name');
  private nameSave = h('button', { type: 'button', onclick: () => void this.saveName() }, 'Save');
  private nameField = h('label', { class: 'field' }, this.nameLabel, h('div', { class: 'row' }, this.nameInput, this.nameSave));
  /** Who is playing, and the way to the profile. */
  private whoEl = h('div', { class: 'who' });
  /** Stands in for everything else while the account's name is being fetched, so that nothing is drawn twice. */
  private loadingEl = h('p', { class: 'chosen' }, 'Loading…');
  /** What stands where "Start a puzzle" is for a player who has no account: joining needs only a name, making a puzzle needs an account. */
  private startTitle = h('h3', {}, 'Start a puzzle');
  private needTitle = h('h3', {}, 'Start a puzzle');
  private needAccount = h(
    'section',
    { hidden: true },
    this.needTitle,
    h('p', { class: 'chosen' }, 'Making a puzzle needs an account. Joining one only needs a name.'),
    h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in or create an account'),
  );
  private startSection: HTMLElement;
  private joinSection: HTMLElement;
  private listSection: HTMLElement;
  /** The invite link that the player came with: the box shows only its code, and the secret that goes with it waits here (pressing Join with that code uses it). */
  private invite: { code: string; secret: string } | null = null;
  /** The name box is shown (to someone who has to choose a name, or who came with an invite link and may want to change theirs). */
  private askName = false;
  /** The account's profile is being asked for (see `loadingEl`). */
  private loading = false;
  private chosenEl = h('div', { class: 'chosen' });
  private consent = h('input', { type: 'checkbox', id: 'online-consent' });
  private consentText = h('span', {}, '');
  private startBtn = h('button', { type: 'button', class: 'primary', onclick: () => void this.start() }, 'Start');
  private codeInput = h('input', { type: 'text', class: 'plain', placeholder: 'Code or link', 'aria-label': 'Code or link', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void this.join(this.codeInput.value) });
  private joinBtn = h('button', { type: 'button', onclick: () => void this.join(this.codeInput.value) }, 'Join');
  private statusEl = h('div', { class: 'status', role: 'status' });
  private listEl = h('ul', { class: 'rooms' });
  private busy = false;
  /** Bumped by Close and by a new try: an older try that is still waiting (for a knock to be answered) gives up. */
  private attempt = 0;

  constructor(private readonly deps: OnlineDeps) {
    this.startSection = h(
      'section',
      {},
      this.startTitle,
      this.chosenEl,
      h(
        'label',
        { class: 'consent', for: 'online-consent' },
        this.consent,
        this.consentText,
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
        h('div', { class: 'body' }, this.loadingEl, this.whoEl, this.nameField, this.needAccount, this.startSection, this.joinSection, this.statusEl, this.listSection),
      ),
    );
    deps.identity.onChange(() => this.isOpen && this.refresh());                      // (the line about what the puzzle costs follows the account's credits)
  }

  open(): void {
    this.statusEl.textContent = '';
    this.askName = false;
    this.el.hidden = false;
    // everything that is known now is drawn now (the photo that is chosen, so that Start is right from the first moment); what has to be asked of the server is waited for first
    this.loading = !this.deps.identity.profileLoaded();
    this.refreshAccount();
    this.refresh();
    void this.prepare();
  }

  /** Asks the server about the account (once for each), and then shows what the player can do. */
  private async prepare(): Promise<void> {
    const s = this.deps.identity;
    if (this.loading) {
      await s.refreshProfile();
      if (!this.isOpen) return;
      this.loading = false;
      this.refreshAccount();
      this.refresh();
    }
    if (s.needsName()) {
      this.say('Choose the name the other players will see, and press Save.');          // only when the server could not be given the name that the sign-in knows
      return;
    }
    if (s.kind() !== 'none') void this.loadList();
  }

  /** Opens the panel for someone who came with an invite link and has not chosen a name: they can, and then press Join. */
  confirmJoin(text: string): void {
    this.open();
    this.askName = true;
    this.refreshAccount();
    const inv = parseInvite(text);
    this.invite = inv?.secret ? { code: inv.code, secret: inv.secret } : null;
    this.codeInput.value = inv?.code ?? text;                       // as if it had been typed: the five digits
    this.statusEl.textContent = 'Choose your name (or keep this one), then press Join.';
  }

  /** Opens the panel with something to tell the player. */
  notice(text: string): void {
    this.open();
    this.statusEl.textContent = text;
  }

  /** What the panel shows for who the player is: who is playing, and what they can do (an account makes puzzles; anyone can join one). */
  private refreshAccount(): void {
    const s = this.deps.identity;
    const kind = s.kind();
    const who = s.who();
    const needs = !this.loading && s.needsName();
    const asking = needs || this.askName;
    this.loadingEl.hidden = !this.loading;
    this.whoEl.hidden = this.loading;
    this.whoEl.replaceChildren(
      ...(who && kind !== 'none' && !asking
        ? [h('div', { class: 'line' }, h('span', {}, 'Playing as ', h('strong', {}, who.name)), h('button', { type: 'button', class: 'small', onclick: () => this.deps.openProfile() }, 'Profile'))]
        : []),
    );
    if (document.activeElement !== this.nameInput) this.nameInput.value = s.name();
    this.nameLabel.textContent = needs ? 'Choose a display name' : 'Your name';
    this.nameField.hidden = this.loading || !asking;
    const wait = this.loading || needs;
    this.needAccount.hidden = wait || s.canCreate() || !s.hasAccounts;
    this.startSection.hidden = wait || !s.canCreate();
    this.joinSection.hidden = wait;
    this.listSection.hidden = wait || kind === 'none';
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
    this.askName = false;
    this.refreshAccount();
    if (was) void this.prepare();
  }

  private async signIn(): Promise<void> {
    if (await this.deps.signIn()) this.open();
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
    const id = roomKind(this.deps.prefs);
    const kind = findKind(id)!;
    const settings = this.deps.prefs.data.settings;
    const opts = optionsOf(settings, kind);
    const main = ROOM_KINDS[id]![0];
    const note = opts[main] > DEFAULT_LIMITS.jigsawPieces ? ` (online puzzles have at most ${DEFAULT_LIMITS.jigsawPieces} ${id === 'overlap' || id === 'strips' ? 'cells' : 'pieces'}: it will have that many)` : '';
    this.startTitle.textContent = this.needTitle.textContent = `Start ${/^[aeiou]/i.test(kind.name) ? 'an' : 'a'} ${kind.name}`;
    const admin = this.deps.identity.isAdmin();                                  // an administrator may try a video of any length and size
    const tooLong = !admin && !!entry?.video && entry.duration * 1000 > DEFAULT_LIMITS.videoMs;
    const wrongKind = !!entry?.video && /[.](webm|mkv)$/i.test(entry.name);          // plays here, but cannot be checked to be shared (the check reads MP4 and MOV)
    this.chosenEl.textContent = !entry
      ? 'Choose a picture or video on the main screen first.'
      : wrongKind
        ? `${entry.name} cannot be shared online: online puzzles take MP4 or MOV videos (made with H.264).`
        : tooLong
        ? `${entry.name} is longer than the ${DEFAULT_LIMITS.videoMs / 1000} seconds an online video puzzle may be: choose another, or a picture.`
        : `${entry.name}: ${entry.video ? 'a video, ' : ''}${describeDifficulty(kind, settings)}${note}. The settings are the ${kind.name} settings of the main screen. ${costNote(!!entry.video, this.deps.identity.summary())}`.trim();
    const said = entry?.video
      ? 'I agree that this video is sent to the online server, where the players of this puzzle can see and download it, and that all of it is checked automatically. The puzzle is deleted when it is solved or when nobody has touched it for a day, but the server keeps a copy of the video for a week after you last make a puzzle from it, so that you can make another without sending it again. I confirm that it has no sexual or adult content: that is not allowed in online puzzles.'
      : 'I agree that this picture is sent to the online server, where the players of this puzzle can see it. The puzzle is deleted when it is solved or when nobody has touched it for a day, but the server keeps a copy of the picture for a week after you last make a puzzle from it, so that you can make another without sending it again. I confirm that it has no sexual or adult content: that is not allowed in online puzzles.';
    // (the link opens the terms in a page of its own: the box and the puzzle being made stay as they are)
    this.consentText.replaceChildren(said, ' ', h('a', { href: 'terms.html', target: '_blank', rel: 'noopener' }, 'Read the terms of service.'));
    this.startBtn.disabled = this.busy || !entry || tooLong || wrongKind;
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
                `${roomLabel(r.settings)} · ${r.members.map((m) => m.name).join(', ')}`,
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
    if (!entry || this.busy) return;
    if (!this.deps.identity.canCreate()) {
      this.say('Making a puzzle needs an account.');
      return;
    }
    if (!(this.consent as HTMLInputElement).checked) {
      this.say(`Tick the box to agree that the ${entry.video ? 'video' : 'picture'} is sent to the server.`);
      return;
    }
    if (entry.video) return this.startVideo(entry);
    this.setBusy(true, 'Preparing the picture…');
    let src: Awaited<ReturnType<PhotoLibrary['load']>> | null = null;
    try {
      src = await photos.load(entry);
      const id = roomKind(prefs);
      const opts = roomOpts(prefs.data.settings, id);
      const settings: RoomSettings = { kind: id as RoomSettings['kind'], seed: seedFromText(puzzleSeedText(prefs.data.seed, entry.id, id)), width: src.width, height: src.height, opts };
      this.say('Making the puzzle…');
      const kept = await this.fromKept(entry, settings);
      if (kept) return kept.ok ? this.openMade(kept.roomId, kept.invite, entry) : this.fail(kept);
      const blob = await pictureForUpload(src.source, src.width, src.height);
      const made = await api.createRoom({ settings, sourceId: entry.id, consent: true, ...(entry.credit ? { stock: true } : {}) });
      if (!made.ok) return this.fail(made);
      if (made.account) this.deps.identity.setSummary(made.account);
      if (!made.upload) return this.fail({ error: 'bad-request' });
      this.say('Sending the picture…');
      let up = await api.upload(made.upload.url, blob);
      // the server looks at the picture before it lets anyone in; if it could not (the answer is "busy") the same picture may be sent again
      for (let again = 0; again < 2 && !up.ok && up.error === 'busy'; again++) {
        this.say('Looking at the picture again…');
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        up = await api.upload(made.upload.url, blob);
      }
      if (!up.ok) return this.fail(up);
      await this.openMade(made.roomId, made.invite, entry);
    } catch (e) {
      this.setBusy(false, e instanceof Error ? e.message : 'That did not work.');
    } finally {
      src?.dispose();
    }
  }

  /**
   * Makes the puzzle from the file that the server holds for this photo, if it does (nothing is sent or looked at again). Nothing if there is no such file, or it is not held any more
   * (it is kept a week after it was last used): then the photo is sent as usual. Any other answer is the puzzle, or why it could not be made.
   */
  private async fromKept(entry: PhotoEntry, settings: RoomSettings): Promise<CreateRoomResponse | ApiFailure | Offline | null> {
    if (!entry.serverFile) return null;
    const made = await this.deps.api.createRoom({ settings, sourceId: entry.id, consent: true, fileId: entry.serverFile });
    if (!made.ok && (made.error === 'file-gone' || made.error === 'unauthorized')) {
      await this.deps.photos.setServerFile(entry.id, undefined);
      return null;
    }
    if (made.ok && made.account) this.deps.identity.setSummary(made.account);
    return made;
  }

  /** The puzzle is made and its picture is in: opens it, and remembers the id that the server keeps the picture under, so that the next puzzle from it needs no sending. */
  private async openMade(roomId: string, invite: Invite, entry: PhotoEntry): Promise<void> {
    const got = await this.deps.api.getRoom(roomId);
    if (!got.ok) return this.fail(got);
    if (got.room.media.fileId) await this.deps.photos.setServerFile(entry.id, got.room.media.fileId);
    this.setBusy(false);
    this.enter(got.room, invite);
  }

  /**
   * A puzzle from a video: the whole video goes straight to storage, the server has it looked at (all of it), and the others get the same file. The board is cut from
   * the video's own size, which every player's game finds the same.
   */
  private async startVideo(entry: PhotoEntry): Promise<void> {
    const { api, prefs, photos } = this.deps;
    this.setBusy(true, 'Preparing the video…');
    let src: Awaited<ReturnType<PhotoLibrary['load']>> | null = null;
    try {
      src = await photos.load(entry);
      const file = await (await fetch(entry.previewUrl)).blob();
      const type = videoTypeOf(file, entry.name);
      if (!(VIDEO_TYPES as readonly string[]).includes(type)) throw new Error('Online puzzles take MP4 or MOV videos (made with H.264). Others play here, but cannot be checked to share.');
      const seconds = src.video?.duration ?? 0;
      if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('This browser cannot tell how long that video is.');
      if (!this.deps.identity.isAdmin() && (seconds * 1000 > DEFAULT_LIMITS.videoMs || file.size > DEFAULT_LIMITS.videoBytes)) throw new Error(sayError('too-big'));
      if (src.width > 4096 || src.height > 4096) throw new Error('That video is too large (over 4096 pixels) for an online puzzle.');
      const id = roomKind(prefs);
      const opts = roomOpts(prefs.data.settings, id);
      const settings: RoomSettings = { kind: id as RoomSettings['kind'], seed: seedFromText(puzzleSeedText(prefs.data.seed, entry.id, id)), width: src.width, height: src.height, opts };
      this.say('Making the puzzle…');
      const kept = await this.fromKept(entry, settings);
      if (kept) return kept.ok ? this.openMade(kept.roomId, kept.invite, entry) : this.fail(kept);
      const made = await api.createRoom({ settings, sourceId: entry.id, consent: true, ...(entry.credit ? { stock: true } : {}), video: { type: type as (typeof VIDEO_TYPES)[number], bytes: file.size, ms: Math.round(seconds * 1000) } });
      if (!made.ok) return this.fail(made);
      if (made.account) this.deps.identity.setSummary(made.account);
      if (!made.upload) return this.fail({ error: 'bad-request' });
      const sent = await api.uploadVideo(made.upload.url, made.upload.headers ?? {}, file, (f) => this.say(`Sending the video… ${Math.round(f * 100)}%`));
      if (!sent.ok) return this.fail(sent);
      // the whole video is looked at by Amazon's service, which takes a minute or two: ask every few seconds how it is going
      const began = Date.now();
      let trouble = 0;
      for (;;) {
        const done = await api.finishVideo(made.roomId);
        if (done.ok) {
          if (done.state === 'ready') break;
          trouble = 0;
        } else if (['busy', 'not-ready', 'offline'].includes(done.error) && ++trouble <= 5) {
          /* the check could not be asked about this time, or the file is not in storage yet: ask again */
        } else {
          return this.fail(done);
        }
        if (Date.now() - began > CHECK_GIVE_UP_MS) {
          this.setBusy(false, 'The check of the video is taking longer than it should. It goes on: open the puzzle from your list in a few minutes.');
          return;
        }
        this.say(`Checking the video… ${Math.round((Date.now() - began) / 1000)} s (it takes a minute or two)`);
        await new Promise((resolve) => window.setTimeout(resolve, CHECK_EVERY_MS));
      }
      await this.openMade(made.roomId, made.invite, entry);
    } catch (e) {
      this.setBusy(false, e instanceof Error ? e.message : 'That did not work.');
    } finally {
      src?.dispose();
    }
  }

  private fail(r: { error: CallError; retryAt?: number; credits?: 'photo' | 'video'; reason?: AdRefusal; account?: AccountSummary }): void {
    this.setBusy(false, sayError(r.error, r));
    if (r.account) this.deps.identity.setSummary(r.account);                       // (what the server says is left, so that the displays are right)
    if (r.error === 'no-credits') this.deps.openCredits?.(r.credits ?? 'photo');
  }

  // ---------------------------------------------------------------------------------------------------------------- joining

  /** Joins with what the player typed or a link opened the game with. A code alone knocks: this waits until a member lets the player in. Needs no account: a guest is made if there is none. */
  async join(text: string): Promise<void> {
    const typed = parseInvite(text);
    if (!typed) {
      this.say('That is not a five-digit code or an invite link.');
      return;
    }
    // the link that the player came with has its secret (it needs no one to let them in) for as long as the box still holds its code
    const inv = !typed.secret && this.invite?.code === typed.code ? this.invite : typed;
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
      this.askName = true;
      this.refreshAccount();
      this.codeInput.value = inv.code;
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
