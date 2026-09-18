import { describe, expect, it } from 'vitest';
import {
  parsePhotosExtractRequest,
  tagsFromPickedPhoto,
} from './photos';

describe('Google Photos picker extract', () => {
  it('parses session ids and rejects traversal', () => {
    expect(
      parsePhotosExtractRequest({
        sessionIds: ['abc-123', 'sessions/xyz'],
        mode: 'limited',
      }),
    ).toEqual({
      sessionIds: ['abc-123', 'sessions/xyz'],
      mode: 'limited',
      source: 'google',
    });
    expect(() => parsePhotosExtractRequest({ sessionIds: ['../etc'] })).toThrow(/not valid/i);
    expect(() => parsePhotosExtractRequest({})).toThrow(/Select photos/i);
  });

  it('maps Google Photos metadata into EXIF-style tags', () => {
    const tags = tagsFromPickedPhoto({
      createTime: '2024-06-01T12:00:00.000Z',
      mediaFile: {
        mimeType: 'image/jpeg',
        mediaFileMetadata: {
          width: 4000,
          height: 3000,
          cameraMake: 'Google',
          cameraModel: 'Pixel 8',
          photoMetadata: {
            isoEquivalent: 64,
            apertureFNumber: 1.7,
            focalLength: 6.9,
            exposureTime: '0.008s',
          },
        },
      },
    });
    expect(tags.Make).toBe('Google');
    expect(tags.Model).toBe('Pixel 8');
    expect(tags.ISO).toBe(64);
    expect(tags.FNumber).toBe(1.7);
    expect(tags.ExposureTime).toBe(0.008);
    expect(tags.DateTimeOriginal).toBe('2024-06-01 12:00:00');
  });
});
