import type { OnlineApi } from '../online/api';
import { ACCOUNT_NAMES, DEFAULT_LIMITS, type AccountSummary, type ApiFailure } from '../online/protocol';
import type { OnlineSession } from '../online/session';
import { adPlatform, platform, watchAd, type Platform } from '../platform';
import { h, svg } from './dom';
import { sayError } from './online';

export type CreditKind = 'photo' | 'video';

/** What a number of credits looks like: the infinity sign when the account does not spend them. */
export const creditText = (n: number, infinite: boolean): string => (infinite ? '∞' : String(n));

export interface CreditsExplanation {
  title: string;
  paragraphs: string[];
  /** The button that plays an ad for credits. `enabled`: the account may watch one now. */
  ad?: { label: string; note: string };
  /** The dialog offers to sign in or make an account (a guest has no credits to speak of). */
  signIn?: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What the dialog says about one kind of credit, for the account as it stands and the place the game is running in. Ads are only in the Android and iOS apps: on Steam, itch and the web page
 * the dialog says where they can be watched instead (the credits are the account's, so they work everywhere).
 */
export function explainCredits(kind: CreditKind, a: AccountSummary, where: Platform): CreditsExplanation {
  const photo = kind === 'photo';
  const held = photo ? a.photo : a.video;
  const left = photo ? a.photoAdsLeft : a.videoAdsLeft;
  const give = photo ? a.adPhoto : a.adVideo;
  const unit = photo ? 'photo' : 'video';
  const lead = photo
    ? 'Playing on your own is always free and unlimited, and so is joining a friend’s puzzle. A photo credit pays for starting a multiplayer puzzle from a picture.'
    : 'Playing a video on your own is always free and unlimited, and so is joining a friend’s video puzzle. A video credit pays for starting a multiplayer puzzle from a video.';
  const title = photo ? 'Photo credits' : 'Video credits';
  const mobile = where === 'android' || where === 'ios';
  const outside = 'Ads can only be watched in the Android and iOS apps (Steam, itch and the web page have none). Install the game on your phone and sign in with this account: the credits you get there are yours here too.';

  if (a.type === 'guest') {
    return {
      title,
      paragraphs: [lead, photo ? `Guests can join any puzzle but cannot start one. Make an account to start puzzles: a free account starts with ${DEFAULT_LIMITS.freePhotoCredits} photo credits.` : 'Guests cannot start puzzles. Video puzzles are for paid accounts.'],
      signIn: true,
    };
  }
  if (photo ? a.photoInfinite : a.videoInfinite) {
    return { title, paragraphs: [lead, a.type === 'paid' ? 'Your account starts as many puzzles from pictures as you like, so photo credits are never used up.' : 'Your account starts puzzles from pictures and videos without using credits.'] };
  }

  const paragraphs = [lead];
  if (photo) paragraphs.push(`Each puzzle you start from a picture costs 1 photo credit. You have ${held}. Credits never expire: they stay until you use them.`);
  else if (a.type === 'paid') paragraphs.push(`Each puzzle you start from a video costs 1 video credit. You have ${held}. A paid account gets ${DEFAULT_LIMITS.paidVideoCredits} video credits for each payment period, and credits you do not use carry over for ever.`);
  else paragraphs.push(`Video puzzles are for paid accounts. You have ${held} video credits: they are kept, and can be used again if your account becomes a paid one.`);

  // ads: a free account gets photo credits and a paid account video credits (the server decides: this only says what it will do)
  const eligible = photo ? a.type === 'free' : a.type === 'paid';
  if (!eligible) return { title, paragraphs };
  if (!mobile) {
    paragraphs.push(outside);
    return { title, paragraphs };
  }
  if (held > 0) {
    paragraphs.push(`When you have none left you can watch an ad for ${plural(give, `${unit} credit`, `${unit} credits`)} (${plural(left, 'ad', 'ads')} left today).`);
    return { title, paragraphs };
  }
  if (left < 1) {
    paragraphs.push('You have watched all of today’s ads. You can watch more tomorrow.');
    return { title, paragraphs };
  }
  return { title, paragraphs, ad: { label: `Watch an ad for ${plural(give, `${unit} credit`, `${unit} credits`)}`, note: `${plural(left, 'ad', 'ads')} left today` } };
}

const ICONS: Record<CreditKind, string> = {
  photo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  video: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
};

export interface CreditsDeps {
  identity: OnlineSession;
  api: OnlineApi;
  /** Asks the player to sign in or make an account (the pop-up for it); true when they have. */
  signIn(): Promise<boolean>;
}

/**
 * The two credit counters at the top of the main screen (photo credits and video credits: a number, or the infinity sign when the account does not spend them), and the dialog that
 * either one opens, which says how they work and, in the mobile apps, lets a player with none left watch an ad for more.
 */
export class CreditsUi {
  /** The two counters, for the top bar. */
  readonly el: HTMLElement;
  /** The dialog (put it in the page once). */
  readonly dialog: HTMLElement;
  private readonly counters: Record<CreditKind, HTMLElement>;
  private readonly body = h('div', { class: 'body' });
  private readonly title = h('h2', {}, '');
  private open: CreditKind | null = null;
  private busy = false;
  private message = '';

  constructor(private readonly deps: CreditsDeps) {
    const counter = () => h('span', { class: 'n' }, '0');
    this.counters = { photo: counter(), video: counter() };
    const pill = (kind: CreditKind) =>
      h('button', { type: 'button', class: `credit ${kind}`, onclick: () => this.show(kind) }, svg(ICONS[kind], 'ico'), this.counters[kind]);
    this.el = h('div', { class: 'credits', role: 'group', 'aria-label': 'Your credits' }, pill('photo'), pill('video'));
    this.dialog = h(
      'div',
      { class: 'inprogress credits-dialog', role: 'dialog', 'aria-label': 'Credits', hidden: true, onclick: (e: Event) => (e.target === this.dialog ? this.close() : undefined) },
      h('div', { class: 'card' }, h('header', {}, this.title, h('button', { type: 'button', onclick: () => this.close() }, 'Close')), this.body),
    );
    document.addEventListener('keydown', (e) => e.key === 'Escape' && !this.dialog.hidden && this.close());
    deps.identity.onChange(() => this.refresh());
    this.refresh();
  }

  /** Draws the counters (and the open dialog) again from what the session knows. */
  refresh(): void {
    const a = this.deps.identity.summary();
    for (const kind of ['photo', 'video'] as const) {
      const text = creditText(kind === 'photo' ? a.photo : a.video, kind === 'photo' ? a.photoInfinite : a.videoInfinite);
      this.counters[kind].textContent = text;
      const button = this.counters[kind].parentElement!;
      button.title = `${kind === 'photo' ? 'Photo' : 'Video'} credits: ${text === '∞' ? 'no limit' : text}. Press to see how they work.`;
      button.setAttribute('aria-label', button.title);
    }
    if (this.open) this.draw();
  }

  show(kind: CreditKind): void {
    this.open = kind;
    this.message = '';
    this.draw();
    this.dialog.hidden = false;
    this.dialog.querySelector<HTMLElement>('button')?.focus();
  }

  close(): void {
    this.open = null;
    this.dialog.hidden = true;
  }

  private draw(): void {
    const kind = this.open;
    if (!kind) return;
    const a = this.deps.identity.summary();
    const say = explainCredits(kind, a, platform());
    this.title.textContent = say.title;
    this.body.replaceChildren(
      h('p', { class: 'who' }, `${ACCOUNT_NAMES[a.type]} account`),
      ...say.paragraphs.map((p) => h('p', {}, p)),
      ...(say.signIn ? [h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in or create an account')] : []),
      ...(say.ad
        ? [h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', disabled: this.busy, onclick: () => void this.watch(kind) }, say.ad.label), h('span', { class: 'dim' }, say.ad.note))]
        : []),
      h('p', { class: 'status', role: 'status' }, this.message),
    );
  }

  private async signIn(): Promise<void> {
    if (await this.deps.signIn()) this.close();
  }

  /** Plays an ad in the app, and asks the server for the credits it is worth. */
  private async watch(kind: CreditKind): Promise<void> {
    const where = adPlatform();
    if (!where || this.busy) return;
    this.busy = true;
    this.message = 'Playing the ad…';
    this.draw();
    try {
      const seen = await watchAd(kind);
      if (!seen.rewarded) {
        this.message = 'The ad was not watched to the end, so there are no credits for it.';
        return;
      }
      this.message = 'Adding your credits…';
      this.draw();
      const out = await this.deps.api.claimAd({ kind, platform: where, ...(seen.proof ? { proof: seen.proof } : {}) });
      if (out.ok) {
        this.deps.identity.setSummary(out.account);
        const give = kind === 'photo' ? out.account.adPhoto : out.account.adVideo;
        this.message = `You got ${plural(give, `${kind} credit`, `${kind} credits`)}.`;
      } else {
        if ('account' in out && out.account) this.deps.identity.setSummary(out.account);
        this.message = sayError(out.error, out as ApiFailure);
      }
    } finally {
      this.busy = false;
      this.draw();
    }
  }
}
