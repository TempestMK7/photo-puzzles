import { afterEach, describe, expect, it, vi } from 'vitest';
import { canHaptic, haptic } from '../src/haptics';

afterEach(() => vi.unstubAllGlobals());

describe('haptics', () => {
  it('prefers the host app\'s own effects, and tells it which one', () => {
    const calls: string[] = [];
    const vibrate = vi.fn(() => true);
    vi.stubGlobal('window', { PhotoPuzzlesNative: { haptic: (k: string) => calls.push(k) } });
    vi.stubGlobal('navigator', { vibrate });
    haptic('grab');
    haptic('placed');
    expect(calls).toEqual(['grab', 'placed']);
    expect(vibrate).not.toHaveBeenCalled();
    expect(canHaptic()).toBe(true);
  });

  it('otherwise vibrates, with a longer buzz for a bigger moment', () => {
    const seen: (number | number[])[] = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { vibrate: (p: number | number[]) => seen.push(p) });
    haptic('grab');
    haptic('placed');
    haptic('solved');
    expect(seen[0]).toBeGreaterThanOrEqual(30);                     // short buzzes of ~10 ms are not felt on many phones
    expect(Array.isArray(seen[1]) && seen[1].length).toBe(3);
    expect(Array.isArray(seen[2]) && seen[2].length).toBeGreaterThan(3);
    expect(canHaptic()).toBe(true);
  });

  it('does nothing, and does not fail, where there is nothing to buzz with or the device refuses', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    expect(() => haptic('drop')).not.toThrow();
    expect(canHaptic()).toBe(false);
    vi.stubGlobal('navigator', { vibrate: () => { throw new Error('not allowed'); } });
    expect(() => haptic('drop')).not.toThrow();
    vi.stubGlobal('window', { PhotoPuzzlesNative: { haptic: () => { throw new Error('gone'); } } });
    expect(() => haptic('join')).not.toThrow();
  });
});
