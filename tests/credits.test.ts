import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUEST_ACCOUNT, type AccountSummary } from '../src/online/protocol';
import { OnlineSession } from '../src/online/session';
import { adPlatform, adPrivacy, browserSignIn, openSignIn, platform, prepareAds, takeSignIn, watchAd } from '../src/platform';
import { creditText, explainCredits } from '../src/ui/credits';
import { costNote, sayError } from '../src/ui/online';

afterEach(() => vi.useRealTimers());

const summary = (more: Partial<AccountSummary> = {}): AccountSummary => ({ type: 'free', photo: 5, video: 0, photoInfinite: false, videoInfinite: false, canVideo: false, photoAdsLeft: 5, videoAdsLeft: 0, adPhoto: 5, adVideo: 1, hints: 10, bombs: 2, hintsInfinite: false, bombsInfinite: false, earnPerDay: 10, earnLeft: 10, earnInfinite: false, ...more });
const paid = (more: Partial<AccountSummary> = {}) => summary({ type: 'paid', photoInfinite: true, canVideo: true, photoAdsLeft: 0, videoAdsLeft: 5, video: 20, ...more });
const text = (e: ReturnType<typeof explainCredits>) => e.paragraphs.join(' ');

describe('where the game is running', () => {
  it('is an app when the shell is there (Android unless it says iOS), a Steam or itch build when built so, and the web otherwise', () => {
    expect(platform({}, undefined)).toBe('android');
    expect(platform({ platform: () => 'ios' }, undefined)).toBe('ios');
    expect(platform({ platform: () => 'android' }, 'steam')).toBe('android');
    expect(platform(undefined, 'steam')).toBe('steam');
    expect(platform(undefined, 'itch')).toBe('itch');
    expect(platform(undefined, undefined)).toBe('web');
    expect(platform(undefined, 'xbox')).toBe('web');
  });

  it('can show an ad only in an app whose shell can', () => {
    expect(adPlatform({ showRewardedAd: () => undefined }, undefined)).toBe('android');
    expect(adPlatform({ platform: () => 'ios', showRewardedAd: () => undefined }, undefined)).toBe('ios');
    expect(adPlatform({}, undefined)).toBeNull();                                  // an app with no ads in it yet
    expect(adPlatform(undefined, 'steam')).toBeNull();
    expect(adPlatform(undefined, undefined)).toBeNull();
  });
});

describe('signing in through the phone’s browser', () => {
  it('is possible only where the shell can both open the page and hand the player’s way back over', () => {
    expect(browserSignIn({ openSignIn: () => undefined, takeSignIn: () => '' })).toBe(true);
    expect(browserSignIn({ openSignIn: () => undefined })).toBe(false);
    expect(browserSignIn({})).toBe(false);
    expect(browserSignIn(undefined)).toBe(false);
  });

  it('opens an address, and takes the address that the player came back with (nothing when there is none, or the shell fails)', () => {
    const opened: string[] = [];
    openSignIn('https://pool.auth.example/oauth2/authorize?x=1', { openSignIn: (u) => opened.push(u) });
    expect(opened).toEqual(['https://pool.auth.example/oauth2/authorize?x=1']);
    expect(() => openSignIn('https://x', {})).not.toThrow();
    expect(takeSignIn({ takeSignIn: () => 'com.tempest.photopuzzles://signed-in?code=c&state=s' })).toBe('com.tempest.photopuzzles://signed-in?code=c&state=s');
    expect(takeSignIn({ takeSignIn: () => '' })).toBe('');
    expect(takeSignIn({})).toBe('');
    expect(takeSignIn({ takeSignIn: () => { throw new Error('gone'); } })).toBe('');
  });
});

describe('watching an ad', () => {
  /** The window as far as the ad goes: the shell's event, sent when the test says. */
  function windowOf() {
    const listeners = new Set<(e: unknown) => void>();
    return {
      target: { addEventListener: (_: string, fn: (e: unknown) => void) => listeners.add(fn), removeEventListener: (_: string, fn: (e: unknown) => void) => listeners.delete(fn) } as never,
      send: (detail: unknown) => [...listeners].forEach((fn) => fn({ detail })),
      count: () => listeners.size,
    };
  }

  it('asks the shell for the ad, with the number the server gave for it, and waits for its word', async () => {
    const asked: string[][] = [];
    const w = windowOf();
    const result = watchAd('photo', 'n-123', { showRewardedAd: (k, n) => asked.push([k, n]) }, w.target);
    expect(asked).toEqual([['photo', 'n-123']]);
    w.send({ kind: 'video', rewarded: true });                                      // (another kind: not ours)
    w.send({ kind: 'photo', rewarded: true });
    expect(await result).toEqual({ rewarded: true });
    expect(w.count()).toBe(0);
  });

  it('says why there was no ad to watch', async () => {
    for (const error of ['no-ad', 'consent']) {
      const w = windowOf();
      const result = watchAd('photo', 'n', { showRewardedAd: () => undefined }, w.target);
      w.send({ kind: 'photo', rewarded: false, error });
      expect(await result).toEqual({ rewarded: false, error });
    }
    const w = windowOf();
    const result = watchAd('photo', 'n', { showRewardedAd: () => undefined }, w.target);
    w.send({ kind: 'photo', rewarded: false, error: 'something else' });
    expect(await result).toEqual({ rewarded: false });
  });

  it('lets the app get ready for an ad only when the page asks, and not where there is nothing to get ready', () => {
    const asked: string[] = [];
    prepareAds({ prepareAds: () => asked.push('ready') });
    expect(asked).toEqual(['ready']);
    expect(() => prepareAds({})).not.toThrow();
    expect(() => prepareAds({ prepareAds: () => { throw new Error('no'); } })).not.toThrow();
  });

  it('offers the player\u2019s choices about ads only where the shell says the law asks for them', () => {
    const shown: string[] = [];
    expect(adPrivacy({ privacyOptionsRequired: () => false, showPrivacyOptions: () => undefined })).toBeNull();
    expect(adPrivacy({ privacyOptionsRequired: () => true })).toBeNull();
    expect(adPrivacy({})).toBeNull();
    expect(adPrivacy({ privacyOptionsRequired: () => { throw new Error('no'); }, showPrivacyOptions: () => undefined })).toBeNull();
    adPrivacy({ privacyOptionsRequired: () => true, showPrivacyOptions: () => shown.push('shown') })?.();
    expect(shown).toEqual(['shown']);
  });

  it('gives nothing for an ad that was not watched to the end, or one that cannot be shown', async () => {
    const w = windowOf();
    const result = watchAd('video', 'n', { showRewardedAd: () => undefined }, w.target);
    w.send({ kind: 'video', rewarded: false });
    expect(await result).toEqual({ rewarded: false });
    expect(await watchAd('photo', 'n', {}, w.target)).toEqual({ rewarded: false });
    expect(await watchAd('photo', 'n', { showRewardedAd: () => { throw new Error('no ad'); } }, w.target)).toEqual({ rewarded: false });
    expect(w.count()).toBe(0);
  });

  it('stops waiting for a shell that never says', async () => {
    vi.useFakeTimers();
    const w = windowOf();
    const result = watchAd('photo', 'n', { showRewardedAd: () => undefined }, w.target);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(await result).toEqual({ rewarded: false });
    expect(w.count()).toBe(0);
  });
});

describe('what the credit dialogs say', () => {
  it('shows a number, or the infinity sign for what is not spent', () => {
    expect(creditText(5, false)).toBe('5');
    expect(creditText(0, false)).toBe('0');
    expect(creditText(123, true)).toBe('∞');
  });

  it('tells a guest to make an account, and offers to sign in', () => {
    for (const kind of ['photo', 'video'] as const) {
      const e = explainCredits(kind, GUEST_ACCOUNT, 'android');
      expect(e.signIn).toBe(true);
      expect(e.ad).toBeUndefined();
      expect(text(e)).toContain('Guests');
    }
    expect(text(explainCredits('photo', GUEST_ACCOUNT, 'web'))).toContain('starts with 5 photo credits');
  });

  it('says what a photo credit does, that it never expires, and, with none left in an app, offers an ad', () => {
    const some = explainCredits('photo', summary({ photo: 3 }), 'android');
    expect(text(some)).toContain('costs 1 photo credit');
    expect(text(some)).toContain('You have 3');
    expect(text(some)).toContain('never expire');
    expect(some.ad).toBeUndefined();                                                // only when there are none left
    expect(text(some)).toContain('(5 ads left today)');
    const none = explainCredits('photo', summary({ photo: 0, photoAdsLeft: 3 }), 'ios');
    expect(none.ad).toEqual({ label: 'Watch an ad for 5 photo credits', note: '3 ads left today' });
    const used = explainCredits('photo', summary({ photo: 0, photoAdsLeft: 0 }), 'android');
    expect(used.ad).toBeUndefined();
    expect(text(used)).toContain('tomorrow');
  });

  it('sends a player on Steam, itch or the web to the mobile apps for ads, and says the credits work everywhere', () => {
    for (const where of ['steam', 'itch', 'web'] as const) {
      for (const held of [0, 4]) {
        const e = explainCredits('photo', summary({ photo: held }), where);
        expect(e.ad, `${where} ${held}`).toBeUndefined();
        expect(text(e)).toContain('Android and iOS apps');
        expect(text(e)).toContain('yours here too');
      }
    }
  });

  it('says that a paid account has no limit on pictures, and gives it video credits and ads for them in an app', () => {
    expect(text(explainCredits('photo', paid(), 'android'))).toContain('as many puzzles from pictures as you like');
    const v = explainCredits('video', paid({ video: 4 }), 'android');
    expect(text(v)).toContain('20 video credits for each payment period');
    expect(text(v)).toContain('carry over for ever');
    expect(v.ad).toBeUndefined();
    expect(explainCredits('video', paid({ video: 0 }), 'android').ad).toEqual({ label: 'Watch an ad for 1 video credit', note: '5 ads left today' });
    expect(explainCredits('video', paid({ video: 0 }), 'steam').ad).toBeUndefined();
    expect(text(explainCredits('video', paid({ video: 0 }), 'steam'))).toContain('Android and iOS apps');
  });

  it('says that a free account cannot start video puzzles but keeps its video credits, and offers it no ad for them', () => {
    const e = explainCredits('video', summary({ video: 12 }), 'android');
    expect(text(e)).toContain('Video puzzles are for paid accounts');
    expect(text(e)).toContain('You have 12 video credits');
    expect(e.ad).toBeUndefined();
  });

  it('says that the family and the operator use no credits, and offers them no ads', () => {
    for (const type of ['family', 'admin'] as const) {
      for (const kind of ['photo', 'video'] as const) {
        const e = explainCredits(kind, summary({ type, photoInfinite: true, videoInfinite: true, canVideo: true, photoAdsLeft: 0, videoAdsLeft: 0 }), 'android');
        expect(text(e)).toContain('without using credits');
        expect(e.ad).toBeUndefined();
      }
    }
  });
});

describe('what starting a puzzle is said to cost', () => {
  it('says what it costs, or that it costs nothing, or that a free account cannot', () => {
    expect(costNote(false, summary({ photo: 5 }))).toBe('Starting it costs 1 photo credit (you have 5).');
    expect(costNote(true, summary())).toBe('Video puzzles are for paid accounts.');
    expect(costNote(true, paid({ video: 20 }))).toBe('Starting it costs 1 video credit (you have 20).');
    expect(costNote(false, paid())).toBe('Starting it costs no credits.');
    expect(costNote(true, summary({ type: 'family', canVideo: true, videoInfinite: true }))).toBe('Starting it costs no credits.');
    expect(costNote(false, GUEST_ACCOUNT)).toBe('');
  });

  it('turns what the server refuses into words', () => {
    expect(sayError('no-credits', { credits: 'photo' })).toBe('You have no photo credits left.');
    expect(sayError('no-credits', { credits: 'video' })).toBe('You have no video credits left.');
    expect(sayError('plan-required')).toBe('Video puzzles are for paid accounts.');
    expect(sayError('ad-refused', { reason: 'daily-limit' })).toContain('tomorrow');
    expect(sayError('ad-refused', { reason: 'has-credits' })).toContain('no credits left');
    expect(sayError('ad-refused')).toBe('That ad could not be counted.');
    expect(sayError('ads-off')).toContain('cannot be counted');
  });
});

describe('the credits the session shows', () => {
  const fake = (signedIn: boolean) => {
    const user = signedIn ? { id: 'acc1', name: 'Ann' } : null;
    const guest = { who: () => null, token: async () => null, ensure: async () => false, forget: () => undefined };
    const store = { getItem: () => null, setItem: () => undefined } as unknown as Storage;
    return { session: new OnlineSession({ who: () => user, token: async () => 't' } as never, guest as never, store), user };
  };

  it('are zeros for a guest, or nobody, and for an account until the server has said', async () => {
    expect(fake(false).session.summary()).toEqual(GUEST_ACCOUNT);
    const { session } = fake(true);
    expect(session.summary()).toEqual(GUEST_ACCOUNT);
    session.attach({ me: async () => ({ ok: true, id: 'acc1', name: 'Ann', guest: false, account: summary({ photo: 4 }) }), setName: async () => { throw new Error('no'); } });
    await session.refreshProfile();
    expect(session.summary()).toMatchObject({ type: 'free', photo: 4 });
  });

  it('follow what the server says after a puzzle or an ad, and tell those who show them', async () => {
    const { session } = fake(true);
    const seen: number[] = [];
    const stop = session.onChange(() => seen.push(session.summary().photo));
    session.setSummary(summary({ photo: 4 }));
    session.setSummary(summary({ photo: 3 }));
    stop();
    session.setSummary(summary({ photo: 2 }));
    expect(seen).toEqual([4, 3]);
    expect(session.summary().photo).toBe(2);
  });

  it('say that the account is an admin when the server says so, even without the group in the sign-in', () => {
    const { session } = fake(true);
    expect(session.isAdmin()).toBe(false);
    session.setSummary(summary({ type: 'admin', photoInfinite: true, videoInfinite: true, canVideo: true }));
    expect(session.isAdmin()).toBe(true);
  });

  it('go back to zeros when the account signs out', () => {
    const { session, user } = fake(true);
    session.setSummary(summary({ photo: 4 }));
    expect(session.summary().photo).toBe(4);
    (session as unknown as { account: { who: () => unknown } }).account = { who: () => null };
    expect(user).not.toBeNull();
    expect(session.summary()).toEqual(GUEST_ACCOUNT);
  });
});
