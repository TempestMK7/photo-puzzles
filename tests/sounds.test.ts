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

afterEach(() => vi.unstubAllGlobals());

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
});
