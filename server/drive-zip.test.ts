import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { filesFromZipBytes, formatBytes } from './drive-zip';

const tinyJpeg = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
    'base64',
  ),
);

describe('drive zip range extraction', () => {
  it('reads media and sidecars from a ZIP without loading unused files', async () => {
    const zip = zipSync({
      'Takeout/Google Photos/Trip/sunset.jpg': tinyJpeg,
      'Takeout/Google Photos/Trip/sunset.jpg.supplemental-metadata.json': strToU8(
        '{"title":"sunset.jpg"}',
      ),
      'Takeout/archive_browser.html': strToU8('<html></html>'),
    });
    const files = await filesFromZipBytes(zip, 'takeout-001.zip');
    expect(files.map((file) => file.path).sort()).toEqual([
      'Takeout/Google Photos/Trip/sunset.jpg',
      'Takeout/Google Photos/Trip/sunset.jpg.supplemental-metadata.json',
    ]);
  });

  it('formats archive sizes for progress', () => {
    expect(formatBytes(49.67 * 1024 * 1024 * 1024)).toMatch(/GB/);
    expect(formatBytes(367 * 1024)).toMatch(/KB/);
  });
});
