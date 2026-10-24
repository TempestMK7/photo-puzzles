import { describe, expect, it } from 'vitest';
import { isVideoFile } from '../src/image';

describe('isVideoFile', () => {
  it('goes by the type, or by the extension when there is no type', () => {
    expect(isVideoFile({ name: 'a.webm', type: 'video/webm' })).toBe(true);
    expect(isVideoFile({ name: 'a.mp4', type: 'video/mp4' })).toBe(true);
    expect(isVideoFile({ name: 'clip.WEBM', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'clip.mov', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'film.mkv', type: 'video/x-matroska' })).toBe(true);
    expect(isVideoFile({ name: 'film.MKV', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'film.mkv', type: 'application/octet-stream' })).toBe(true);     // what some systems call a file they do not know
    expect(isVideoFile({ name: 'data.bin', type: 'application/octet-stream' })).toBe(false);
    expect(isVideoFile({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
    expect(isVideoFile({ name: 'photo.jpg', type: '' })).toBe(false);
    expect(isVideoFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
  });
});
