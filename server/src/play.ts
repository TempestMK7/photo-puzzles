import { createSign, timingSafeEqual } from 'node:crypto';
import type { Play, PlayPurchase } from './types';

/** What the deployment keeps in the secret (a JSON text): a Google Cloud service account that Play Console has given access to the app's subscriptions, and what the app sells. */
export interface PlaySettings {
  /** The service account's key (the JSON file Google Cloud gives: only these two fields are used). */
  serviceAccount: { client_email: string; private_key: string };
  /** The app's package id (`com.tempest.photopuzzles` for the real one). */
  packageName: string;
  /** The subscription's product id in Play Console. */
  productId: string;
  /** A word that the push address carries (`/play/notify?key=...`), so that only Google's own push (which is told the address) is believed. */
  notifyKey: string;
}

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

type Fetcher = typeof fetch;

/** Reads the secret's text; nothing when it is not a complete set of settings (Google Play is then left off). */
export function parsePlaySettings(text: string | undefined): PlaySettings | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as Partial<PlaySettings>;
    const ok = [v.serviceAccount?.client_email, v.serviceAccount?.private_key, v.packageName, v.productId, v.notifyKey].every((x) => typeof x === 'string' && x);
    return ok ? (v as PlaySettings) : undefined;
  } catch {
    return undefined;
  }
}

/** The parts of Google's answer about a subscription (`purchases.subscriptionsv2.get`) that are used. */
interface Subscription {
  subscriptionState?: string;
  latestOrderId?: string;
  acknowledgementState?: string;
  lineItems?: { productId?: string; expiryTime?: string }[];
}

/** The subscription states in which the player has paid for the time now: on, in a grace period (a payment is late), or cancelled but not yet run out (checked against the expiry). */
const PAID = new Set(['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD']);
const CANCELED = 'SUBSCRIPTION_STATE_CANCELED';

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

/** Google Play's Developer API for what the game needs: whether a purchase token is a subscription that is paid up, and to acknowledge it. */
export class HttpPlay implements Play {
  private access: { token: string; until: number } | undefined;

  constructor(
    private readonly settings: PlaySettings,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get productId(): string {
    return this.settings.productId;
  }

  /** A token for the service account (an hour's), kept until just before it runs out: Google wants a signed request for it. */
  private async bearer(): Promise<string> {
    if (this.access && this.access.until > this.now() + 60_000) return this.access.token;
    const iat = Math.floor(this.now() / 1000);
    const claims = { iss: this.settings.serviceAccount.client_email, scope: SCOPE, aud: TOKEN, iat, exp: iat + 3600 };
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.settings.serviceAccount.private_key);
    const res = await this.fetcher(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
    });
    if (!res.ok) throw new Error(`Google would not give a token (${res.status}): is the service account's key right?`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Google gave no token');
    this.access = { token: body.access_token, until: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async purchase(token: string): Promise<PlayPurchase | null> {
    const res = await this.fetcher(`${API}/${encodeURIComponent(this.settings.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`, { headers: { authorization: `Bearer ${await this.bearer()}` } });
    if (res.status === 400 || res.status === 404 || res.status === 410) return null;          // (not a token that Google gave for this app)
    if (!res.ok) throw new Error(`Google would not say about a purchase (${res.status})`);
    const sub = (await res.json()) as Subscription;
    const item = sub.lineItems?.find((l) => l.productId === this.settings.productId);
    if (!item) return null;                                                                      // (a purchase of something else)
    const expires = item.expiryTime ? Date.parse(item.expiryTime) : NaN;
    const expiresAt = Number.isFinite(expires) ? expires : undefined;
    const state = sub.subscriptionState ?? '';
    const active = PAID.has(state) || (state === CANCELED && expiresAt !== undefined && expiresAt > this.now());
    return { token, productId: item.productId!, active, ...(expiresAt ? { expiresAt } : {}), ...(sub.latestOrderId ? { orderId: sub.latestOrderId } : {}), acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
  }

  async acknowledge(token: string, productId: string): Promise<void> {
    const url = `${API}/${encodeURIComponent(this.settings.packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
    const res = await this.fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${await this.bearer()}`, 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error(`Google would not take the acknowledgement (${res.status})`);
  }

  /**
   * The body of a Pub/Sub push (`{ message: { data } }`, `data` being base64 of Google Play's notice). The push address carries `key` in its query, the secret of the deployment. The notice says
   * only which token changed: what has happened to it is asked of Google (`purchase`), never believed from the notice.
   */
  notification(body: string, key: string | null): { token?: string } | null {
    if (!key) return null;
    const want = Buffer.from(this.settings.notifyKey);
    const got = Buffer.from(key);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const push = JSON.parse(body) as { message?: { data?: string } };
      const notice = JSON.parse(Buffer.from(push.message?.data ?? '', 'base64').toString('utf8')) as {
        packageName?: string;
        subscriptionNotification?: { purchaseToken?: string };
        voidedPurchaseNotification?: { purchaseToken?: string };
      };
      if (notice.packageName !== this.settings.packageName) return {};                          // (a test, or another app's: genuine, and of no use)
      const token = notice.subscriptionNotification?.purchaseToken ?? notice.voidedPurchaseNotification?.purchaseToken;
      return typeof token === 'string' && token ? { token } : {};
    } catch {
      return null;
    }
  }
}
