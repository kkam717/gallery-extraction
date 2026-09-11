import { Readable } from 'node:stream';
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { InputFile } from '../src/lib/dataset';
import { isTakeoutEntry, takeoutInputFile, takeoutKeepLimit } from '../src/lib/takeout';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as typeof import('yauzl');
const inflateRawAsync = promisify(inflateRaw);

const STORE = 0;
const DEFLATE = 8;
const LOCAL_HEADER = 30;
const ENTRY_CONCURRENCY = 8;
const DEFLATE_PAD = 128 * 1024;

export type DriveZipRef = {
  id: string;
  name: string;
};

export type ZipProgress = {
  phase: string;
  completed: number;
  total: number;
};

type ZipEntry = import('yauzl').Entry;

class DriveRangeReader extends yauzl.RandomAccessReader {
  constructor(
    private readonly fileId: string,
    private readonly token: string,
  ) {
    super();
  }

  _readStreamForRange(start: number, end: number): Readable {
    const stream = new Readable({ read() {} });
    const url = driveMediaUrl(this.fileId);
    const token = this.token;
    void (async () => {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Range: `bytes=${start}-${end - 1}`,
          },
        });
        if (response.status !== 206) {
          throw new Error('Google Drive did not return the requested ZIP range.');
        }
        if (!response.body) {
          throw new Error('Google Drive returned no ZIP data.');
        }
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) stream.push(value);
        }
        stream.push(null);
      } catch (error) {
        stream.destroy(error instanceof Error ? error : new Error('Drive range read failed.'));
      }
    })();
    return stream;
  }
}

class BufferRangeReader extends yauzl.RandomAccessReader {
  constructor(private readonly bytes: Uint8Array) {
    super();
  }

  _readStreamForRange(start: number, end: number): Readable {
    return Readable.from([this.bytes.subarray(start, end)]);
  }
}

function driveMediaUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

function driveMetaUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size,name&supportsAllDrives=true`;
}

async function driveFileSize(fileId: string, token: string): Promise<number> {
  const response = await fetch(driveMetaUrl(fileId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error('Could not read the Takeout ZIP size from Google Drive.');
  }
  const body = (await response.json()) as { size?: string };
  const size = Number(body.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('That Drive file has no size. Select the takeout-*.zip files themselves.');
  }
  return size;
}

async function readRange(
  fileId: string,
  token: string,
  start: number,
  length: number,
): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array();
  const response = await fetch(driveMediaUrl(fileId), {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: `bytes=${start}-${start + length - 1}`,
    },
  });
  if (response.status !== 206) {
    throw new Error('Google Drive did not return the requested photo header.');
  }
  return new Uint8Array(await response.arrayBuffer());
}

function openZip(
  reader: InstanceType<typeof yauzl.RandomAccessReader>,
  size: number,
): Promise<import('yauzl').ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromRandomAccessReader(
      reader,
      size,
      { lazyEntries: true, autoClose: false, validateEntrySizes: false },
      (error, zip) => {
        if (error || !zip) {
          reject(error || new Error('The Takeout ZIP index could not be read.'));
          return;
        }
        resolve(zip);
      },
    );
  });
}

function listEntries(zip: import('yauzl').ZipFile): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ZipEntry[] = [];
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', (entry: ZipEntry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function dataOffset(localHeader: Uint8Array): number {
  if (localHeader.length < LOCAL_HEADER) {
    throw new Error('The ZIP local header is truncated.');
  }
  const nameLength = localHeader[26]! | (localHeader[27]! << 8);
  const extraLength = localHeader[28]! | (localHeader[29]! << 8);
  return LOCAL_HEADER + nameLength + extraLength;
}

async function inflateLimited(compressed: Uint8Array, limit: number): Promise<Uint8Array> {
  const inflated = await inflateRawAsync(Buffer.from(compressed));
  return inflated.length > limit ? Uint8Array.from(inflated.subarray(0, limit)) : Uint8Array.from(inflated);
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function extractEntries(
  entries: ZipEntry[],
  read: (start: number, length: number) => Promise<Uint8Array>,
  progress: (update: ZipProgress) => void,
  zipName: string,
): Promise<InputFile[]> {
  const wanted = entries.filter((entry) => isTakeoutEntry(entry.fileName));
  const files: InputFile[] = [];
  let completed = 0;
  const extracted = await mapPool(wanted, ENTRY_CONCURRENCY, async (entry) => {
    const limit = Math.min(takeoutKeepLimit(entry.fileName), Number(entry.uncompressedSize) || takeoutKeepLimit(entry.fileName));
    const header = await read(entry.relativeOffsetOfLocalHeader, 2048);
    const start = entry.relativeOffsetOfLocalHeader + dataOffset(header);
    let bytes: Uint8Array;
    if (entry.compressionMethod === STORE) {
      bytes = await read(start, limit);
    } else if (entry.compressionMethod === DEFLATE) {
      const compressedNeed = Math.min(Number(entry.compressedSize) || limit + DEFLATE_PAD, limit + DEFLATE_PAD);
      bytes = await inflateLimited(await read(start, compressedNeed), limit);
    } else {
      return null;
    }
    completed += 1;
    if (completed % 8 === 0 || completed === wanted.length) {
      progress({
        phase: `Reading photos in ${zipName}…`,
        completed,
        total: wanted.length,
      });
    }
    return takeoutInputFile(entry.fileName, bytes);
  });
  for (const file of extracted) {
    if (file) files.push(file);
  }
  return files;
}

export async function filesFromZipBytes(
  bytes: Uint8Array,
  zipName: string,
  progress: (update: ZipProgress) => void = () => undefined,
): Promise<InputFile[]> {
  const zip = await openZip(new BufferRangeReader(bytes), bytes.byteLength);
  try {
    const entries = await listEntries(zip);
    return extractEntries(
      entries,
      async (start, length) => bytes.subarray(start, start + length),
      progress,
      zipName,
    );
  } finally {
    zip.close();
  }
}

export async function filesFromDriveZip(
  file: DriveZipRef,
  token: string,
  progress: (update: ZipProgress) => void = () => undefined,
): Promise<InputFile[]> {
  const size = await driveFileSize(file.id, token);
  progress({
    phase: `Scanning ${file.name} (${formatBytes(size)})…`,
    completed: 0,
    total: 1,
  });
  const zip = await openZip(new DriveRangeReader(file.id, token), size);
  try {
    const entries = await listEntries(zip);
    const files = await extractEntries(
      entries,
      (start, length) => readRange(file.id, token, start, length),
      progress,
      file.name,
    );
    if (!files.length && size > 5 * 1024 * 1024) {
      throw new Error(
        `${file.name} is a large Takeout archive but no photos were found in it. Select the takeout-*.zip files from Drive and try again.`,
      );
    }
    return files;
  } finally {
    zip.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
