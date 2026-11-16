import { describe, expect, it } from 'vitest';
import { howtoNew, nextStep, NO_PROGRESS, type Progress, type Situation } from '../src/core/tutorial';
import { TutorialStore } from '../src/store/tutorial';

const here = (more: Partial<Situation> = {}): Situation => ({ helpers: true, hints: 5, bombs: 1, adReady: true, stuck: true, ...more });
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

  it('points out the hint and the bomb when the player is stuck, not at the start; a bubble that is showing stays when they make progress', () => {
    expect(nextStep(seen(), here({ stuck: false }))).toBeNull();
    expect(nextStep(seen({ hint: true }), here({ stuck: false }))).toBeNull();                 // (not the bomb either: it waits for a stall like the hint)
    expect(nextStep(seen(), here({ stuck: false }), 'hint')).toBe('hint');
    expect(nextStep(seen({ hint: true }), here({ stuck: false }), 'bomb')).toBe('bomb');
    expect(nextStep(NO_PROGRESS, here({ stuck: false }))).toBe('howto');                       // (How To Play does not wait)
    expect(nextStep(seen({ hint: true, bomb: true }), here({ stuck: false }))).toBe('ad');     // (nor does the ad, which follows both having been tried)
  });

  it('shows each bubble once: one that has been shown is not shown in the next puzzle, even if it was not acted on, and the next step takes its place', () => {
    expect(nextStep(seen({ told: ['hint'] }), here())).toBe('bomb');                           // (the hint bubble was shown, not used)
    expect(nextStep(seen({ told: ['hint', 'bomb'] }), here())).toBeNull();
    expect(nextStep({ ...NO_PROGRESS, told: ['howto'] }, here())).toBe('hint');                // (How To Play told but never pressed: the rest are not held back by it)
    expect(nextStep({ ...NO_PROGRESS, told: ['howto', 'hint', 'bomb'] }, here())).toBeNull();
    expect(nextStep(seen({ hint: true, bomb: true, told: ['ad'] }), here())).toBeNull();
  });

  it('keeps the bubble that is on the screen until it is put away or done, though it has been told', () => {
    expect(nextStep(seen({ told: ['hint'] }), here(), 'hint')).toBe('hint');
    expect(nextStep({ ...NO_PROGRESS, told: ['howto'] }, here(), 'howto')).toBe('howto');
    expect(nextStep(seen({ hint: true, told: ['hint'] }), here(), 'hint')).toBe('bomb');       // (done: the next)
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
    expect(b.data).toEqual({ howto: ['jigsaw'], hint: true, bomb: false, ad: false, told: [] });
  });

  it('remembers which bubbles were shown, and ignores what is not a step', () => {
    const storage = memory();
    const a = new TutorialStore(storage);
    a.tell('hint');
    a.tell('hint');
    a.tell('ad');
    expect(new TutorialStore(storage).data.told).toEqual(['hint', 'ad']);
    storage.setItem('photo-puzzles/tutorial/v1', JSON.stringify({ howto: [], told: ['bomb', 'nonsense', 4] }));
    expect(new TutorialStore(storage).data.told).toEqual(['bomb']);
    storage.setItem('photo-puzzles/tutorial/v1', JSON.stringify({ howto: ['jigsaw'], hint: true }));       // (kept before `told` existed)
    expect(new TutorialStore(storage).data.told).toEqual([]);
  });

  it('starts over when what was kept is unreadable', () => {
    const storage = memory();
    storage.setItem('photo-puzzles/tutorial/v1', '{nonsense');
    expect(new TutorialStore(storage).data).toEqual(NO_PROGRESS);
    expect(new TutorialStore(null).data).toEqual(NO_PROGRESS);
  });
});
