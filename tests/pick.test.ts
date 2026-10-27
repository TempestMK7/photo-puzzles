import { describe, expect, it } from 'vitest';
import { pickAnother } from '../src/core/pick';

const photos = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

describe('pickAnother', () => {
  it('never gives the photo that was just played', () => {
    for (let k = 0; k < 20; k++) expect(pickAnother(photos, 'b', () => false, () => k / 20)!.id).not.toBe('b');
  });

  it('prefers photos not solved yet, and takes any other when all are solved', () => {
    const solved = (e: { id: string }) => e.id !== 'c';
    for (let k = 0; k < 10; k++) expect(pickAnother(photos, 'a', solved, () => k / 10)!.id).toBe('c');
    for (let k = 0; k < 10; k++) expect(pickAnother(photos, 'a', () => true, () => k / 10)!.id).not.toBe('a');
  });

  it('reaches every candidate, and says so when there is no other photo', () => {
    const got = new Set([0, 0.4, 0.7, 0.99].map((r) => pickAnother(photos, 'a', () => false, () => r)!.id));
    expect([...got].sort()).toEqual(['b', 'c', 'd']);
    expect(pickAnother([{ id: 'a' }], 'a', () => false)).toBeUndefined();
    expect(pickAnother([], 'a', () => false)).toBeUndefined();
  });
});
