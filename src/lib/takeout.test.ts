import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { HEADER_BYTES } from './exif';
import {
  filesFromTakeoutZipChunks,
  filesFromTakeoutZips,
  isTakeoutEntry,
  isZipFile,
  normalizeZipPath,
} from './takeout';

const tinyJpeg = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
    'base64',
  ),
);

function zipFile(entries: Record<string, Uint8Array>, name = 'takeout-001.zip'): File {
  return new File([zipSync(entries)], name, { type: 'application/zip' });
}

describe('takeout zip helpers', () => {
  it('recognizes zip names and normalizes archive paths', () => {
    expect(isZipFile(new File([], 'takeout-20260101T000000Z-002.zip'))).toBe(true);
    expect(isZipFile(new File([], 'sunset.jpg'))).toBe(false);
    expect(normalizeZipPath('.\\Takeout\\Google Photos\\a.jpg')).toBe(
      'Takeout/Google Photos/a.jpg',
    );
    expect(isTakeoutEntry('Takeout/Google Photos/a.jpg')).toBe(true);
    expect(isTakeoutEntry('__MACOSX/._a.jpg')).toBe(false);
    expect(isTakeoutEntry('Takeout/archive_browser.html')).toBe(false);
  });

  it('unpacks media and Google sidecars from Takeout ZIP parts', async () => {
    const first = zipFile({
      'Takeout/Google Photos/Trip/sunset.jpg': tinyJpeg,
      'Takeout/Google Photos/Trip/sunset.jpg.supplemental-metadata.json': strToU8(
        '{"title":"sunset.jpg"}',
      ),
      'Takeout/archive_browser.html': strToU8('<html></html>'),
      '__MACOSX/._sunset.jpg': new Uint8Array([1, 2, 3]),
    });
    const second = zipFile(
      {
        'Takeout/Google Photos/Trip/sunset.jpg': tinyJpeg,
        'Takeout/Google Photos/Trip/other.png': tinyJpeg,
      },
      'takeout-002.zip',
    );
    const files = await filesFromTakeoutZips([first, second]);
    expect(files.map((file) => file.path).sort()).toEqual([
      'Takeout/Google Photos/Trip/other.png',
      'Takeout/Google Photos/Trip/sunset.jpg',
      'Takeout/Google Photos/Trip/sunset.jpg.supplemental-metadata.json',
    ]);
    expect(files.find((file) => file.path.endsWith('.json'))?.file.type).toBe(
      'application/json',
    );
  });

  it('keeps only the metadata header of large media files', async () => {
    const large = new Uint8Array(HEADER_BYTES + 50_000);
    large.set(tinyJpeg, 0);
    const files = await filesFromTakeoutZips([
      zipFile({ 'Takeout/Google Photos/big.jpg': large }),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].file.size).toBe(HEADER_BYTES);
  });

  it('unpacks a ZIP from streamed chunks without buffering the archive first', async () => {
    const zip = zipFile({
      'Takeout/Google Photos/Trip/streamed.jpg': tinyJpeg,
    });
    const bytes = new Uint8Array(await zip.arrayBuffer());
    async function* chunks() {
      yield bytes.subarray(0, 32);
      yield bytes.subarray(32);
    }
    const files = await filesFromTakeoutZipChunks(zip.name, chunks());
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('Takeout/Google Photos/Trip/streamed.jpg');
  });
});
