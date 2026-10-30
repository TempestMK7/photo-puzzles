import { describe, expect, it, vi } from 'vitest';
import { BLOCKED, MIN_CONFIDENCE, RekognitionModeration, blockedLabel } from '../server/src/aws/rekognition';

describe('blockedLabel', () => {
  it('turns down a label that is on the list, or sits under one, once it is sure enough', () => {
    expect(blockedLabel([{ Name: 'Explicit', ParentName: '', Confidence: 99 }])).toBe('Explicit');
    expect(blockedLabel([{ Name: 'Graphic Violence', ParentName: 'Violence', Confidence: 90 }])).toBe('Violence / Graphic Violence');
    expect(blockedLabel([{ Name: 'Nazi Party', ParentName: 'Hate Symbols', Confidence: MIN_CONFIDENCE }])).toBe('Hate Symbols / Nazi Party');
    expect(blockedLabel([{ Name: 'Corpse', ParentName: 'Visually Disturbing', Confidence: 80 }])).toBe('Visually Disturbing / Corpse');
  });

  it('lets through what is not on the list (a beach, a toast, a game of cards) and what it is not sure of', () => {
    expect(blockedLabel([{ Name: 'Swimwear or Underwear', ParentName: '', Confidence: 99 }, { Name: 'Alcohol', ParentName: '', Confidence: 99 }, { Name: 'Gambling', ParentName: '', Confidence: 95 }])).toBeUndefined();
    expect(blockedLabel([{ Name: 'Explicit', ParentName: '', Confidence: MIN_CONFIDENCE - 1 }])).toBeUndefined();
    expect(blockedLabel([{ Name: 'Explicit' }])).toBeUndefined();                               // no confidence said: not trusted
    expect(blockedLabel([])).toBeUndefined();
    expect(blockedLabel(undefined)).toBeUndefined();
  });

  it('names the categories of Rekognition that a family game does not want', () => {
    expect([...BLOCKED]).toEqual(['Explicit', 'Violence', 'Visually Disturbing', 'Hate Symbols']);
  });
});

describe('RekognitionModeration', () => {
  it('sends the picture and the confidence it wants, and says what was found', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ModerationLabels: [] }).mockResolvedValueOnce({ ModerationLabels: [{ Name: 'Explicit Nudity', ParentName: 'Explicit', Confidence: 97 }] });
    const check = new RekognitionModeration({ send });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await check.check(bytes)).toEqual({ ok: true });
    expect(send.mock.calls[0][0].input).toEqual({ Image: { Bytes: bytes }, MinConfidence: MIN_CONFIDENCE });
    expect(await check.check(bytes)).toEqual({ ok: false, label: 'Explicit / Explicit Nudity' });
  });

  it('lets a failure of the service through to the caller (which does not show the picture)', async () => {
    const check = new RekognitionModeration({ send: vi.fn().mockRejectedValue(new Error('throttled')) });
    await expect(check.check(new Uint8Array([1]))).rejects.toThrow('throttled');
  });
});
