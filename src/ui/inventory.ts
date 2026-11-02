import type { Offline, OnlineApi } from '../online/api';
import { ACCOUNT_NAMES, DEFAULT_LIMITS, type AccountSummary, type AdKind, type ApiFailure, type HelpItem } from '../online/protocol';
import type { OnlineSession } from '../online/session';
import { adPlatform, adPrivacy, platform, prepareAds, watchAd, type Platform } from '../platform';
import { creditText, explainCredits, type CreditsExplanation } from './credits';
import { h, svg } from './dom';
import { sayError } from './online';

/** What the inventory lists: the credits that starting a puzzle for friends costs, and the hints and bombs that a puzzle uses. */
export type InventoryItem = AdKind;

/** The items this account is shown, in order: nobody who cannot start a video puzzle is told about video credits. */
export function itemsOf(a: AccountSummary): InventoryItem[] {
  return a.canVideo ? ['photo', 'video', 'hint', 'bomb'] : ['photo', 'hint', 'bomb'];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** How long, in words, until the next ad for hints or a bomb. */
const inMinutes = (ms: number): string => `about ${plural(Math.max(1, Math.ceil(ms / 60_000)), 'minute', 'minutes')}`;

/**
 * What the inventory says about hints or bombs: what they do and where they work, how to get more (solving puzzles, and an ad every so often, which a paid account is given without
 * watching), and the button for the ad when one is ready. `waitMs` is how long the player has to wait for the next one. Ads are only in the Android and iOS apps: elsewhere it says so.
 */
export function explainHelp(item: HelpItem, a: AccountSummary, where: Platform, waitMs: number): CreditsExplanation {
  const hint = item === 'hint';
  const title = hint ? 'Hints' : 'Bombs';
  const does = hint
    ? 'A hint places one piece of a puzzle where it belongs. Choose Hint at the top of the puzzle, then tap the piece.'
    : 'A bomb places all the pieces around a point you choose. Choose Bomb at the top of the puzzle, then tap the board.';
  const only = 'They do not work in Sliding Tiles or Rotascope, and in a puzzle with friends only when the host allows them. They do not change best times.';

  if (a.type === 'guest') {
    return { title, paragraphs: [does, only, `Guests have none. Sign in to start with ${DEFAULT_LIMITS.startHints} hints and ${DEFAULT_LIMITS.startBombs} bombs, and to earn more.`], signIn: true };
  }
  if (hint ? a.hintsInfinite : a.bombsInfinite) return { title, paragraphs: [does, only, 'Your account has as many as it needs: they are never used up.'] };

  const paragraphs = [does, only];
  if (hint) {
    paragraphs.push(
      `Solving a puzzle earns 1 hint (2 for the larger sizes). ${a.earnInfinite ? 'Your account can earn as many as it solves.' : `A free account can earn up to ${a.earnPerDay} a day: you can earn ${a.earnLeft} more today.`}`,
    );
  } else paragraphs.push('Bombs are not earned by solving puzzles: you get them from ads.');

  const give = plural(hint ? a.helpAdHints : a.helpAdBombs, item, `${item}s`);
  const every = `Every 20 to 30 minutes you can ${a.helpAdNoAd ? 'take' : 'watch an ad for'} ${plural(a.helpAdHints, 'hint', 'hints')} or ${plural(a.helpAdBombs, 'bomb', 'bombs')}, whichever you choose.`;
  if (!a.helpAdNoAd && where !== 'android' && where !== 'ios') {
    paragraphs.push('The ads for them can only be watched in the Android and iOS apps (there are none on Steam, itch or the web page), and what you get there is yours here too.');
    return { title, paragraphs };
  }
  paragraphs.push(every);
  if (waitMs > 0) {
    paragraphs.push(`The next ones are ready in ${inMinutes(waitMs)}.`);
    return { title, paragraphs };
  }
  return { title, paragraphs, ad: { label: a.helpAdNoAd ? `Take ${give}` : `Watch an ad for ${give}`, note: 'ready now' } };
}

/** After an ad, how often the account is asked whether what it earned has arrived, and how many times at most (about half a minute). */
const CHECK_EVERY_MS = 2000;
const GIVE_UP_AFTER = 15;

const ICONS: Record<InventoryItem | 'bag', string> = {
  photo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  video: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  hint: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
  bomb: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="14" r="7"/><path d="M16 8l2-2M18 3v2M21 6h-2"/></svg>',
  bag: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7V5a4 4 0 0 1 8 0v2"/><path d="M5 7h14l1 13H4z"/><path d="M9 12h6"/></svg>',
};

const NAMES: Record<InventoryItem, string> = { photo: 'Photo credits', video: 'Video credits', hint: 'Hints', bomb: 'Bombs' };

export interface InventoryDeps {
  identity: OnlineSession;
  api: OnlineApi;
  /** Asks the player to sign in or make an account (the pop-up for it); true when they have. */
  signIn(): Promise<boolean>;
}

/**
 * The inventory: one button (for the main screen and for the play screen) and the dialog it opens, which lists what the account holds (photo credits, video credits for those who can start
 * a video puzzle, hints, bombs) with what each is for and how to get more. In the mobile apps it also plays the ads for them, and for a paid account it gives what an ad would. The
 * button glows while an ad for hints or a bomb can be had (about every 20 to 30 minutes, at a time the server chooses).
 */
export class InventoryUi {
  /** The dialog (put it in the page once). */
  readonly dialog: HTMLElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly body = h('div', { class: 'body' });
  private open = false;
  private focus: InventoryItem | null = null;
  private busy: InventoryItem | null = null;
  private message: { item: InventoryItem; text: string } | null = null;
  private timer = 0;
  /** What the account said last, and when it came (the wait it reports is counted from then). */
  private last: object | null = null;
  private seenAt = 0;

  constructor(private readonly deps: InventoryDeps) {
    this.dialog = h(
      'div',
      { class: 'inprogress inventory-dialog', role: 'dialog', 'aria-label': 'Inventory', hidden: true, onclick: (e: Event) => (e.target === this.dialog ? this.close() : undefined) },
      h('div', { class: 'card' }, h('header', {}, h('h2', {}, 'Inventory'), h('button', { type: 'button', onclick: () => this.close() }, 'Close')), this.body),
    );
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.open && this.close());
    window.addEventListener('photopuzzles-ads-ready', () => this.open && this.draw());          // (the app knows now whether the player has choices about ads to make)
    // a page that was hidden has not run its timer: the wait is looked at again when it is shown
    document.addEventListener('visibilitychange', () => !document.hidden && this.refresh(true));
    deps.identity.onChange(() => this.refresh());
  }

  /** A button that opens the inventory (one for each screen that has one: they all glow together). */
  button(): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'inventory-btn', onclick: () => this.show() }, svg(ICONS.bag, 'ico'), h('span', { class: 'label' }, 'Inventory'));
    this.buttons.push(b);
    this.refresh();
    return b;
  }

  /** There is an ad for hints or bombs that this player can watch (or, for a paid account, take) when it is ready: an account in an app that shows ads, or one that is given them without an ad. */
  private available(): boolean {
    const a = this.deps.identity.summary();
    return a.type !== 'guest' && (a.helpAdNoAd || !!adPlatform());
  }

  /** How many ms are left of the wait, by the time it was told and the clock of this device (which only has to run, not to agree with the server's). */
  private waitLeft(): number {
    return Math.max(0, this.deps.identity.summary().helpAdIn - (Date.now() - this.seenAt));
  }

  /** The buttons (lit while an ad for hints or a bomb is ready) and the open dialog, from what the account says. `ask`: the account is asked again if the wait should be over. */
  refresh(ask = false): void {
    const a = this.deps.identity.summary();
    if (a !== this.last) {
      this.last = a;
      this.seenAt = Date.now();
    }
    const here = this.available();
    const ready = here && a.helpAdReady;
    const title = ready ? (a.helpAdNoAd ? 'Inventory: free hints or a bomb are ready to take' : 'Inventory: you can watch an ad for hints or a bomb') : 'Inventory: your credits, hints and bombs';
    for (const b of this.buttons) {
      b.classList.toggle('glow', ready);
      b.title = title;
      b.setAttribute('aria-label', title);
    }
    window.clearTimeout(this.timer);
    if (here && !a.helpAdReady) {
      // when the wait is over the account is asked, and if it says so the buttons light up
      const ms = Math.min(this.waitLeft() + 1500, 3_600_000);
      this.timer = window.setTimeout(() => void this.deps.identity.refreshProfile(), ms);
      if (ask && this.waitLeft() <= 0) void this.deps.identity.refreshProfile();
    }
    if (this.open) this.draw();
  }

  /** Opens the dialog; `item` is the one the player is told about first (the credits that a puzzle needed and the account has not got, say). */
  show(item?: InventoryItem): void {
    this.open = true;
    this.focus = item ?? null;
    this.message = null;
    if (adPlatform()) prepareAds();                       // (an app with ads gets ready for one: nothing has talked to the ad network until now)
    this.draw();
    this.dialog.hidden = false;
    if (item) this.body.querySelector<HTMLElement>(`[data-item="${item}"]`)?.scrollIntoView({ block: 'nearest' });
    this.dialog.querySelector<HTMLElement>('button')?.focus();
  }

  close(): void {
    this.open = false;
    this.dialog.hidden = true;
  }

  private draw(): void {
    const a = this.deps.identity.summary();
    const where = platform();
    const wait = this.waitLeft();
    const held: Record<InventoryItem, string> = {
      photo: creditText(a.photo, a.photoInfinite),
      video: creditText(a.video, a.videoInfinite),
      hint: creditText(a.hints, a.hintsInfinite),
      bomb: creditText(a.bombs, a.bombsInfinite),
    };
    const items = itemsOf(a);
    const sections = items.map((item) => {
      const say = item === 'photo' || item === 'video' ? explainCredits(item, a, where) : explainHelp(item, a, where, wait);
      return h(
        'section',
        { class: `inv-item${item === this.focus ? ' focus' : ''}`, dataset: { item } },
        h('div', { class: 'head' }, svg(ICONS[item], 'ico'), h('h3', {}, NAMES[item]), h('span', { class: 'count' }, held[item])),
        ...say.paragraphs.map((p) => h('p', {}, p)),
        ...(say.ad
          ? [h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', disabled: this.busy !== null, onclick: () => void this.get(item) }, say.ad.label), h('span', { class: 'dim' }, say.ad.note))]
          : []),
        h('p', { class: 'status', role: 'status' }, this.message?.item === item ? this.message.text : ''),
      );
    });
    this.body.replaceChildren(
      h('p', { class: 'who' }, a.type === 'guest' ? 'Not signed in' : `${ACCOUNT_NAMES[a.type]} account`),
      ...(a.type === 'guest' ? [h('button', { type: 'button', class: 'primary', onclick: () => void this.signIn() }, 'Sign in or create an account')] : []),
      ...sections,
      ...(adPrivacy() ? [h('button', { type: 'button', class: 'small', onclick: () => adPrivacy()?.() }, 'Ad privacy choices')] : []),
    );
  }

  private async signIn(): Promise<void> {
    if (await this.deps.signIn()) this.close();
  }

  private say(item: InventoryItem, text: string): void {
    this.message = { item, text };
    this.draw();
  }

  /**
   * The player pressed the button of an item. A paid account is simply given the hints or the bomb. Otherwise an ad is played in the app. The server is asked first (an ad that would earn
   * nothing is not shown, and it gives the number that the ad network will report the ad under); then what it is worth comes from the ad network's report to the server, which can take a few
   * seconds, so the account is asked about until it is there. (Where the operator takes the game's word, for trying things out, the game asks for it itself.)
   */
  private async get(item: InventoryItem): Promise<void> {
    if (this.busy) return;
    const { identity: player, api } = this.deps;
    const help = item === 'hint' || item === 'bomb' ? item : null;
    const free = !player.summary().helpAdNoAd;
    const held = (): number => {
      const a = player.summary();
      return { photo: a.photo, video: a.video, hint: a.hints, bomb: a.bombs }[item];
    };
    const worth = (): string => {
      const a = player.summary();
      return { photo: plural(a.adPhoto, 'photo credit', 'photo credits'), video: plural(a.adVideo, 'video credit', 'video credits'), hint: plural(a.helpAdHints, 'hint', 'hints'), bomb: plural(a.helpAdBombs, 'bomb', 'bombs') }[item];
    };
    const failed = (out: ApiFailure | Offline): void => {
      if ('account' in out && out.account) player.setSummary(out.account);
      this.message = { item, text: out.error === 'offline' ? 'Could not reach the server.' : sayError(out.error, out as ApiFailure) };
    };
    this.busy = item;
    this.say(item, help && !free ? 'Adding them…' : 'Getting an ad ready…');
    try {
      if (help && !free) {
        const res = await api.rewardHelp(help);
        if (!res.ok) return failed(res);
        player.setSummary(res.account);
      } else {
        const where = adPlatform();
        if (!where) return;
        const before = held();
        const begun = await api.adStart({ kind: item, platform: where });
        if (!begun.ok) return failed(begun);
        const seen = await watchAd(item, begun.nonce);
        if (!seen.rewarded) {
          this.message = {
            item,
            text:
              seen.error === 'no-ad'
                ? 'There is no ad to show right now. Try again in a little while.'
                : seen.error === 'consent'
                  ? 'Ads need your choice about them first: see the ad privacy choices.'
                  : `The ad was not watched to the end, so there ${help ? 'is nothing' : 'are no credits'} for it.`,
          };
          return;
        }
        this.say(item, 'Adding them…');
        if (begun.mode === 'trusted') {
          const out = await api.claimAd({ kind: item, platform: where });
          if (!out.ok) return failed(out);
          player.setSummary(out.account);
        } else {
          for (let i = 0; i < GIVE_UP_AFTER && held() <= before; i++) {
            await new Promise((resolve) => window.setTimeout(resolve, CHECK_EVERY_MS));
            const me = await api.me();
            if (me.ok) player.setSummary(me.account);
          }
        }
        if (held() <= before) {
          this.message = { item, text: 'They are taking longer than usual. They are added when the ad network confirms the ad: look again in a minute.' };
          return;
        }
      }
      this.message = { item, text: `You got ${worth()}.` };
    } finally {
      this.busy = null;
      this.refresh();
    }
  }
}
