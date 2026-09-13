import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { createDataset, csvCell, getTag, makeRow, runtimeAsset } from './dataset';
import {
  applyHemisphere,
  extractCaptureTime,
  extractGps,
  normalizeTags,
  readFileMetadata,
} from './exif';

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function writeEntry(
  view: DataView,
  offset: number,
  tag: number,
  type: number,
  count: number,
  value: number,
) {
  writeU16(view, offset, tag);
  writeU16(view, offset + 2, type);
  writeU32(view, offset + 4, count);
  writeU32(view, offset + 8, value);
}

function writeRational(view: DataView, offset: number, num: number, den: number) {
  writeU32(view, offset, num);
  writeU32(view, offset + 4, den);
}

function buildGpsTiff(): Uint8Array {
  const bytes = new Uint8Array(230);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  bytes[2] = 0x2a;
  writeU32(view, 4, 8);

  writeU16(view, 8, 2);
  writeEntry(view, 10, 0x8769, 4, 1, 38);
  writeEntry(view, 22, 0x8825, 4, 1, 96);

  writeU16(view, 38, 2);
  writeEntry(view, 40, 36867, 2, 20, 68);
  writeEntry(view, 52, 36881, 2, 7, 88);
  bytes.set(new TextEncoder().encode('2024:06:01 12:00:00\0'), 68);
  bytes.set(new TextEncoder().encode('+01:00\0'), 88);

  writeU16(view, 96, 6);
  writeEntry(view, 98, 1, 2, 2, 0x4e);
  writeEntry(view, 110, 2, 5, 3, 174);
  writeEntry(view, 122, 3, 2, 2, 0x45);
  writeEntry(view, 134, 4, 5, 3, 198);
  writeEntry(view, 146, 5, 1, 1, 0);
  writeEntry(view, 158, 6, 5, 1, 222);
  writeRational(view, 174, 41, 1);
  writeRational(view, 182, 53, 1);
  writeRational(view, 190, 24, 1);
  writeRational(view, 198, 12, 1);
  writeRational(view, 206, 29, 1);
  writeRational(view, 214, 24, 1);
  writeRational(view, 222, 45, 1);
  return bytes;
}

const tinyJpeg = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=',
    'base64',
  ),
);

describe('dataset helpers', () => {
  it('prefers signed composite GPS and protects CSV cells', () => {
    expect(getTag({ 'EXIF:GPSLongitude': 0.12, 'Composite:GPSLongitude': -0.12 }, ['GPSLongitude'])).toBe(-0.12);
    expect(csvCell('=HYPERLINK("bad")')).toContain("'=HYPERLINK");
  });

  it('resolves runtime assets under the configured base path', () => {
    expect(runtimeAsset('runtime/sql-wasm.wasm')).toMatch(/runtime\/sql-wasm\.wasm$/);
    expect(runtimeAsset('runtime/sql-wasm-browser.wasm')).toMatch(
      /runtime\/sql-wasm-browser\.wasm$/,
    );
  });

  it('maps decimal GPS from a JS parser payload', () => {
    const tags = normalizeTags({
      DateTimeOriginal: new Date('2024-06-01T12:00:00.000Z'),
      latitude: 41.89,
      longitude: 12.49,
      Make: 'Apple',
    });
    expect(tags.GPSLatitude).toBe(41.89);
    expect(tags.GPSLongitude).toBe(12.49);
    expect(getTag(tags, ['GPSLatitude'])).toBe(41.89);
    expect(tags.DateTimeOriginal).toBe('2024-06-01T12:00:00.000Z');
  });

  it('decodes GPS IFD tags 1-6 and DateTimeOriginal with offset', () => {
    expect(
      extractGps({
        1: 'S',
        2: [
          [41, 1],
          [53, 1],
          [24, 1],
        ],
        3: 'W',
        4: [
          [12, 1],
          [29, 1],
          [24, 1],
        ],
        5: Uint8Array.from([1]),
        6: [120, 2],
      }),
    ).toEqual({
      latitude: -(41 + 53 / 60 + 24 / 3600),
      longitude: -(12 + 29 / 60 + 24 / 3600),
      altitude_m: -60,
    });
    expect(
      extractCaptureTime({
        36867: '2024:06:01 12:00:00\x00',
        36881: '+02:00\x00',
      }),
    ).toBe('2024:06:01 12:00:00+02:00');
    expect(extractCaptureTime({ DateTimeOriginal: '2024:06:01 12:00:00' })).toBe(
      '2024:06:01 12:00:00',
    );
  });

  it('applies W/S hemisphere without double-flipping signed values', () => {
    expect(applyHemisphere(71.40340555555557, 'W', 'W')).toBeCloseTo(-71.40340555555557, 8);
    expect(applyHemisphere(-71.40340555555557, 'West', 'W')).toBeCloseTo(-71.40340555555557, 8);
    expect(applyHemisphere(41.827, 'N', 'S')).toBeCloseTo(41.827, 8);
    expect(
      extractGps({
        GPSLatitude: 41.82714444444445,
        GPSLatitudeRef: 'N',
        GPSLongitude: 71.40340555555557,
        GPSLongitudeRef: 'W',
        latitude: 41.82714444444445,
        longitude: -71.40340555555557,
      }).longitude,
    ).toBeCloseTo(-71.40340555555557, 8);
    const tags = normalizeTags({
      GPSLatitude: 41.82714444444445,
      GPSLatitudeRef: 'N',
      GPSLongitude: 71.40340555555557,
      GPSLongitudeRef: 'W',
      latitude: 41.82714444444445,
      longitude: -71.40340555555557,
    });
    expect(tags.GPSLongitude).toBeCloseTo(-71.40340555555557, 8);
    const file = new File([tinyJpeg], 'IMG_0801.HEIC', { type: 'image/heic' });
    const row = makeRow(tags, { file, path: 'IMG_0801.HEIC' }, 'full', 'apple', 'person', 'photo');
    expect(row.longitude).toBeCloseTo(-71.40340555555557, 8);
    expect(row.latitude).toBeCloseTo(41.82714444444445, 8);
  });

  it('marks rows ok when time or GPS exist, warning when they do not', () => {
    const file = new File([tinyJpeg], 'named.jpg', { type: 'image/jpeg' });
    const input = { file, path: 'folder/named.jpg' };
    expect(
      makeRow(
        { DateTimeOriginal: '2024:06:01 12:00:00+01:00' },
        input,
        'full',
        'apple',
        'person',
        'photo',
      ).status,
    ).toBe('ok');
    expect(
      makeRow({ 'EXIF:GPSLatitude': 51.5 }, input, 'full', 'apple', 'person', 'photo').status,
    ).toBe('ok');
    expect(makeRow({ Error: 'parser failed' }, input, 'full', 'apple', 'person', 'photo').status).toBe(
      'warning',
    );
    const limited = makeRow(
      { 'EXIF:GPSLatitude': 51.5 },
      input,
      'limited',
      'apple',
      'person',
      'photo',
    );
    expect(limited.status).toBe('ok');
    expect(limited.latitude).toBeNull();
  });

  it('reads GPS from a TIFF GPS IFD even when wrapped like HEIC Exif', async () => {
    const tiff = buildGpsTiff();
    const wrapped = new Uint8Array(8 + tiff.length);
    wrapped.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 2);
    wrapped.set(tiff, 8);
    const tags = await readFileMetadata(new File([wrapped], 'photo.heic', { type: 'image/heic' }));
    expect(Number(getTag(tags, ['GPSLatitude']))).toBeCloseTo(41 + 53 / 60 + 24 / 3600, 6);
    expect(Number(getTag(tags, ['GPSLongitude']))).toBeCloseTo(12 + 29 / 60 + 24 / 3600, 6);
    expect(getTag(tags, ['DateTimeOriginal'])).toBe('2024:06:01 12:00:00+01:00');
  });

  it('extracts GPS and camera tags from a JPEG header', async () => {
    const buf = await readFile(resolve('src/lib/exif-sample.jpg'));
    const tags = await readFileMetadata(
      new File([buf], 'exif-sample.jpg', { type: 'image/jpeg' }),
    );
    expect(Number(getTag(tags, ['GPSLatitude']))).toBeCloseTo(41.89, 1);
    expect(Number(getTag(tags, ['GPSLongitude']))).toBeCloseTo(12.49, 1);
    expect(getTag(tags, ['Make'])).toMatch(/Apple/i);
  });

  it('removes identifying fields in limited rows', () => {
    const file = new File([tinyJpeg], 'named.jpg', { type: 'image/jpeg' });
    const row = makeRow({ 'EXIF:GPSLatitude': 51.5, 'EXIF:LensModel': 'Personal lens' }, { file, path: 'folder/named.jpg' }, 'limited', 'apple', 'person', 'photo');
    expect(row.file_name).toBeNull();
    expect(row.latitude).toBeNull();
    expect(row.lens).toBeNull();
  });

  it('creates a valid limited ZIP with SQLite, CSV and matched Google time', async () => {
    const sqlite = resolve('public/runtime/sql-wasm.wasm');
    const files = [
      { file: new File([tinyJpeg], 'image.jpg', { type: 'image/jpeg' }), path: 'album/image.jpg' },
      { file: new File([JSON.stringify({ title: 'image.jpg', description: 'Private text', photoTakenTime: { timestamp: '1717243200' } })], 'image.jpg.supplemental-metadata.json'), path: 'album/image.jpg.supplemental-metadata.json' },
    ];
    const result = await createDataset(files, 'limited', 'google', () => undefined, () => sqlite);
    const archive = unzipSync(result.archive);
    expect(Object.keys(archive).sort()).toEqual(['README.txt', 'manifest.json', 'metadata.jsonl', 'photos.csv', 'photos.sqlite', 'queries.sql', 'sidecars.jsonl'].sort());
    expect(strFromU8(archive['metadata.jsonl'])).not.toContain('Private text');
    expect(strFromU8(archive['metadata.jsonl'])).not.toContain('image.jpg');
    const SQL = await initSqlJs({ locateFile: () => sqlite });
    const db = new SQL.Database(archive['photos.sqlite']);
    expect(db.exec('PRAGMA integrity_check')[0].values[0][0]).toBe('ok');
    expect(db.exec('SELECT gallery_capture_time_utc FROM photos')[0].values[0][0]).toBe('2024-06-01T12:00:00.000Z');
    db.close();
  }, 30_000);

  it('retains sidecar text in full mode', async () => {
    const sqlite = resolve('public/runtime/sql-wasm.wasm');
    const files = [
      { file: new File([tinyJpeg], 'image.jpg', { type: 'image/jpeg' }), path: 'album/image.jpg' },
      { file: new File([JSON.stringify({ title: 'image.jpg', description: 'Consented caption' })], 'image.jpg.json'), path: 'album/image.jpg.json' },
    ];
    const result = await createDataset(files, 'full', 'google', () => undefined, () => sqlite);
    const archive = unzipSync(result.archive);
    expect(strFromU8(archive['sidecars.jsonl'])).toContain('Consented caption');
    expect(strFromU8(archive['metadata.jsonl'])).toContain('image.jpg');
  }, 30_000);
});
