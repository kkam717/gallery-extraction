import { describe, expect, it } from 'vitest';
import {
  ANDROID_PHOTO_PICKER_MAX,
  emptyLibrary,
  galleryItemKey,
  isPhotoPickerCap,
  mergeLibraries,
  parseGalleryItems,
  phonePlatform,
} from './gallery';

const tinyJpeg = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
    'base64',
  ),
);

describe('phone gallery ingest', () => {
  it('reads EXIF from a gallery photo and keeps the original file size', async () => {
    const file = new File([tinyJpeg], 'IMG_1001.HEIC', { type: 'image/heic' });
    const { library, added } = await parseGalleryItems([{ file, path: file.name }]);
    expect(added).toBe(1);
    expect(library.media).toHaveLength(1);
    expect(library.media[0]?.path).toBe('IMG_1001.HEIC');
    expect(library.media[0]?.fileBytes).toBe(file.size);
  });

  it('skips duplicates when the same photo is selected again', async () => {
    const file = new File([tinyJpeg], 'IMG_1001.jpg', { type: 'image/jpeg' });
    const seen = new Set([galleryItemKey(file, file.name)]);
    const { added, skipped } = await parseGalleryItems([{ file, path: file.name }], () => undefined, seen);
    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  it('merges later camera-roll batches into the library', () => {
    const first = emptyLibrary();
    first.media.push({ path: 'a.jpg', fileBytes: 12, raw: {}, failed: false });
    const merged = mergeLibraries(first, {
      media: [
        { path: 'a.jpg', fileBytes: 12, raw: {}, failed: false },
        { path: 'b.jpg', fileBytes: 20, raw: {}, failed: false },
      ],
      sidecars: [],
    });
    expect(merged.media.map((file) => file.path)).toEqual(['a.jpg', 'b.jpg']);
  });

  it('detects Android Chrome and the 100-item Photos picker cap', () => {
    expect(phonePlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0.0.0')).toBe(
      'android',
    );
    expect(phonePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios');
    expect(phonePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', true)).toBe('ios');
    expect(phonePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false)).toBe('other');
    expect(isPhotoPickerCap(ANDROID_PHOTO_PICKER_MAX)).toBe(true);
    expect(isPhotoPickerCap(99)).toBe(false);
  });

  it('can JSON-clone parsed EXIF so the worker can assemble the dataset', async () => {
    const file = new File([tinyJpeg], 'roll.jpg', { type: 'image/jpeg' });
    const { library } = await parseGalleryItems([{ file, path: file.name }]);
    const cloned = JSON.parse(JSON.stringify(library)) as typeof library;
    expect(cloned.media[0]?.path).toBe('roll.jpg');
    expect(cloned.media[0]?.fileBytes).toBe(file.size);
  });
});
