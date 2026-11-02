import { adGives, earnsUncapped, mayStartVideos, photosAreFree, videosAreFree, type AccountSummary, type AccountType } from '../../src/online/protocol';
import { GUEST_ACCOUNT } from '../../src/online/protocol';
export { GUEST_ACCOUNT as GUEST_SUMMARY } from '../../src/online/protocol';
import { isGuestId } from './guest';
import type { AccountRecord, Limits } from './types';

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

/** How long after the owner of an account pressed "Add Google" a first sign-in with Google and the same e-mail address is joined to the account. */
export const LINK_INTENT_MS = 10 * 60 * 1000;
