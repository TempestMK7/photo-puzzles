import { describe, expect, it } from 'vitest';
import { qrMatrix, qrPath } from '../src/ui/qr';

describe('qrPath', () => {
  it('draws a run of dark squares in a row as one rectangle, after the quiet zone', () => {
    expect(qrPath([[true, true, false], [false, true, true]], 0)).toBe('M0 0h2v1h-2zM1 1h2v1h-2z');
    expect(qrPath([[false, true, false, true]], 4)).toBe('M5 4h1v1h-1zM7 4h1v1h-1z');
    expect(qrPath([[false, false]])).toBe('');
  });
});

describe('qrMatrix', () => {
  const link = 'https://puzzlevid.io/#/join/48213~k7m2q9x4h3p8w5d6n2c9';

  it('makes a square of a size that a QR code can have, with the three corner marks that a scanner looks for', async () => {
    const m = await qrMatrix(link);
    const n = m.length;
    expect(m.every((row) => row.length === n)).toBe(true);
    expect((n - 17) % 4).toBe(0);                                                      // 21, 25, 29 ... squares: version 1, 2, 3 ...
    const mark = (r0: number, c0: number) => [m[r0][c0], m[r0][c0 + 6], m[r0 + 6][c0], m[r0 + 6][c0 + 6], m[r0 + 3][c0 + 3], m[r0 + 1][c0 + 1]];
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) expect(mark(r, c)).toEqual([true, true, true, true, true, false]);
  });

  it('is the same for the same text, and not for another', async () => {
    expect(await qrMatrix(link)).toEqual(await qrMatrix(link));
    expect(await qrMatrix(link)).not.toEqual(await qrMatrix(link.replace('48213', '48214')));
  });

  it('has room for a link of the length that the game makes', async () => {
    expect((await qrMatrix(`https://dev.puzzlevid.io/#/join/48213~${'x'.repeat(32)}`)).length).toBeLessThanOrEqual(41);        // up to version 6
  });
});
