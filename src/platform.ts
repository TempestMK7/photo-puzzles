import type { AdKind, AdPlatform } from './online/protocol';

/**
 * Where the game is running, for the one thing that depends on it: rewarded ads, which only the mobile apps may show (Steam and itch forbid them, and the web page has no ad network).
 *
 * - The mobile apps are a shell around the page that offers `window.PhotoPuzzlesNative`. For ads it adds `showRewardedAd(kind, nonce)` (`kind` is `'photo'`, `'video'`, `'hint'` or `'bomb'`; `nonce` is the
 *   one-time number that the server gave for this ad, which the shell gives the ad network as the ad's custom data, so that the network's report to the server can be matched to the account),
 *   which starts an ad and returns at once; when the ad is over the shell fires the window event `photopuzzles-ad` with `detail` `{ kind, rewarded, error? }` (`rewarded`: the player watched it
 *   to the end; `error`: `no-ad` when there was none to show, `consent` when the player has not agreed to ads where the law asks). The credits themselves come from the ad network's
 *   report to the server, not from the page. A shell may also offer `platform()` ('android' or 'ios'; one that does not is taken for Android's), and, where the law asks that the
 *   player can change their mind about ads, `privacyOptionsRequired()` and `showPrivacyOptions()`. Nothing in the app talks to the ad network before the page calls `prepareAds()`
 *   (when the player looks at the credits), which makes the app find out about the player's consent and get an ad ready, and fires the window event `photopuzzles-ads-ready` when it knows.
 * - The subscription (Google Play Billing, in the Android app only): the shell offers `queryProduct(productId)` (asks Google Play for the price), `buySubscription(productId, accountId)` (opens the purchase
 *   sheet; only a hash of the account id goes to Google), `restorePurchases()` (the purchases that Play still has for the player) and `manageSubscription(productId)` (Play's page for it), and tells the page
 *   what happens with the window event `photopuzzles-billing`: `detail` is `{ kind: 'product', productId, price }`, `{ kind: 'purchase', token, pending }` or `{ kind: 'error', error }` (`canceled`,
 *   `unavailable` or `error`). **The page never makes itself paid:** it gives each purchase token to the server (`POST /me/play/verify`), which asks Google.
 * - A build for Steam or itch says so with `VITE_PLATFORM` (`steam` or `itch`) when it is built. Anything else is the web page.
 */
export type Platform = 'android' | 'ios' | 'steam' | 'itch' | 'web';

interface Native {
  platform?: () => string;
  openSignIn?: (url: string) => void;
  takeSignIn?: () => string;
  signInRedirect?: () => string;
  prepareAds?: () => void;
  showRewardedAd?: (kind: string, nonce: string) => void;
  privacyOptionsRequired?: () => boolean;
  showPrivacyOptions?: () => void;
  unlockAchievements?: (idsJson: string) => void;
  queryProduct?: (productId: string) => void;
  buySubscription?: (productId: string, accountId: string) => void;
  restorePurchases?: () => void;
  manageSubscription?: (productId: string) => void;
}

const nativeHost = (): Native | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as { PhotoPuzzlesNative?: Native }).PhotoPuzzlesNative);

export function platform(host: Native | undefined = nativeHost(), built: string | undefined = import.meta.env?.VITE_PLATFORM as string | undefined): Platform {
  if (host) {
    try {
      return host.platform?.() === 'ios' ? 'ios' : 'android';
    } catch {
      return 'android';
    }
  }
  return built === 'steam' || built === 'itch' ? built : 'web';
}

/**
 * Signing in with Google (or any page of the sign-in service) cannot happen inside an app's web view: Google refuses it. A shell that can do it differently offers `openSignIn(url)`,
 * which opens the address in the phone's browser (a Chrome Custom Tab), and the sign-in service sends the player back to the app's own address (`APP_SIGN_IN_REDIRECT`), which the shell
 * receives and keeps until the page asks for it with `takeSignIn()` (the whole address, or an empty string): the window event `photopuzzles-signin` says that there is one.
 */
export const APP_SIGN_IN_REDIRECT = 'com.tempest.photopuzzles://signed-in';

/** The address the app wants to be sent back to: the shell says (the dev app is an app of its own, with its own address, so that both can be on one phone); the real app's when it does not (an older shell). */
export function appSignInRedirect(host: Native | undefined = nativeHost()): string {
  try {
    const own = host?.signInRedirect?.();
    if (typeof own === 'string' && /^[a-z][a-z0-9.]*:\/\/signed-in$/.test(own)) return own;
  } catch {
    /* the usual one */
  }
  return APP_SIGN_IN_REDIRECT;
}

/** Whether sign-in pages are opened outside the page (in the phone's browser) and come back through the app. */
export function browserSignIn(host: Native | undefined = nativeHost()): boolean {
  return typeof host?.openSignIn === 'function' && typeof host.takeSignIn === 'function';
}

/** Opens a sign-in address in the phone's browser. */
export function openSignIn(url: string, host: Native | undefined = nativeHost()): void {
  host?.openSignIn?.(url);
}

/** The address that the sign-in service sent the player back to the app with, if one has come and has not been taken. */
export function takeSignIn(host: Native | undefined = nativeHost()): string {
  try {
    const url = host?.takeSignIn?.();
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

/**
 * Tells the shell which achievements are unlocked (their ids, `src/core/achievements.ts`), for the platform's own service (Google Play Games). Nothing where the shell has none. The game
 * tells it all that are unlocked when it starts and then each new one: the service takes an unlock it has already as nothing, so one that could not be sent goes the next time.
 */
export function tellAchievements(ids: readonly string[], host: Native | undefined = nativeHost()): void {
  if (!ids.length || typeof host?.unlockAchievements !== 'function') return;
  try {
    host.unlockAchievements(JSON.stringify(ids));
  } catch {
    /* the shell could not take them: the next start tells again */
  }
}

/** The app that an ad would be watched in, or nothing where there are no ads. */
export function adPlatform(host: Native | undefined = nativeHost(), built?: string): AdPlatform | null {
  const p = platform(host, built);
  return (p === 'android' || p === 'ios') && typeof host?.showRewardedAd === 'function' ? p : null;
}

export interface AdResult {
  /** The player watched the ad to the end. */
  rewarded: boolean;
  /** Why there was nothing to watch: no ad to show, or the player has not agreed to ads. */
  error?: 'no-ad' | 'consent';
}

/** The player is looking at the credits in an app that has ads: it may get ready for one (and learns whether the player has choices to make: it says so with the window event photopuzzles-ads-ready). */
export function prepareAds(host: Native | undefined = nativeHost()): void {
  try {
    host?.prepareAds?.();
  } catch {
    /* the app has no ads to get ready */
  }
}

/** The player's choices about ads, where the shell has them (the law asks for a way to change them): shows them. Nothing where there is no such thing. */
export function adPrivacy(host: Native | undefined = nativeHost()): (() => void) | null {
  try {
    return typeof host?.showPrivacyOptions === 'function' && host.privacyOptionsRequired?.() === true ? () => host.showPrivacyOptions!() : null;
  } catch {
    return null;
  }
}

/** How long to wait for the shell to say that the ad is over (an ad that never answers does not leave the dialog waiting for ever). */
const AD_GIVE_UP_MS = 5 * 60_000;

/** Shows a rewarded ad (in an app that can) and waits for the shell to say how it went. Nothing is rewarded when there is no ad to show. */
export function watchAd(kind: AdKind, nonce: string, host: Native | undefined = nativeHost(), target: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = typeof window === 'undefined' ? undefined : window): Promise<AdResult> {
  return new Promise((resolve) => {
    if (typeof host?.showRewardedAd !== 'function' || !target) return resolve({ rewarded: false });
    const done = (r: AdResult) => {
      clearTimeout(timer);
      target.removeEventListener('photopuzzles-ad', onEnd as EventListener);
      resolve(r);
    };
    const onEnd = (e: CustomEvent<{ kind?: unknown; rewarded?: unknown; error?: unknown }>) => {
      if (e.detail?.kind !== kind) return;
      done({ rewarded: e.detail.rewarded === true, ...(e.detail.error === 'no-ad' || e.detail.error === 'consent' ? { error: e.detail.error } : {}) });
    };
    const timer = setTimeout(() => done({ rewarded: false }), AD_GIVE_UP_MS);
    target.addEventListener('photopuzzles-ad', onEnd as EventListener);
    try {
      host.showRewardedAd(kind, nonce);
    } catch {
      done({ rewarded: false });
    }
  });
}

/** Whether the subscription can be bought here: in an app whose shell has Google Play Billing. */
export function billingAvailable(host: Native | undefined = nativeHost(), built?: string): boolean {
  const p = platform(host, built);
  return (p === 'android' || p === 'ios') && typeof host?.buySubscription === 'function' && typeof host.queryProduct === 'function';
}

/** What the shell says about the subscription (the window event `photopuzzles-billing`). */
export type BillingEvent = { kind: 'product'; productId: string; price: string } | { kind: 'purchase'; token: string; pending: boolean } | { kind: 'error'; error: 'canceled' | 'unavailable' | 'error' };

/** Listens for what the shell says about the subscription. Returns the way to stop. */
export function onBilling(handler: (event: BillingEvent) => void, target: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = typeof window === 'undefined' ? undefined : window): () => void {
  if (!target) return () => {};
  const listener = (e: CustomEvent<Record<string, unknown> | null>): void => {
    const d = e.detail;
    if (d?.kind === 'product' && typeof d.productId === 'string' && typeof d.price === 'string') handler({ kind: 'product', productId: d.productId, price: d.price });
    else if (d?.kind === 'purchase' && typeof d.token === 'string' && d.token) handler({ kind: 'purchase', token: d.token, pending: d.pending === true });
    else if (d?.kind === 'error') handler({ kind: 'error', error: d.error === 'canceled' || d.error === 'unavailable' ? d.error : 'error' });
  };
  target.addEventListener('photopuzzles-billing', listener as EventListener);
  return () => target.removeEventListener('photopuzzles-billing', listener as EventListener);
}

/** Asks the shell for the subscription's price (it answers with an event). The calls below do nothing where the shell has no billing, and never throw. */
export function queryProduct(productId: string, host: Native | undefined = nativeHost()): void {
  try {
    host?.queryProduct?.(productId);
  } catch {
    /* no price: the button says Subscribe */
  }
}

/** Opens the purchase sheet (the shell answers with an event). `accountId` is only hashed before it goes to Google. */
export function buySubscription(productId: string, accountId: string, host: Native | undefined = nativeHost()): boolean {
  try {
    host?.buySubscription?.(productId, accountId);
    return typeof host?.buySubscription === 'function';
  } catch {
    return false;
  }
}

/** Asks for the purchases that Google Play still has for the player (each comes as an event). */
export function restorePurchases(host: Native | undefined = nativeHost()): void {
  try {
    host?.restorePurchases?.();
  } catch {
    /* nothing to restore */
  }
}

/** Opens Google Play's page for managing the subscription. */
export function manageSubscription(productId: string, host: Native | undefined = nativeHost()): void {
  try {
    host?.manageSubscription?.(productId);
  } catch {
    /* the player can find it in the Play Store */
  }
}
