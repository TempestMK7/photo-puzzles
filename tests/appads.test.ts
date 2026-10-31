import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('app-ads.txt (the file that tells AdMob the website vouches for the app)', () => {
  it('says that Google may sell the game\u2019s ads, in the one form AdMob reads, with the publisher id from the AdMob console', () => {
    const text = readFileSync('public/app-ads.txt', 'utf8');
    expect(text).toMatch(/^google\.com, pub-\d{16}, DIRECT, f08c47fec0942fa0\n$/);
  });
});
