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
 * - A build for Steam or itch says so with `VITE_PLATFORM` (`steam` or `itch`) when it is built. Anything else is the web page.
 */
export type Platform = 'android' | 'ios' | 'steam' | 'itch' | 'web';

interface Native {
  platform?: () => string;
  openSignIn?: (url: string) => void;
  takeSignIn?: () => string;
  prepareAds?: () => void;
  showRewardedAd?: (kind: string, nonce: string) => void;
  privacyOptionsRequired?: () => boolean;
  showPrivacyOptions?: () => void;
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
