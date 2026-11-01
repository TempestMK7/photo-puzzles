import { adGives, helpIsFree, mayStartVideos, photosAreFree, videosAreFree, type AccountSummary, type AccountType } from '../../src/online/protocol';
export { GUEST_ACCOUNT as GUEST_SUMMARY } from '../../src/online/protocol';
import type { AccountRecord, Limits } from './types';

/** The day, in UTC, that the ads watched in a day are counted for. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A new account: free, with the credits that one starts with and none for videos, and the hints and bombs that every account starts with. */
export function newAccount(id: string, limits: Limits, now: number): AccountRecord {
  return { id, type: 'free', photo: limits.freePhotoCredits, video: 0, adDay: dayOf(now), photoAds: 0, videoAds: 0, hints: limits.startHints, bombs: limits.startBombs, createdAt: now, rev: 0 };
}

/** What an account holds of hints and bombs: an account made before they existed holds what a new one starts with. */
export function helpHeld(account: AccountRecord, limits: Limits): { hints: number; bombs: number } {
  return { hints: account.hints ?? limits.startHints, bombs: account.bombs ?? limits.startBombs };
}

/** How many ads gave credits today (the counts are of the day they were made on). */
export function adsToday(account: AccountRecord, now: number): { photo: number; video: number } {
  return account.adDay === dayOf(now) ? { photo: account.photoAds, video: account.videoAds } : { photo: 0, video: 0 };
}

/** The account as the game shows it. `type` is the type that counts (the operator's group makes an account an admin whatever its record says). */
export function summaryOf(type: AccountType, account: AccountRecord, limits: Limits, now: number): AccountSummary {
  const today = adsToday(account, now);
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
    hintsInfinite: helpIsFree(type),
    bombsInfinite: helpIsFree(type),
  };
}
