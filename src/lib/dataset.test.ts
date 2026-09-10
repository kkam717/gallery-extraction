import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { createDataset, csvCell, getTag, makeRow, runtimeAsset } from './dataset';
import { normalizeTags, readFileMetadata } from './exif';

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
