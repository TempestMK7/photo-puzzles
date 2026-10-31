import { createPublicKey, verify } from 'node:crypto';
import type { AdCallbacks, Clock } from './types';

/** Where AdMob publishes the keys that sign its reward callbacks (they rotate, so they are fetched again now and then). */
export const ADMOB_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';

/** The public keys by id (the PEM text of each). */
export type KeySource = () => Promise<Map<string, string>>;

/** Reads the keys from AdMob's address. */
export async function fetchAdMobKeys(fetcher: typeof fetch = fetch, url = ADMOB_KEYS_URL): Promise<Map<string, string>> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`AdMob's keys could not be read (${res.status})`);
  const body = (await res.json()) as { keys?: { keyId?: number | string; pem?: string }[] };
  const keys = new Map<string, string>();
  for (const k of body.keys ?? []) if (k.keyId !== undefined && typeof k.pem === 'string') keys.set(String(k.keyId), k.pem);
  if (!keys.size) throw new Error('AdMob gave no keys');
  return keys;
}

/** The keys are looked at again when they are this old (AdMob says to keep them no longer than a day), or when a callback names one that is not known (they have rotated), at most once a minute. */
const KEYS_KEEP_MS = 6 * 3600 * 1000;
const KEYS_RETRY_MS = 60 * 1000;
/** A reward that is older than this is not taken (a callback that is a day late is a replay, not news). */
const MAX_AGE_MS = 24 * 3600 * 1000;

const unbase64 = (text: string): Buffer => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * AdMob's server-side verification of a rewarded ad: when a player has watched the ad to the end, AdMob calls an address of ours with the reward in its query string, signed with
 * ECDSA (SHA-256) over the whole of the query string that comes before `&signature=`; `signature` and `key_id` are always the last two. Only a call that is signed by one of AdMob's
 * keys, for one of our own ad units, and not too old, is taken as true. The game's own word that an ad was watched is worth nothing: anyone can say it.
 * https://developers.google.com/admob/android/rewarded-video-ssv
 */
export class AdMobCallbacks implements AdCallbacks {
  private keys = new Map<string, string>();
  private fetchedAt = 0;
  private triedAt = 0;

  constructor(
    /** Our ad units: the full id (ca-app-pub-123/456) or the number after the slash, which is what the callback carries. */
    private readonly adUnits: string[],
    private readonly clock: Clock,
    private readonly source: KeySource = () => fetchAdMobKeys(),
  ) {}

  private async key(id: string): Promise<string | undefined> {
    const now = this.clock.now();
    const stale = now - this.fetchedAt > KEYS_KEEP_MS;
    if ((stale || !this.keys.has(id)) && now - this.triedAt > KEYS_RETRY_MS) {
      this.triedAt = now;
      try {
        this.keys = await this.source();
        this.fetchedAt = now;
      } catch (e) {
        console.error(e);                                              // (the keys we have are used: an unknown key is simply not believed)
      }
    }
    return this.keys.get(id);
  }

  private ours(adUnit: string): boolean {
    return this.adUnits.some((u) => u === adUnit || u.endsWith(`/${adUnit}`));
  }

  async verify(rawQuery: string): Promise<{ transactionId: string; customData: string; at: number } | null> {
    const cut = rawQuery.lastIndexOf('&signature=');
    if (cut < 0) return null;
    const signed = rawQuery.slice(0, cut);
    const tail = new URLSearchParams(rawQuery.slice(cut + 1));
    const signature = tail.get('signature');
    const keyId = tail.get('key_id');
    if (!signature || !keyId) return null;
    const pem = await this.key(keyId);
    if (!pem) return null;
    try {
      if (!verify('sha256', Buffer.from(signed), { key: createPublicKey(pem), dsaEncoding: 'der' }, unbase64(signature))) return null;
    } catch {
      return null;                                                      // not a signature at all
    }
    const q = new URLSearchParams(signed);
    const transactionId = q.get('transaction_id');
    const at = Number(q.get('timestamp'));
    if (!transactionId || !/^[\w-]{1,128}$/.test(transactionId) || !Number.isFinite(at) || !this.ours(q.get('ad_unit') ?? '')) return null;
    if (Math.abs(this.clock.now() - at) > MAX_AGE_MS) return null;
    return { transactionId, customData: q.get('custom_data') ?? '', at };
  }
}
