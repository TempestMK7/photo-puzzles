import { describe, expect, it } from 'vitest';
import { isVideoFile } from '../src/image';

describe('isVideoFile', () => {
  it('goes by the type, or by the extension when there is no type', () => {
    expect(isVideoFile({ name: 'a.webm', type: 'video/webm' })).toBe(true);
    expect(isVideoFile({ name: 'a.mp4', type: 'video/mp4' })).toBe(true);
    expect(isVideoFile({ name: 'clip.WEBM', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'clip.mov', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
    expect(isVideoFile({ name: 'photo.jpg', type: '' })).toBe(false);
    expect(isVideoFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });
});
