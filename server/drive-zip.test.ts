import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { filesFromZipBytes, formatBytes, locateZipDirectory } from './drive-zip';

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

  it('reads a prefix from a large deflated photo without requiring the whole stream', async () => {
    const payload = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 47) & 255;
    const zip = zipSync({
      'Takeout/Google Photos/Trip/huge.jpg': payload,
    });
    const files = await filesFromZipBytes(zip, 'takeout-deflate.zip');
    expect(files).toHaveLength(1);
    expect(files[0]?.file.size).toBeGreaterThan(1024);
    expect(files[0]?.file.size).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('locates the central directory from the ZIP tail', () => {
    const zip = zipSync({
      'Takeout/Google Photos/Trip/sunset.jpg': tinyJpeg,
    });
    const tail = zip.subarray(Math.max(0, zip.byteLength - 128 * 1024));
    const location = locateZipDirectory(tail, zip.byteLength);
    expect(location.entryCount).toBe(1);
    expect(location.cdOffset).toBeGreaterThanOrEqual(0);
    expect(location.cdOffset + location.cdSize).toBeLessThanOrEqual(zip.byteLength);
    expect(zip[location.cdOffset]).toBe(0x50);
    expect(zip[location.cdOffset + 1]).toBe(0x4b);
  });
});
