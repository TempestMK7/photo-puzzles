import { afterEach, describe, expect, it, vi } from 'vitest';
import { Autosave } from '../src/store/autosave';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const saved: number[] = [];
  const clock = () => Date.now();
  const a = new Autosave(() => saved.push(Date.now()), 1500, 5000, clock);
  return { a, saved };
}

describe('Autosave', () => {
  it('keeps the puzzle once the player has been still for a second and a half', () => {
    const { a, saved } = setup();
    a.touch();
    vi.advanceTimersByTime(1499);
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saved).toHaveLength(1);
  });

  it('waits again for every move while the player keeps going, but never past five seconds from the first move that was not kept', () => {
    const { a, saved } = setup();
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {                                         // a move every second, for 20 seconds
      a.touch();
      vi.advanceTimersByTime(1000);
    }
    expect(saved.length).toBeGreaterThanOrEqual(3);
    expect(saved[0] - t0).toBeLessThanOrEqual(5000);
    expect(saved[0] - t0).toBeGreaterThanOrEqual(4000);
    for (let i = 1; i < saved.length; i++) expect(saved[i] - saved[i - 1]).toBeLessThanOrEqual(5000);
  });

  it('does not keep it again when nothing has happened since it was kept', () => {
    const { a, saved } = setup();
    a.touch();
    vi.advanceTimersByTime(2000);
    expect(saved).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    a.flush();                                                             // (the page is hidden: nothing is new)
    expect(saved).toHaveLength(1);
  });

  it('keeps it at once when asked, if something is waiting, and then not again', () => {
    const { a, saved } = setup();
    a.touch();
    a.flush();
    expect(saved).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(saved).toHaveLength(1);
    a.flush();
    expect(saved).toHaveLength(1);
  });

  it('forgets what is waiting when reset, and counts the five seconds from the next move', () => {
    const { a, saved } = setup();
    a.touch();
    vi.advanceTimersByTime(1000);
    a.reset();
    vi.advanceTimersByTime(10_000);
    expect(saved).toEqual([]);
    const t1 = Date.now();
    a.touch();
    vi.advanceTimersByTime(1500);
    expect(saved).toEqual([t1 + 1500]);
  });
});
