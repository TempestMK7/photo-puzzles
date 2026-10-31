import type { AdPlatform } from './online/protocol';

/**
 * Where the game is running, for the one thing that depends on it: rewarded ads, which only the mobile apps may show (Steam and itch forbid them, and the web page has no ad network).
 *
 * - The mobile apps are a shell around the page that offers `window.PhotoPuzzlesNative`. For ads it adds `showRewardedAd(kind)` (`'photo'` or `'video'`), which starts an ad and returns at once;
 *   when the ad is over the shell fires the window event `photopuzzles-ad` with `detail` `{ kind, rewarded, proof }` (`rewarded`: the player watched it to the end; `proof`: what the ad network
 *   gave the app, for the server to check). A shell may also offer `platform()` ('android' or 'ios'); one that does not is taken for Android's.
 * - A build for Steam or itch says so with `VITE_PLATFORM` (`steam` or `itch`) when it is built. Anything else is the web page.
 */
export type Platform = 'android' | 'ios' | 'steam' | 'itch' | 'web';

interface Native {
  platform?: () => string;
  showRewardedAd?: (kind: string) => void;
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

/** The app that an ad would be watched in, or nothing where there are no ads. */
export function adPlatform(host: Native | undefined = nativeHost(), built?: string): AdPlatform | null {
  const p = platform(host, built);
  return (p === 'android' || p === 'ios') && typeof host?.showRewardedAd === 'function' ? p : null;
}

export interface AdResult {
  /** The player watched the ad to the end. */
  rewarded: boolean;
  proof?: string;
}

/** How long to wait for the shell to say that the ad is over (an ad that never answers does not leave the dialog waiting for ever). */
const AD_GIVE_UP_MS = 5 * 60_000;

/** Shows a rewarded ad (in an app that can) and waits for the shell to say how it went. Nothing is rewarded when there is no ad to show. */
export function watchAd(kind: 'photo' | 'video', host: Native | undefined = nativeHost(), target: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = typeof window === 'undefined' ? undefined : window): Promise<AdResult> {
  return new Promise((resolve) => {
    if (typeof host?.showRewardedAd !== 'function' || !target) return resolve({ rewarded: false });
    const done = (r: AdResult) => {
      clearTimeout(timer);
      target.removeEventListener('photopuzzles-ad', onEnd as EventListener);
      resolve(r);
    };
    const onEnd = (e: CustomEvent<{ kind?: unknown; rewarded?: unknown; proof?: unknown }>) => {
      if (e.detail?.kind !== kind) return;
      done({ rewarded: e.detail.rewarded === true, ...(typeof e.detail.proof === 'string' ? { proof: e.detail.proof } : {}) });
    };
    const timer = setTimeout(() => done({ rewarded: false }), AD_GIVE_UP_MS);
    target.addEventListener('photopuzzles-ad', onEnd as EventListener);
    try {
      host.showRewardedAd(kind);
    } catch {
      done({ rewarded: false });
    }
  });
}
