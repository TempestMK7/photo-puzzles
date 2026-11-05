import { describe, expect, it } from 'vitest';
import { howtoNew, nextStep, NO_PROGRESS, type Progress, type Situation } from '../src/core/tutorial';
import { TutorialStore } from '../src/store/tutorial';

const here = (more: Partial<Situation> = {}): Situation => ({ helpers: true, hints: 5, bombs: 1, adReady: true, ...more });
const seen = (more: Partial<Progress> = {}): Progress => ({ ...NO_PROGRESS, howto: ['jigsaw'], ...more });

describe('what the screen points out next', () => {
  it('starts with How To Play, until it has been pressed in any puzzle', () => {
    expect(nextStep(NO_PROGRESS, here())).toBe('howto');
    expect(nextStep(NO_PROGRESS, here({ helpers: false }))).toBe('howto');
    expect(nextStep(seen(), here())).toBe('hint');
  });

  it('goes from the hint to the bomb, and then to the ad', () => {
    expect(nextStep(seen(), here())).toBe('hint');
    expect(nextStep(seen({ hint: true }), here())).toBe('bomb');
    expect(nextStep(seen({ hint: true, bomb: true }), here())).toBe('ad');
    expect(nextStep(seen({ hint: true, bomb: true, ad: true }), here())).toBeNull();
  });

  it('skips an item the player has none of, and does not point at the ad before the first two have been tried', () => {
    expect(nextStep(seen(), here({ hints: 0 }))).toBe('bomb');
    expect(nextStep(seen({ hint: true }), here({ bombs: 0 }))).toBeNull();                       // out of bombs, hints still left: nothing to teach yet
    expect(nextStep(seen({ hint: true }), here({ hints: 0, bombs: 0 }))).toBe('ad');            // out of both after trying one: the ad is the way to more
    expect(nextStep(seen(), here({ hints: 0, bombs: 0 }))).toBeNull();                           // never tried either: no ad walk-through yet
  });

  it('only points at the ad while one can be watched, and only where hints and bombs work', () => {
    expect(nextStep(seen({ hint: true, bomb: true }), here({ adReady: false }))).toBeNull();
    expect(nextStep(seen(), here({ helpers: false }))).toBeNull();
  });

  it('lights the button of each kind of puzzle until it has been pressed there', () => {
    expect(howtoNew(seen(), 'jigsaw')).toBe(false);
    expect(howtoNew(seen(), 'overlap')).toBe(true);
  });
});

describe('what is kept', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it('is remembered, and told to a listener', () => {
    const storage = memory();
    const a = new TutorialStore(storage);
    let told = 0;
    a.onChange(() => told++);
    a.seenHowto('jigsaw');
    a.seenHowto('jigsaw');
    a.done('hint');
    expect(told).toBe(2);
    const b = new TutorialStore(storage);
    expect(b.data).toEqual({ howto: ['jigsaw'], hint: true, bomb: false, ad: false });
  });

  it('starts over when what was kept is unreadable', () => {
    const storage = memory();
    storage.setItem('photo-puzzles/tutorial/v1', '{nonsense');
    expect(new TutorialStore(storage).data).toEqual(NO_PROGRESS);
    expect(new TutorialStore(null).data).toEqual(NO_PROGRESS);
  });
});
