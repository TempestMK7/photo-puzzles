import type { Offline, OnlineApi } from '../online/api';
import type { ApiFailure, HelpItem } from '../online/protocol';
import type { OnlineSession } from '../online/session';
import { adPlatform, adPrivacy, prepareAds, watchAd } from '../platform';
import { h } from './dom';
import { sayError } from './online';

/** After an ad, how often the account is asked whether the hints have arrived, and how many times at most (about half a minute). */
const CHECK_EVERY_MS = 2000;
const GIVE_UP_AFTER = 15;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export interface MoreHelpDeps {
  player: OnlineSession;
  api: OnlineApi;
}

/**
 * More hints and bombs, from an ad: the "Get more" button of the play screen, which lights up when one is ready (about every half an hour, at times that the server makes random), and the little
 * window it opens, where the player chooses hints or a bomb. A free account watches an ad in the Android or iOS app for them (the server gives them when the ad network says it was watched,
 * as for credits: see `CreditsUi`); a paid account is given them for the press of the button. Nowhere else is there anything to offer (the web page, Steam and itch have no ads), so there the button
 * of a free account is not shown.
 */
export class MoreHelp {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  private readonly body = h('div', { class: 'body' });
  private open = false;
  private busy = false;
  private message = '';
  private timer = 0;
  /** What the account said last, and when it came (the wait it reports is counted from then). */
  private last: object | null = null;
  private seenAt = 0;

  constructor(private readonly deps: MoreHelpDeps) {
    this.button = h('button', { type: 'button', class: 'toggle more', 'aria-pressed': 'false', onclick: () => this.toggle() }, 'Get more');
    this.panel = h(
      'div',
      { class: 'getmore', role: 'dialog', 'aria-label': 'More hints and bombs', hidden: true },
      h('header', {}, h('h3', {}, 'More hints and bombs'), h('button', { type: 'button', class: 'small', 'aria-label': 'Close', onclick: () => this.close() }, '✕')),
      this.body,
    );
    deps.player.onChange(() => this.refresh());
    // a page that was hidden has not run its timer: the wait is looked at again when it is shown
    document.addEventListener('visibilitychange', () => !document.hidden && this.refresh(true));
    window.addEventListener('photopuzzles-ads-ready', () => this.open && this.draw());
    this.refresh();
  }

  /** There is something this player can do here: an account that is given hints and bombs without an ad, or one in an app that shows ads. */
  private available(): boolean {
    const a = this.deps.player.summary();
    return a.type !== 'guest' && (a.helpAdNoAd || !!adPlatform());
  }

  /** How many ms are left of the wait, by the time it was told and the clock of this device (which only has to run, not to agree with the server's). */
  private waitLeft(): number {
    return Math.max(0, this.deps.player.summary().helpAdIn - (Date.now() - this.seenAt));
  }

  private ready(): boolean {
    return this.available() && this.deps.player.summary().helpAdReady;
  }

  /** The button (shown, and lit when something is ready) and the window, from what the account says. `ask`: the account is asked again if the wait should be over. */
  refresh(ask = false): void {
    const a = this.deps.player.summary();
    if (a !== this.last) {
      this.last = a;
      this.seenAt = Date.now();
    }
    const here = this.available();
    const ready = here && a.helpAdReady;
    this.button.hidden = !here;
    this.button.classList.toggle('glow', ready);
    this.button.textContent = ready ? 'Get more ✦' : 'Get more';
    const minutes = Math.max(1, Math.ceil(this.waitLeft() / 60_000));
    this.button.title = ready ? (a.helpAdNoAd ? 'Free hints or a bomb are ready' : 'Watch an ad for hints or a bomb') : `The next ones are ready in about ${plural(minutes, 'minute', 'minutes')}`;
    this.button.setAttribute('aria-label', this.button.title);
    window.clearTimeout(this.timer);
    if (here && !a.helpAdReady) {
      // when the wait is over the account is asked, and if it says so the button lights up
      const ms = Math.min(Math.max(this.waitLeft(), 0) + 1500, 3_600_000);
      this.timer = window.setTimeout(() => void this.deps.player.refreshProfile(), ms);
      if (ask && this.waitLeft() <= 0) void this.deps.player.refreshProfile();
    }
    if (!here) this.close();
    else if (this.open) this.draw();
  }

  toggle(): void {
    if (this.open) return this.close();
    this.open = true;
    this.message = '';
    this.button.setAttribute('aria-pressed', 'true');
    if (adPlatform()) prepareAds();                           // (an app with ads gets ready for one)
    this.draw();
    this.panel.hidden = false;
  }

  close(): void {
    this.open = false;
    this.panel.hidden = true;
    this.button.setAttribute('aria-pressed', 'false');
  }

  private draw(): void {
    const a = this.deps.player.summary();
    const free = !a.helpAdNoAd;
    const choose = (item: HelpItem, label: string): HTMLElement => h('button', { type: 'button', class: 'primary', disabled: this.busy, onclick: () => void this.get(item) }, label);
    const ready = this.ready();
    const minutes = Math.max(1, Math.ceil(this.waitLeft() / 60_000));
    this.body.replaceChildren(
      ...(ready
        ? [
            h('p', {}, free ? 'Watch a short ad and choose what you get:' : 'Choose what you get (your account does not have to watch an ad):'),
            choose('hint', `${free ? 'Watch an ad for' : 'Take'} ${plural(a.helpAdHints, 'hint', 'hints')}`),
            choose('bomb', `${free ? 'Watch an ad for' : 'Take'} ${plural(a.helpAdBombs, 'bomb', 'bombs')}`),
            h('p', { class: 'dim' }, 'There is one about every half an hour.'),
          ]
        : [h('p', {}, `The next ones are ready in about ${plural(minutes, 'minute', 'minutes')}. There is one about every half an hour.`)]),
      ...(adPrivacy() ? [h('button', { type: 'button', class: 'small', onclick: () => adPrivacy()?.() }, 'Ad privacy choices')] : []),
      h('p', { class: 'status', role: 'status' }, this.message),
    );
  }

  /** The player chose: an ad is watched (free accounts), or the account is simply given them. */
  private async get(item: HelpItem): Promise<void> {
    if (this.busy) return;
    const { player, api } = this.deps;
    const free = !player.summary().helpAdNoAd;
    this.busy = true;
    this.message = free ? 'Getting an ad ready…' : 'Adding them…';
    this.draw();
    const failed = (out: ApiFailure | Offline): void => {
      if ('account' in out && out.account) player.setSummary(out.account);
      this.message = out.error === 'offline' ? 'Could not reach the server.' : sayError(out.error, out as ApiFailure);
    };
    const held = (): number => (item === 'hint' ? player.summary().hints : player.summary().bombs);
    try {
      if (!free) {
        const res = await api.rewardHelp(item);
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
          this.message = seen.error === 'no-ad' ? 'There is no ad to show right now. Try again in a little while.' : seen.error === 'consent' ? 'Ads need your choice about them first: see the ad privacy choices.' : 'The ad was not watched to the end, so there is nothing for it.';
          return;
        }
        this.message = 'Adding them…';
        this.draw();
        if (begun.mode === 'trusted') {
          const out = await api.claimAd({ kind: item, platform: where });
          if (!out.ok) return failed(out);
          player.setSummary(out.account);
        } else {
          // the ad network tells the server (a few seconds): the account is asked until the next ad is no longer ready, which is what the server does when it has given them
          for (let i = 0; i < GIVE_UP_AFTER && player.summary().helpAdReady && held() <= before; i++) {
            await new Promise((resolve) => window.setTimeout(resolve, CHECK_EVERY_MS));
            const me = await api.me();
            if (me.ok) player.setSummary(me.account);
          }
        }
        if (player.summary().helpAdReady && held() <= before) {
          this.message = 'They are taking longer than usual. They are added when the ad network confirms the ad: look again in a minute.';
          return;
        }
      }
      const a = player.summary();
      this.message = `You got ${item === 'hint' ? plural(a.helpAdHints, 'hint', 'hints') : plural(a.helpAdBombs, 'bomb', 'bombs')}.`;
    } finally {
      this.busy = false;
      this.refresh();
      this.draw();
    }
  }
}
