import type { StorageLike } from '../core/prefs';

/**
 * What a store keeps for the player who is signed in, apart from what it keeps for nobody (a guest, or nobody at all): the account's own copy lies under the key with the account's id.
 * The first account to sign in on a device takes over what the device had been keeping until then (the achievements and times of someone who played before making an account); the
 * ones after it start with nothing, and so do the guests that come after a sign-out (the device's own copy is left as it is).
 */
export const ownerKey = (base: string, owner: string | null): string => (owner ? `${base}/${owner}` : base);

/** Gives `owner` a copy of the device's data if no account has had one before on this device. Returns whether it did. */
export function adoptDeviceData(storage: StorageLike | null, base: string, owner: string): boolean {
  try {
    if (!storage || storage.getItem(`${base}/claimed`) !== null) return false;
    storage.setItem(`${base}/claimed`, owner);
    const device = storage.getItem(base);
    if (device !== null && storage.getItem(ownerKey(base, owner)) === null) storage.setItem(ownerKey(base, owner), device);
    return device !== null;
  } catch {
    return false;
  }
}
