import { describe, expect, it } from 'vitest';
import { NO_RATING, RATE_AGAIN_MS, shouldAskToRate } from '../src/core/ratePrompt';
import { RateStore } from '../src/store/rate';
import { canRate, platform } from '../src/platform';

const DAY = 24 * 60 * 60 * 1000;
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('when the player is asked to rate the app', () => {
  it('not before three puzzles are solved', () => {
    expect(shouldAskToRate(NO_RATING, 1000)).toBe(false);
    expect(shouldAskToRate({ ...NO_RATING, solved: 2 }, 1000)).toBe(false);
    expect(shouldAskToRate({ ...NO_RATING, solved: 3 }, 1000)).toBe(true);
    expect(shouldAskToRate({ ...NO_RATING, solved: 40 }, 1000)).toBe(true);
  });

  it('not again for three days after it was shown, and then again', () => {
    const s = { solved: 5, asked: 10 * DAY, rated: false };
    expect(shouldAskToRate(s, 10 * DAY + 1000)).toBe(false);
    expect(shouldAskToRate(s, 10 * DAY + RATE_AGAIN_MS - 1)).toBe(false);
    expect(shouldAskToRate(s, 10 * DAY + RATE_AGAIN_MS)).toBe(true);
  });

  it('never again once Rate Me! was pressed, and a clock set back is not waited for', () => {
    expect(shouldAskToRate({ solved: 9, asked: 1, rated: true }, 100 * DAY)).toBe(false);
    expect(shouldAskToRate({ solved: 9, asked: 50 * DAY, rated: false }, 1 * DAY)).toBe(true);
  });
});

describe('what the device keeps', () => {
  it('counts solved puzzles and remembers asking and rating across a restart', () => {
    const storage = memory();
    const a = new RateStore(storage);
    a.solved();
    a.solved();
    expect(a.shouldAsk(0)).toBe(false);
    a.solved();
    expect(a.shouldAsk(5 * DAY)).toBe(true);
    a.asked(5 * DAY);
    const b = new RateStore(storage);
    expect(b.data).toEqual({ solved: 3, asked: 5 * DAY, rated: false });
    expect(b.shouldAsk(6 * DAY)).toBe(false);
    expect(b.shouldAsk(8 * DAY)).toBe(true);
    b.rated();
    expect(new RateStore(storage).shouldAsk(99 * DAY)).toBe(false);
  });

  it('starts again from nothing when what was kept is unreadable', () => {
    const storage = memory();
    storage.setItem('photo-puzzles/rate/v1', '{not json');
    expect(new RateStore(storage).data).toEqual(NO_RATING);
    storage.setItem('photo-puzzles/rate/v1', JSON.stringify({ solved: -4, asked: 'x', rated: 1 }));
    expect(new RateStore(storage).data).toEqual(NO_RATING);
  });
});

describe('where it can be shown', () => {
  it('only in the Android app, which can open its page in the store (not on the web, Steam or itch)', () => {
    expect(canRate(undefined)).toBe(false);
    expect(canRate({})).toBe(false);                                                    // (a shell that cannot)
    expect(canRate({ rateApp: () => undefined })).toBe(true);
    expect(canRate({ rateApp: () => undefined, platform: () => 'ios' })).toBe(false);
    expect(platform(undefined, 'steam')).toBe('steam');
  });
});
