import { adGives, earnsUncapped, mayStartVideos, photosAreFree, videosAreFree, type AccountSummary, type AccountType } from '../../src/online/protocol';
import { GUEST_ACCOUNT } from '../../src/online/protocol';
export { GUEST_ACCOUNT as GUEST_SUMMARY } from '../../src/online/protocol';
import { isGuestId } from './guest';
import type { AccountRecord, Limits, PatreonMember, PlayPurchase } from './types';

/** The day, in UTC, that the ads watched in a day are counted for. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A new account: free, with the credits that one starts with and none for videos, and the hints and bombs that every account starts with. A guest's record is the same with what a guest starts with (and no credits). */
export function newAccount(id: string, limits: Limits, now: number): AccountRecord {
  const guest = isGuestId(id);
  return { id, type: 'free', photo: guest ? 0 : limits.freePhotoCredits, video: 0, adDay: dayOf(now), photoAds: 0, videoAds: 0, hints: guest ? limits.guestHints : limits.startHints, bombs: guest ? limits.guestBombs : limits.startBombs, createdAt: now, rev: 0 };
}

/** How many hints solved puzzles have given this account today (the count is of the day it was made on). */
export function earnedToday(account: AccountRecord, now: number): number {
  return account.hintDay === dayOf(now) ? account.hintsEarned ?? 0 : 0;
}

/** What an account holds of hints and bombs: an account made before they existed holds what a new one starts with. */
export function helpHeld(account: AccountRecord, limits: Limits): { hints: number; bombs: number } {
  return { hints: account.hints ?? limits.startHints, bombs: account.bombs ?? limits.startBombs };
}

/** When the account can next have an ad for hints or bombs: after the last one, and for an account that has not had one, a while after it was made (so that nobody makes accounts to have one at once). */
export function helpAdAtOf(account: AccountRecord, limits: Limits): number {
  return account.helpAdAt ?? account.createdAt + limits.helpAdFirstMs;
}

/** How many ads gave credits today (the counts are of the day they were made on). */
export function adsToday(account: AccountRecord, now: number): { photo: number; video: number } {
  return account.adDay === dayOf(now) ? { photo: account.photoAds, video: account.videoAds } : { photo: 0, video: 0 };
}

/** The account as the game shows it. `type` is the type that counts (the operator's group makes an account an admin whatever its record says). */
export function summaryOf(type: AccountType, account: AccountRecord, limits: Limits, now: number): AccountSummary {
  const today = adsToday(account, now);
  const helpAdIn = Math.max(0, helpAdAtOf(account, limits) - now);
  return {
    type,
    photo: account.photo,
    video: account.video,
    photoInfinite: photosAreFree(type),
    videoInfinite: videosAreFree(type),
    canVideo: mayStartVideos(type),
    photoAdsLeft: adGives(type, 'photo') ? Math.max(0, limits.adsPerDay - today.photo) : 0,
    videoAdsLeft: adGives(type, 'video') ? Math.max(0, limits.videoAdsPerDay - today.video) : 0,
    adPhoto: limits.adPhotoCredits,
    adVideo: limits.adVideoCredits,
    ...helpHeld(account, limits),
    earnPerDay: limits.freeHintsPerDay,
    earnLeft: earnsUncapped(type) ? 0 : Math.max(0, limits.freeHintsPerDay - earnedToday(account, now)),
    earnInfinite: earnsUncapped(type),
    helpAdReady: !helpAdIn,
    helpAdIn,
    helpAdHints: limits.adHints,
    helpAdBombs: limits.adBombs,
    helpAdNoAd: !adGives(type, 'hint'),
  };
}

/** A guest as the game shows them: no credits and no puzzles of their own, but hints and bombs, and an ad to watch for more (like a free account's; they earn no hints by solving puzzles). */
export function guestSummaryOf(account: AccountRecord, limits: Limits, now: number): AccountSummary {
  const helpAdIn = Math.max(0, helpAdAtOf(account, limits) - now);
  return { ...GUEST_ACCOUNT, ...helpHeld(account, limits), helpAdReady: !helpAdIn, helpAdIn, helpAdHints: limits.adHints, helpAdBombs: limits.adBombs };
}

/**
 * What Patreon says about the account's Patreon user, as the account's type and credits: a pledge that is paid up makes a free account paid, one that is not takes that back (only a paid type that
 * the link itself gave: one that the operator gave, and a family or admin account, stay as they are). Each new payment is a payment period, which gives `paidVideoCredits` video credits;
 * `charged` is the last payment that gave them (kept by the Patreon user, not the account, so that taking the link away and joining again does not give them twice), and the new one is returned.
 */
export function applyPatreon(account: AccountRecord, member: PatreonMember, limits: Limits, now: number, charged?: string): { account: AccountRecord; charged?: string } {
  const a: AccountRecord = { ...account, patreon: { userId: member.userId, active: member.active, promoted: account.patreon?.promoted, checkedAt: now, ...(member.memberId ? { memberId: member.memberId } : {}) } };
  settleType(a, 'patreon');
  if (member.active && member.lastCharge && member.lastCharge !== charged) {
    a.video += limits.paidVideoCredits;
    return { account: a, charged: member.lastCharge };
  }
  return { account: a, charged };
}

/** Where a paid account can come from. An account is paid while any of them is paid up. */
type Source = 'patreon' | 'play';
const SOURCES: Source[] = ['patreon', 'play'];

/**
 * The account's type after the source `by` changed: while any source is paid up a free account is paid (the source that is paid up, `by` first, is marked as the one that made it so), and
 * when none is, a paid account that a source made paid is free again (a paid type that the operator gave, and a family or admin account, stay as they are).
 */
function settleType(a: AccountRecord, by: Source): void {
  const on = SOURCES.filter((s) => a[s]?.active);
  if (on.length) {
    if (a.type === 'free') {
      a.type = 'paid';
      a[on.includes(by) ? by : on[0]]!.promoted = true;
    }
  } else if (a.type === 'paid' && SOURCES.some((s) => a[s]?.promoted)) {
    a.type = 'free';
    for (const s of SOURCES) if (a[s]) a[s]!.promoted = false;
  }
}

/**
 * What Google Play says about the account's subscription, as the account's type and credits, by the same rules as a pledge (`applyPatreon`): each new order is a payment period, which gives
 * `playVideoCredits` video credits (fewer than a pledge's: the subscription costs less), once (`charged` is the last order that gave them, kept by the purchase token and not the account).
 */
export function applyPlay(account: AccountRecord, purchase: PlayPurchase, limits: Limits, now: number, charged?: string): { account: AccountRecord; charged?: string } {
  const a: AccountRecord = {
    ...account,
    play: { token: purchase.token, productId: purchase.productId, active: purchase.active, promoted: account.play?.promoted, checkedAt: now, ...(purchase.expiresAt ? { expiresAt: purchase.expiresAt } : {}) },
  };
  settleType(a, 'play');
  if (purchase.active && purchase.orderId && purchase.orderId !== charged) {
    a.video += limits.playVideoCredits;
    return { account: a, charged: purchase.orderId };
  }
  return { account: a, charged };
}

/** The account lets a source go (its link is taken away): what it gave stays (the credits), and the paid type it made goes, unless another source that is paid up can keep it. */
export function releaseSource(a: AccountRecord, source: Source): void {
  const promoted = a[source]?.promoted;
  delete a[source];
  if (!promoted) return;
  const other = SOURCES.map((s) => a[s]).find((l) => l?.active);
  if (other) other.promoted = true;
  else if (a.type === 'paid') a.type = 'free';
}

/** How long a subscription is believed without asking Google again (its push says when one changes; this is for the call that was lost). */
export const PLAY_RECHECK_MS = 24 * 3600 * 1000;

/** How long a pledge is believed without asking Patreon again (the webhook says when one changes; this is for the call that was lost). */
export const PATREON_RECHECK_MS = 24 * 3600 * 1000;

/** How long after the owner of an account pressed "Add Google" a first sign-in with Google and the same e-mail address is joined to the account. */
export const LINK_INTENT_MS = 10 * 60 * 1000;
