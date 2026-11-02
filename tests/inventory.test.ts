import { describe, expect, it } from 'vitest';
import { GUEST_ACCOUNT, type AccountSummary } from '../src/online/protocol';
import { explainHelp, itemsOf } from '../src/ui/inventory';

const MIN = 60_000;
const free = (more: Partial<AccountSummary> = {}): AccountSummary => ({ type: 'free', photo: 5, video: 0, photoInfinite: false, videoInfinite: false, canVideo: false, photoAdsLeft: 5, videoAdsLeft: 0, adPhoto: 5, adVideo: 1, hints: 10, bombs: 2, earnPerDay: 10, earnLeft: 7, earnInfinite: false, helpAdReady: true, helpAdIn: 0, helpAdHints: 5, helpAdBombs: 1, helpAdNoAd: false, ...more });
const paid = (more: Partial<AccountSummary> = {}) => free({ type: 'paid', photoInfinite: true, canVideo: true, video: 20, earnInfinite: true, earnLeft: 0, helpAdNoAd: true, ...more });
const text = (e: ReturnType<typeof explainHelp>) => e.paragraphs.join(' ');

describe('what the inventory lists', () => {
  it('leaves video credits out for an account that cannot start a video puzzle, a guest and a free account among them', () => {
    expect(itemsOf(free())).toEqual(['photo', 'hint', 'bomb']);
    expect(itemsOf(free({ video: 12 }))).toEqual(['photo', 'hint', 'bomb']);          // (kept, but not talked about)
    expect(itemsOf(GUEST_ACCOUNT)).toEqual(['photo', 'hint', 'bomb']);
  });

  it('lists them for paid, family and admin accounts', () => {
    expect(itemsOf(paid())).toEqual(['photo', 'video', 'hint', 'bomb']);
    expect(itemsOf(free({ type: 'admin', canVideo: true }))).toEqual(['photo', 'video', 'hint', 'bomb']);
  });
});

describe('what the inventory says about hints and bombs', () => {
  it('says what each does, and how they are earned (and no longer where they do not work)', () => {
    const hint = explainHelp('hint', free(), 'android', 0);
    expect(text(hint)).toContain('places one piece');
    expect(text(hint)).not.toContain('Sliding Tiles');
    expect(text(hint)).not.toContain('best times');
    expect(text(hint)).toContain('Solving a puzzle earns 1 hint (2 for the larger sizes)');
    expect(text(hint)).toContain('up to 10 a day: you can earn 7 more today');
    const bomb = explainHelp('bomb', free(), 'android', 0);
    expect(text(bomb)).toContain('all the pieces around a point');
    expect(text(bomb)).toContain('not earned by solving puzzles');
  });

  it('says that a paid account can earn as many hints as it solves', () => {
    expect(text(explainHelp('hint', paid(), 'android', 5 * MIN))).toContain('as many as it solves');
  });

  it('offers a free account in an app an ad when one is ready, for the hints or the bomb it chose', () => {
    expect(explainHelp('hint', free(), 'android', 0).ad?.label).toBe('Watch an ad for 5 hints');
    expect(explainHelp('bomb', free(), 'ios', 0).ad?.label).toBe('Watch an ad for 1 bomb');
    expect(text(explainHelp('bomb', free(), 'ios', 0))).toContain('Every 20 to 30 minutes you can watch an ad for 5 hints or 1 bomb');
  });

  it('offers no ad until the wait is over, and does not say when the next will be', () => {
    const e = explainHelp('hint', free({ helpAdReady: false, helpAdIn: 12 * MIN }), 'android', 12 * MIN - 1);
    expect(e.ad).toBeUndefined();
    expect(text(e)).not.toContain('ready in');
    expect(text(e)).toContain('Every 20 to 30 minutes');
  });

  it('gives a paid account what an ad would, with no ad, in an app or not', () => {
    for (const where of ['android', 'web', 'steam'] as const) {
      const e = explainHelp('hint', paid(), where, 0);
      expect(e.ad, where).toEqual({ label: 'Take 5 hints', note: 'ready now' });
      expect(text(e)).toContain('you can take 5 hints or 1 bomb');
      expect(text(e)).not.toContain('Android and iOS apps');
    }
    expect(explainHelp('bomb', paid(), 'web', 3 * MIN).ad).toBeUndefined();
  });

  it('sends a free account on Steam, itch or the web to the mobile apps for ads (or to a paid account), and offers no ad', () => {
    for (const where of ['web', 'steam', 'itch'] as const) {
      const e = explainHelp('bomb', free(), where, 0);
      expect(e.ad).toBeUndefined();
      expect(text(e)).toContain('install the app and log in on a mobile device');
      expect(text(e)).toContain('Android and iOS apps');
      expect(text(e)).toContain('upgrade to a paid account to get them here without watching ads');
    }
  });

  it('treats a guest as a free account for ads (and says what making an account adds)', () => {
    const guest = free({ type: 'guest', photoAdsLeft: 0, adPhoto: 0, hints: 5, bombs: 1, earnPerDay: 0, earnLeft: 0 });
    for (const item of ['hint', 'bomb'] as const) {
      const e = explainHelp(item, guest, 'android', 0);
      expect(e.ad?.label).toBe(item === 'hint' ? 'Watch an ad for 5 hints' : 'Watch an ad for 1 bomb');
      expect(text(e)).toContain('10 more hints and 2 more bombs');
      expect(explainHelp(item, guest, 'web', 0).ad).toBeUndefined();
      expect(text(explainHelp(item, guest, 'web', 0))).toContain('upgrade to a paid account');
    }
    expect(text(explainHelp('hint', guest, 'android', 0))).toContain('earn hints by solving puzzles');
    expect(text(explainHelp('bomb', guest, 'android', 0))).not.toContain('earn hints by solving puzzles');
  });

  it('gives the operator no more than anyone else: the hints are counted, and an ad (or none) is theirs every so often', () => {
    const e = explainHelp('hint', free({ type: 'admin', helpAdNoAd: true }), 'android', 0);
    expect(text(e)).not.toContain('never used up');
    expect(e.ad?.label).toBe('Take 5 hints');
  });
});
