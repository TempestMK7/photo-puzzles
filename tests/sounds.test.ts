import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Effect } from '../src/sounds';

const EFFECTS: Effect[] = ['solved', 'placed', 'select', 'pickup', 'drop', 'wrong'];

/** A stand-in for the browser's Audio that notes which files were started, and a fresh copy of the module (which keeps its players). */
async function load() {
  const played: string[] = [];
  class FakeAudio {
    currentTime = 5;
    preload = '';
    constructor(readonly src: string) {}
    play(): Promise<void> {
      played.push(this.src);
      return Promise.resolve();
    }
  }
  vi.stubGlobal('Audio', FakeAudio);
  vi.resetModules();
  return { played, sounds: await import('../src/sounds') };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sound effects', () => {
  it('has a file of its own for every effect', async () => {
    const { played, sounds } = await load();
    for (const e of EFFECTS) sounds.playEffect(e);
    expect(played).toHaveLength(EFFECTS.length);
    expect(new Set(played).size).toBe(EFFECTS.length);
  });

  it('plays an effect from its start, and not at all while effects are switched off', async () => {
    const { played, sounds } = await load();
    sounds.playEffect('pickup');
    sounds.playEffect('pickup');
    expect(played).toHaveLength(2);
    sounds.setEffectsOn(false);
    sounds.playEffect('placed');
    expect(played).toHaveLength(2);
    sounds.setEffectsOn(true);
    sounds.playEffect('placed');
    expect(played).toHaveLength(3);
  });

  it('plays an effect after the delay it was asked for, and not before', async () => {
    vi.useFakeTimers();
    const { played, sounds } = await load();
    sounds.playEffect('placed', 300);
    expect(played).toHaveLength(0);
    vi.advanceTimersByTime(299);
    expect(played).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(played).toHaveLength(1);
  });

  it('rings a row of bells one after the other, and drops those that have not begun when the puzzle is left', async () => {
    vi.useFakeTimers();
    const { played, sounds } = await load();
    for (let k = 0; k < 4; k++) sounds.playEffect('placed', 100 + k * 200);
    vi.advanceTimersByTime(300);
    expect(played).toHaveLength(2);
    sounds.cancelEffects();
    vi.advanceTimersByTime(5000);
    expect(played).toHaveLength(2);
  });

  it('does not ring a delayed effect that was switched off before its time', async () => {
    vi.useFakeTimers();
    const { played, sounds } = await load();
    sounds.playEffect('placed', 100);
    sounds.setEffectsOn(false);
    vi.advanceTimersByTime(200);
    expect(played).toHaveLength(0);
  });

  it('lets a bell that is still sounding go on when it is rung again', async () => {
    const played: string[] = [];
    const made: FakeSounding[] = [];
    class FakeSounding {
      currentTime = 0;
      paused = true;
      preload = '';
      constructor(readonly src: string) {
        made.push(this);
      }
      play(): Promise<void> {
        this.paused = false;
        played.push(this.src);
        return Promise.resolve();
      }
    }
    vi.stubGlobal('Audio', FakeSounding);
    vi.resetModules();
    const sounds = await import('../src/sounds');
    sounds.playEffect('placed');
    const first = made.length;
    sounds.playEffect('placed');                                  // the first is still sounding: a second player takes this one
    expect(made.length).toBe(first + 1);
    expect(played).toHaveLength(2);
  });
});
