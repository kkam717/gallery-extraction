import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';
import { createRequire } from 'node:module';
import type { InputFile } from '../src/lib/dataset';
import { isTakeoutEntry, takeoutInputFile, takeoutKeepLimit } from '../src/lib/takeout';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as typeof import('yauzl');

const STORE = 0;
const DEFLATE = 8;
const LOCAL_HEADER = 30;
const ENTRY_CONCURRENCY = 4;
const DEFLATE_PAD = 128 * 1024;
const TAIL_BYTES = 0xffff + 22 + 20 + 64;
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;
const RANGE_TIMEOUT_MS = 60_000;
const LARGE_RANGE_TIMEOUT_MS = 180_000;
const RANGE_RETRIES = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type DriveZipRef = {
  id: string;
  name: string;
};

export type ZipProgress = {
  phase: string;
  completed: number;
  total: number;
};

export type ZipDirectoryLocation = {
  cdOffset: number;
  cdSize: number;
  entryCount: number;
  zip64EocdOffset?: number;
};

type ZipEntry = import('yauzl').Entry;

class PrefetchReader extends yauzl.RandomAccessReader {
  constructor(
    private readonly chunks: Array<{ start: number; bytes: Uint8Array }>,
    private readonly fallback?: (start: number, endExclusive: number) => Promise<Uint8Array>,
  ) {
    super();
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (error: Error | null, bytesRead?: number) => void,
  ): void {
    void this.slice(position, position + length).then(
      (bytes) => {
        Buffer.from(bytes).copy(buffer, offset);
        callback(null, bytes.byteLength);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error('ZIP read failed.'));
      },
    );
  }

  _readStreamForRange(start: number, end: number): Readable {
    const stream = new Readable({ read() {} });
    void this.slice(start, end)
      .then((bytes) => {
        stream.push(bytes);
        stream.push(null);
      })
      .catch((error: unknown) => {
        stream.destroy(error instanceof Error ? error : new Error('ZIP read failed.'));
      });
    return stream;
  }

  private async slice(start: number, endExclusive: number): Promise<Uint8Array> {
    const length = endExclusive - start;
    if (length <= 0) return new Uint8Array();
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.start + chunk.bytes.byteLength;
      if (start >= chunk.start && endExclusive <= chunkEnd) {
        const from = start - chunk.start;
        return chunk.bytes.subarray(from, from + length);
      }
    }
    if (!this.fallback) {
      throw new Error(`ZIP index read missed the prefetched range at ${start}.`);
    }
    return this.fallback(start, endExclusive);
  }
}

function driveMediaUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

function driveMetaUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=size,name&supportsAllDrives=true`;
}

function shouldAuthorize(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'www.googleapis.com' || host.endsWith('.googleapis.com');
  } catch {
    return false;
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function readU64(bytes: Uint8Array, offset: number): number {
  const value = readU32(bytes, offset) + readU32(bytes, offset + 4) * 0x1_0000_0000;
  if (!Number.isSafeInteger(value)) {
    throw new Error('That Takeout ZIP offset is too large to read in the cloud.');
  }
  return value;
}

function parseZip64Eocd(bytes: Uint8Array): Pick<ZipDirectoryLocation, 'cdOffset' | 'cdSize' | 'entryCount'> {
  if (bytes.byteLength < 56 || readU32(bytes, 0) !== 0x06064b50) {
    throw new Error('That Takeout ZIP has an invalid ZIP64 index.');
  }
  if (readU32(bytes, 16) !== 0) {
    throw new Error('Split (multi-disk) ZIP files are not supported.');
  }
  return {
    entryCount: readU64(bytes, 32),
    cdSize: readU64(bytes, 40),
    cdOffset: readU64(bytes, 48),
  };
}

export function locateZipDirectory(tail: Uint8Array, fileSize: number): ZipDirectoryLocation {
  const tailStart = fileSize - tail.byteLength;
  const eocdSize = 22;
  const locatorSize = 20;
  for (let index = tail.byteLength - eocdSize; index >= 0; index -= 1) {
    if (readU32(tail, index) !== 0x06054b50) continue;
    const commentLength = readU16(tail, index + 20);
    if (tailStart + index + eocdSize + commentLength !== fileSize) continue;

    let entryCount = readU16(tail, index + 10);
    let cdSize = readU32(tail, index + 12);
    let cdOffset = readU32(tail, index + 16);
    const locatorAt = index - locatorSize;
    const hasLocator = locatorAt >= 0 && readU32(tail, locatorAt) === 0x07064b50;
    const needsZip64 =
      hasLocator || entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;

    if (needsZip64) {
      if (!hasLocator) {
        throw new Error('That Takeout ZIP is ZIP64 but the index locator is missing.');
      }
      const zip64EocdOffset = readU64(tail, locatorAt + 8);
      const local = zip64EocdOffset - tailStart;
      if (local < 0 || local + 56 > tail.byteLength) {
        return { cdOffset: -1, cdSize: -1, entryCount: -1, zip64EocdOffset };
      }
      ({ entryCount, cdSize, cdOffset } = parseZip64Eocd(tail.subarray(local, local + 56)));
    }

    if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > fileSize) {
      throw new Error('That Takeout ZIP index is truncated.');
    }
    if (cdSize > MAX_DIRECTORY_BYTES) {
      throw new Error('That Takeout ZIP index is too large to scan in the cloud.');
    }
    return { cdOffset, cdSize, entryCount };
  }
  throw new Error('That file is not a ZIP archive, or the ZIP index is missing.');
}

type TokenSource = () => string;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFreshToken(getToken: TokenSource, previous: string): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (getToken() && getToken() !== previous) return true;
    await sleep(2_000);
  }
  return getToken() !== previous;
}

async function fetchByteRange(
  url: string,
  getToken: TokenSource,
  start: number,
  last: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  let currentUrl = url;
  let redirects = 0;
  for (let attempt = 0; attempt < RANGE_RETRIES; attempt += 1) {
    if (redirects > 5) {
      throw new Error('Google Drive redirected the ZIP read too many times.');
    }
    const token = getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        Range: `bytes=${start}-${last}`,
      };
      if (shouldAuthorize(currentUrl)) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(currentUrl, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Google Drive redirected the ZIP read without a location.');
        }
        currentUrl = new URL(location, currentUrl).href;
        redirects += 1;
        attempt -= 1;
        continue;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        if (await waitForFreshToken(getToken, token)) {
          currentUrl = url;
          redirects = 0;
          attempt -= 1;
          continue;
        }
        throw new Error('Google Drive access expired. Keep this tab open so access can refresh, then try again.');
      }
      if (response.status === 403) {
        throw new Error('Google Drive denied reading that ZIP. Select the takeout-*.zip files again.');
      }
      if (response.status === 429 || response.status === 500 || response.status === 503) {
        await response.body?.cancel();
        await sleep(Math.min(8_000, 400 * 2 ** attempt) + Math.random() * 250);
        currentUrl = url;
        redirects = 0;
        continue;
      }
      if (response.status === 200) {
        await response.body?.cancel();
        throw new Error(
          'Google Drive ignored the ZIP range request. Select the takeout-*.zip files and try again.',
        );
      }
      if (response.status !== 206) {
        throw new Error(`Google Drive ZIP read failed (${response.status}).`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      const retryable =
        timedOut ||
        (error instanceof Error && /network|fetch|ECONNRESET|503|429/i.test(error.message));
      if (retryable && attempt < RANGE_RETRIES - 1) {
        await sleep(Math.min(8_000, 400 * 2 ** attempt));
        currentUrl = url;
        redirects = 0;
        continue;
      }
      if (timedOut) {
        throw new Error('Google Drive timed out while reading the Takeout ZIP.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Google Drive is busy. Wait a moment and try again.');
}

async function driveRange(
  fileId: string,
  getToken: TokenSource,
  start: number,
  endExclusive: number,
  timeoutMs = RANGE_TIMEOUT_MS,
  allowShort = false,
): Promise<Uint8Array> {
  const length = endExclusive - start;
  if (length <= 0) return new Uint8Array();
  const bytes = await fetchByteRange(
    driveMediaUrl(fileId),
    getToken,
    start,
    endExclusive - 1,
    timeoutMs,
  );
  if (bytes.byteLength > length) return bytes.subarray(0, length);
  if (bytes.byteLength < length && !allowShort) {
    throw new Error('Google Drive returned a short ZIP range.');
  }
  return bytes;
}

async function driveFileSize(fileId: string, getToken: TokenSource): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(driveMetaUrl(fileId), {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (response.status === 401) {
        if (attempt < 2 && (await waitForFreshToken(getToken, token))) continue;
        throw new Error('Google Drive access expired. Keep this tab open so access can refresh, then try again.');
      }
      if (!response.ok) {
        throw new Error('Could not read the Takeout ZIP size from Google Drive.');
      }
      const body = (await response.json()) as { size?: string };
      const size = Number(body.size || 0);
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error('That Drive file has no size. Select the takeout-*.zip files themselves.');
      }
      return size;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Google Drive timed out while reading the ZIP size.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Could not read the Takeout ZIP size from Google Drive.');
}

async function loadZipDirectory(
  fileId: string,
  getToken: TokenSource,
  size: number,
  progress: (update: ZipProgress) => void,
  zipName: string,
): Promise<{ location: ZipDirectoryLocation; bytes: Uint8Array }> {
  const tailLength = Math.min(TAIL_BYTES, size);
  progress({
    phase: `Reading ZIP index for ${zipName} (${formatBytes(size)})…`,
    completed: 0,
    total: 1,
  });
  const tail = await driveRange(fileId, getToken, size - tailLength, size);
  let location = locateZipDirectory(tail, size);
  if (location.zip64EocdOffset != null && location.cdOffset < 0) {
    const record = await driveRange(fileId, getToken, location.zip64EocdOffset, location.zip64EocdOffset + 4096);
    location = { ...location, ...parseZip64Eocd(record), zip64EocdOffset: undefined };
    if (location.cdSize > MAX_DIRECTORY_BYTES) {
      throw new Error('That Takeout ZIP index is too large to scan in the cloud.');
    }
  }
  const prefetchStart = Math.min(location.cdOffset, Math.max(0, size - TAIL_BYTES));
  const cachedFromTail = prefetchStart >= size - tail.byteLength;
  console.log(
    `[extract] ${zipName} size=${size} cdOffset=${location.cdOffset} cdSize=${location.cdSize} entries=${location.entryCount}`,
  );
  if (cachedFromTail) {
    return {
      location: { ...location, cdOffset: prefetchStart },
      bytes: tail.subarray(prefetchStart - (size - tail.byteLength)),
    };
  }
  progress({
    phase: `Downloading ZIP index (${formatBytes(size - prefetchStart)}) from ${zipName}…`,
    completed: 0,
    total: 1,
  });
  return {
    location: { ...location, cdOffset: prefetchStart },
    bytes: await driveRange(fileId, getToken, prefetchStart, size, LARGE_RANGE_TIMEOUT_MS),
  };
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

function inflateLimited(compressed: Uint8Array, limit: number): Promise<Uint8Array> {
  if (!compressed.byteLength || limit <= 0) return Promise.resolve(new Uint8Array());
  return new Promise((resolve, reject) => {
    const inflater = createInflateRaw();
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      if (received > 0) {
        resolve(Uint8Array.from(Buffer.concat(chunks, received)));
        return;
      }
      if (!error || /unexpected end of file/i.test(error.message)) {
        resolve(new Uint8Array());
        return;
      }
      reject(error);
    };
    inflater.on('data', (chunk: Buffer) => {
      if (received >= limit) {
        finish();
        return;
      }
      const take = chunk.length > limit - received ? chunk.subarray(0, limit - received) : chunk;
      chunks.push(take);
      received += take.length;
      if (received >= limit) finish();
    });
    inflater.on('error', (error: Error) => finish(error));
    inflater.on('end', () => finish());
    inflater.end(Buffer.from(compressed));
  });
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

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function extractOne(
  entry: ZipEntry,
  read: (start: number, length: number) => Promise<Uint8Array>,
): Promise<InputFile | null> {
  if (entry.compressionMethod !== STORE && entry.compressionMethod !== DEFLATE) return null;
  const uncompressed = Number(entry.uncompressedSize) || 0;
  const compressed = Number(entry.compressedSize) || 0;
  const limit = Math.min(takeoutKeepLimit(entry.fileName), uncompressed || takeoutKeepLimit(entry.fileName));
  const fullDeflate = entry.compressionMethod === DEFLATE && compressed > 0 && uncompressed > 0 && uncompressed <= limit;
  const dataNeed =
    entry.compressionMethod === STORE
      ? limit
      : fullDeflate
        ? compressed
        : Math.min(compressed || limit + DEFLATE_PAD, limit + DEFLATE_PAD);
  const window = await read(entry.relativeOffsetOfLocalHeader, 4096 + dataNeed);
  const localStart = dataOffset(window);
  let payload = window.byteLength > localStart ? window.subarray(localStart, localStart + dataNeed) : new Uint8Array();
  if (payload.byteLength < dataNeed) {
    payload = concatBytes([
      payload,
      await read(entry.relativeOffsetOfLocalHeader + localStart + payload.byteLength, dataNeed - payload.byteLength),
    ]);
  }
  let bytes: Uint8Array;
  if (entry.compressionMethod === STORE) {
    bytes = payload.byteLength > limit ? payload.subarray(0, limit) : payload;
  } else {
    bytes = await inflateLimited(payload, limit);
  }
  if (!bytes.byteLength) return null;
  return takeoutInputFile(entry.fileName, bytes);
}

async function extractEntries(
  entries: ZipEntry[],
  read: (start: number, length: number) => Promise<Uint8Array>,
  progress: (update: ZipProgress) => void,
  zipName: string,
  onFile?: (file: InputFile, uncompressedSize: number) => Promise<void>,
  onListed?: (wanted: number) => void,
): Promise<InputFile[]> {
  const wanted = entries.filter((entry) => isTakeoutEntry(entry.fileName));
  const files: InputFile[] = [];
  let completed = 0;
  onListed?.(wanted.length);
  if (!onFile) {
    progress({
      phase: `Found ${wanted.length.toLocaleString()} files in ${zipName}…`,
      completed: 0,
      total: wanted.length || 1,
    });
  }
  const extracted = await mapPool(wanted, ENTRY_CONCURRENCY, async (entry) => {
    try {
      const file = await extractOne(entry, read);
      if (!file) return null;
      completed += 1;
      if (!onFile && (completed % 8 === 0 || completed === wanted.length)) {
        progress({
          phase: `Reading photos in ${zipName}…`,
          completed,
          total: wanted.length,
        });
      }
      if (onFile) {
        await onFile(file, Number(entry.uncompressedSize) || file.file.size);
        return null;
      }
      return file;
    } catch (error) {
      if (error instanceof Error && /access expired/i.test(error.message)) throw error;
      console.warn(
        `[extract] skip ${entry.fileName}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
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
  const zip = await openZip(new PrefetchReader([{ start: 0, bytes }]), bytes.byteLength);
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
  getToken: TokenSource,
  progress: (update: ZipProgress) => void = () => undefined,
  onFile?: (input: InputFile, uncompressedSize: number) => Promise<void>,
  onListed?: (wanted: number) => void,
): Promise<InputFile[]> {
  const size = await driveFileSize(file.id, getToken);
  const directory = await loadZipDirectory(file.id, getToken, size, progress, file.name);
  const zip = await openZip(
    new PrefetchReader(
      [{ start: directory.location.cdOffset, bytes: directory.bytes }],
      (start, endExclusive) => driveRange(file.id, getToken, start, endExclusive),
    ),
    size,
  );
  try {
    const entries = await listEntries(zip);
    console.log(`[extract] ${file.name} listed ${entries.length} zip entries`);
    const files = await extractEntries(
      entries,
      (start, length) => driveRange(file.id, getToken, start, start + length, RANGE_TIMEOUT_MS, true),
      progress,
      file.name,
      onFile,
      onListed,
    );
    if (!files.length && !onFile && size > 5 * 1024 * 1024) {
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
