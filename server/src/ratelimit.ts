import type { Clock, RateCounter } from './types';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * How often one address, or one player, may do something before the server answers 429. The windows are fixed (the count starts again at each one), which is crude but costs one
 * write per request. The numbers are generous for a family behind one address; they are there to stop a script. (AWS WAF cannot sit in front of an HTTP API, which is why this is
 * done here.)
 */
export const DEFAULT_RATES = {
  /** Guest tokens made for an address (asking again with a token that is still good makes none). */
  newGuests: { perIp: 20, windowMs: HOUR },
  /** Tries at a code that found nothing. A code is only five digits: this is what keeps it from being guessed. */
  failedJoins: { perIp: 30, perPlayer: 10, windowMs: 15 * MIN },
  /** Puzzles made from an address (each account has its own weekly quota besides). */
  creations: { perIp: 30, windowMs: HOUR },
  /** Reports of puzzles sent by one player. */
  reports: { perPlayer: 5, windowMs: HOUR },
  /** Where the host says the video is: when it is played, paused or moved, and now and then while it plays. */
  playback: { perPlayer: 60, windowMs: MIN },
  /** The owner's game asking how the check of a video is going (every few seconds for a minute or two). */
  videoCheck: { perPlayer: 60, windowMs: 5 * MIN },
};

export type Rates = typeof DEFAULT_RATES;

/** Keeps an IPv6 address by its first four groups (a /64: one network, which hands out as many addresses as it likes); an IPv4 address stays as it is. */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const groups = ip.toLowerCase().split('::')[0].split(':');
  return groups.slice(0, 4).join(':');
}

export class RateLimiter {
  constructor(
    private readonly counter: RateCounter,
    private readonly clock: Clock,
    readonly rates: Rates = DEFAULT_RATES,
    private readonly log: (e: unknown) => void = console.error,
  ) {}

  /** Counts one more for `key`; true if that is still within `limit`. */
  async take(key: string, limit: number, windowMs: number): Promise<boolean> {
    return this.safely(async () => (await this.counter.add(key, windowMs)) <= limit, true);
  }

  /** True if `limit` has been used up already in this window (counts nothing). */
  async spent(key: string, limit: number, windowMs: number): Promise<boolean> {
    return this.safely(async () => (await this.counter.count(key, windowMs)) >= limit, false);
  }

  async strike(key: string, windowMs: number): Promise<void> {
    await this.safely(() => this.counter.add(key, windowMs), 0);
  }

  /** When the current window ends, which is when the next try may succeed. */
  retryAt(windowMs: number): number {
    return (Math.floor(this.clock.now() / windowMs) + 1) * windowMs;
  }

  // a counter that cannot be reached must not take the service down with it: the request goes through (and the error is logged, where the alarm on errors can see it)
  private async safely<T>(f: () => Promise<T>, otherwise: T): Promise<T> {
    try {
      return await f();
    } catch (e) {
      this.log(e);
      return otherwise;
    }
  }
}
