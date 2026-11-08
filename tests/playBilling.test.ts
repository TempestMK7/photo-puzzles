import { describe, expect, it } from 'vitest';
import type { OnlineApi } from '../src/online/api';
import { PlayBilling } from '../src/online/play';
import { GUEST_ACCOUNT, type AccountSummary, type ApiFailure, type MeResponse } from '../src/online/protocol';
import type { OnlineSession } from '../src/online/session';
import { billingAvailable, buySubscription, manageSubscription, onBilling, queryProduct, restorePurchases } from '../src/platform';

// The page's side of the Android app's subscription: what the shell says is given to the server, which decides; the page never makes itself paid.

/** A window that can be told things. */
function windowLike() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    target: { addEventListener: (_: string, fn: (e: unknown) => void) => listeners.add(fn), removeEventListener: (_: string, fn: (e: unknown) => void) => listeners.delete(fn) } as never,
    say: (detail: unknown) => listeners.forEach((fn) => fn({ detail })),
    count: () => listeners.size,
  };
}

describe('the shell\'s billing', () => {
  it('is there only in an app whose shell has it', () => {
    expect(billingAvailable({ buySubscription: () => undefined, queryProduct: () => undefined }, undefined)).toBe(true);
    expect(billingAvailable({ platform: () => 'ios', buySubscription: () => undefined, queryProduct: () => undefined }, undefined)).toBe(true);
    expect(billingAvailable({ showRewardedAd: () => undefined }, undefined)).toBe(false);          // an app with ads and no billing (an older one)
    expect(billingAvailable({}, undefined)).toBe(false);
    expect(billingAvailable(undefined, 'steam')).toBe(false);
    expect(billingAvailable(undefined, undefined)).toBe(false);
  });

  it('passes what the page asks on to the shell, and never throws', () => {
    const asked: string[] = [];
    const host = {
      queryProduct: (p: string) => asked.push(`price ${p}`),
      buySubscription: (p: string, a: string) => asked.push(`buy ${p} ${a}`),
      restorePurchases: () => asked.push('restore'),
      manageSubscription: (p: string) => asked.push(`manage ${p}`),
    };
    queryProduct('plus', host);
    expect(buySubscription('plus', 'acct1', host)).toBe(true);
    restorePurchases(host);
    manageSubscription('plus', host);
    expect(asked).toEqual(['price plus', 'buy plus acct1', 'restore', 'manage plus']);
    const broken = { queryProduct: () => { throw new Error('x'); }, buySubscription: () => { throw new Error('x'); }, restorePurchases: () => { throw new Error('x'); }, manageSubscription: () => { throw new Error('x'); } };
    queryProduct('plus', broken);
    expect(buySubscription('plus', 'a', broken)).toBe(false);
    restorePurchases(broken);
    manageSubscription('plus', broken);
    expect(buySubscription('plus', 'a', {})).toBe(false);
  });

  it('understands the shell\'s events, and nothing that is malformed', () => {
    const w = windowLike();
    const heard: unknown[] = [];
    const stop = onBilling((e) => heard.push(e), w.target);
    w.say({ kind: 'product', productId: 'plus', price: '$2.99' });
    w.say({ kind: 'purchase', token: 'tok', pending: true });
    w.say({ kind: 'purchase', token: 'tok2' });
    w.say({ kind: 'error', error: 'canceled' });
    w.say({ kind: 'error', error: 'something else' });
    w.say({ kind: 'product', productId: 'plus' });
    w.say({ kind: 'purchase', token: '' });
    w.say({ kind: 'nonsense' });
    w.say(null);
    expect(heard).toEqual([
      { kind: 'product', productId: 'plus', price: '$2.99' },
      { kind: 'purchase', token: 'tok', pending: true },
      { kind: 'purchase', token: 'tok2', pending: false },
      { kind: 'error', error: 'canceled' },
      { kind: 'error', error: 'error' },
    ]);
    stop();
    expect(w.count()).toBe(0);
  });
});

/** The signed-in account and the server, as PlayBilling sees them. */
function world(play: AccountSummary['play'] | 'none' = { on: true, productId: 'plus', active: false }) {
  const w = windowLike();
  const asked: string[] = [];
  const verified: string[] = [];
  let summary: AccountSummary = { ...GUEST_ACCOUNT, type: 'free', play: play === 'none' ? undefined : play };
  const listeners = new Set<() => void>();
  let kind: 'account' | 'guest' = 'account';
  const identity = {
    kind: () => kind,
    who: () => ({ id: 'acct-1', name: 'Ann' }),
    summary: () => summary,
    setSummary: (s: AccountSummary) => {
      summary = s;
      listeners.forEach((fn) => fn());
    },
    onChange: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
  } as unknown as OnlineSession;
  let answer: (token: string) => MeResponse | ApiFailure = (token) => ({ ok: true, id: 'acct-1', name: 'Ann', guest: false, account: { ...summary, type: 'paid', play: { on: true, productId: 'plus', active: !token.startsWith('inactive') } } });
  const api = { playVerify: async (token: string) => (verified.push(token), answer(token)) } as unknown as OnlineApi;
  const host = {
    platform: () => 'android',
    queryProduct: (p: string) => asked.push(`price ${p}`),
    buySubscription: (p: string, a: string) => asked.push(`buy ${p} ${a}`),
    restorePurchases: () => asked.push('restore'),
    manageSubscription: (p: string) => asked.push(`manage ${p}`),
  };
  const billing = new PlayBilling(identity, api, host, w.target);
  const said: (string | null)[] = [];
  billing.onUpdate((t) => said.push(t));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { w, asked, verified, billing, said, identity, settle, answerWith: (fn: typeof answer) => (answer = fn), setKind: (k: 'account' | 'guest') => (kind = k), changed: () => listeners.forEach((fn) => fn()) };
}

describe('PlayBilling', () => {
  it('is available where the shell has billing, and knows the price once Google Play says', async () => {
    const t = world();
    expect(t.billing.available).toBe(true);
    t.billing.loadPrice('plus');
    expect(t.asked).toEqual(['price plus']);
    expect(t.billing.priceOf('plus')).toBeNull();
    t.w.say({ kind: 'product', productId: 'plus', price: '$2.99' });
    await t.settle();
    expect(t.billing.priceOf('plus')).toBe('$2.99');
    expect(t.said).toEqual([null]);
    t.billing.loadPrice('plus');
    expect(t.asked).toEqual(['price plus']);                                                    // (not asked again)
  });

  it('gives the purchase sheet the account\'s id, once at a time', () => {
    const t = world();
    t.billing.subscribe('plus');
    t.billing.subscribe('plus');
    expect(t.asked).toEqual(['buy plus acct-1']);
    const guest = world();
    guest.setKind('guest');
    guest.billing.subscribe('plus');
    expect(guest.asked).toEqual([]);
  });

  it('gives a purchase to the server, takes the answer as the account\'s standing, and thanks the player', async () => {
    const t = world();
    t.billing.subscribe('plus');
    t.w.say({ kind: 'purchase', token: 'tok1', pending: false });
    await t.settle();
    expect(t.verified).toEqual(['tok1']);
    expect(t.identity.summary()).toMatchObject({ type: 'paid', play: { active: true } });
    expect(t.said).toEqual(['Thank you! Your subscription is active and this is now a paid account.']);
  });

  it('says a payment is pending, and does not say the account is paid', async () => {
    const t = world();
    t.billing.subscribe('plus');
    t.w.say({ kind: 'purchase', token: 'inactive-1', pending: true });
    await t.settle();
    expect(t.said).toEqual(['Your payment is pending. The subscription starts when Google Play confirms it.']);
  });

  it('says why a purchase did not happen, and only to a player who was buying', async () => {
    const t = world();
    t.w.say({ kind: 'error', error: 'unavailable' });
    await t.settle();
    expect(t.said).toEqual([]);                                                                   // (a price that could not be had: the button says Subscribe)
    t.billing.subscribe('plus');
    t.w.say({ kind: 'error', error: 'canceled' });
    await t.settle();
    expect(t.said).toEqual(['The purchase was cancelled.']);
    t.billing.subscribe('plus');
    expect(t.asked.filter((a) => a.startsWith('buy')).length).toBe(2);                           // (and may buy again)
  });

  it('says it when the server turns a purchase away or cannot be reached, for a purchase that was just made', async () => {
    const t = world();
    t.answerWith(() => ({ ok: false, error: 'purchase-taken' }));
    t.billing.subscribe('plus');
    t.w.say({ kind: 'purchase', token: 'tok1', pending: false });
    await t.settle();
    expect(t.said).toEqual(['That Google Play subscription belongs to another account here.']);
    t.said.length = 0;
    t.answerWith(() => ({ ok: false, error: 'offline' }) as never);
    t.billing.subscribe('plus');
    t.w.say({ kind: 'purchase', token: 'tok1', pending: false });
    await t.settle();
    expect(t.said[0]).toMatch(/counted/);
    expect(t.identity.summary().type).toBe('free');
  });

  it('quietly gives the server what Play still has for a signed-in account that is not paid up, once', async () => {
    const t = world();
    t.changed();
    t.changed();
    expect(t.asked).toEqual(['restore']);
    t.answerWith(() => ({ ok: false, error: 'purchase-taken' }));
    t.w.say({ kind: 'purchase', token: 'old', pending: false });                                  // (found, not made now: another account's, and nothing is said)
    await t.settle();
    expect(t.verified).toEqual(['old']);
    expect(t.said).toEqual([]);
  });

  it('does not look for purchases for a guest, an account that is paid up through Play, or a server that does not sell one', () => {
    const guest = world();
    guest.setKind('guest');
    guest.changed();
    const paid = world({ on: true, productId: 'plus', active: true });
    paid.changed();
    const off = world('none');
    off.changed();
    expect([guest.asked, paid.asked, off.asked]).toEqual([[], [], []]);
  });

  it('has nothing to do in a build with no billing', () => {
    const w = windowLike();
    const billing = new PlayBilling({ kind: () => 'account', who: () => ({ id: 'a', name: 'A' }), summary: () => GUEST_ACCOUNT, setSummary: () => undefined, onChange: () => () => undefined } as unknown as OnlineSession, {} as OnlineApi, {} as never, w.target);
    expect(billing.available).toBe(false);
    billing.loadPrice('plus');
    billing.subscribe('plus');
    expect(billing.priceOf('plus')).toBeNull();
  });
});
