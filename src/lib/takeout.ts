import { Unzip, UnzipInflate } from 'fflate';
import { extension, MEDIA, type InputFile } from './dataset';
import { HEADER_BYTES } from './exif';

const SIDECAR_BYTES = 10 * 1024 * 1024;
const ZIP_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
]);

export type UnpackProgress = {
  phase: string;
  completed: number;
  total: number;
};

function yieldThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function normalizeZipPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isZipName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.zip') || lower.endsWith('.zip.001') || /\.zip\.\d{3}$/.test(lower);
}

export function isZipFile(file: File): boolean {
  return ZIP_TYPES.has(file.type) || isZipName(file.name);
}

export function isTakeoutEntry(path: string): boolean {
  const normalized = normalizeZipPath(path);
  if (!normalized || normalized.endsWith('/')) return false;
  if (normalized.split('/').some((part) => part === '__MACOSX' || part.startsWith('._'))) {
    return false;
  }
  const ext = extension(normalized);
  return MEDIA.has(ext) || ext === 'json' || ext === 'xmp';
}

function mimeFor(path: string): string {
  const ext = extension(path);
  if (ext === 'json') return 'application/json';
  if (ext === 'xmp') return 'application/rdf+xml';
  if (['jpg', 'jpeg', 'jpe'].includes(ext)) return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (['tif', 'tiff'].includes(ext)) return 'image/tiff';
  if (['heic', 'heif', 'hif'].includes(ext)) return 'image/heic';
  if (ext === 'webp') return 'image/webp';
  if (['mp4', 'm4v'].includes(ext)) return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  return '';
}

function fileName(path: string): string {
  return normalizeZipPath(path).split('/').pop() || path;
}

function keepLimit(path: string): number {
  const ext = extension(path);
  return ext === 'json' || ext === 'xmp' ? SIDECAR_BYTES : HEADER_BYTES;
}

async function* fileChunks(file: File): AsyncIterable<Uint8Array> {
  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  yield new Uint8Array(await file.arrayBuffer());
}

export async function filesFromTakeoutZipChunks(
  zipName: string,
  chunks: AsyncIterable<Uint8Array>,
  progress: (update: UnpackProgress) => void = () => undefined,
  zipIndex = 1,
  zipTotal = 1,
): Promise<InputFile[]> {
  const files: InputFile[] = [];
  await new Promise<void>((resolve, reject) => {
    let pending = 0;
    let finished = false;
    const unzipper = new Unzip((error) => {
      if (error) reject(error);
    });
    const finish = () => {
      if (finished || pending > 0) return;
      finished = true;
      resolve();
    };
    unzipper.register(UnzipInflate);
    unzipper.onfile = (entry) => {
      const path = normalizeZipPath(entry.name);
      if (!isTakeoutEntry(path)) return;
      pending += 1;
      const parts: Uint8Array[] = [];
      let received = 0;
      const limit = keepLimit(path);
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        files.push({
          file: new File([bytes], fileName(path), { type: mimeFor(path) }),
          path,
        });
        pending -= 1;
        progress({
          phase: `Unpacking ${zipName}…`,
          completed: zipIndex,
          total: zipTotal,
        });
        finish();
      };
      entry.ondata = (error, chunk, final) => {
        if (error) {
          reject(error);
          return;
        }
        if (received < limit) {
          const take =
            chunk.length > limit - received ? chunk.subarray(0, limit - received) : chunk;
          parts.push(take);
          received += take.length;
          if (received >= limit && entry.terminate) {
            entry.terminate();
            complete();
            return;
          }
        }
        if (final) complete();
      };
      entry.start();
    };
    const push = async () => {
      let seen = 0;
      for await (const chunk of chunks) {
        unzipper.push(chunk, false);
        seen += chunk.byteLength;
        if (seen > 0 && seen % (8 * 1024 * 1024) < chunk.byteLength) await yieldThread();
      }
      unzipper.push(new Uint8Array(0), true);
      finish();
    };
    void push().catch(reject);
  });
  return files;
}

async function unpackZip(
  zip: File,
  progress: (update: UnpackProgress) => void,
  zipIndex: number,
  zipTotal: number,
): Promise<InputFile[]> {
  return filesFromTakeoutZipChunks(zip.name, fileChunks(zip), progress, zipIndex, zipTotal);
}

export async function filesFromTakeoutZips(
  zips: File[],
  progress: (update: UnpackProgress) => void = () => undefined,
): Promise<InputFile[]> {
  if (!zips.length) return [];
  const collected: InputFile[] = [];
  const seen = new Set<string>();
  for (const [index, zip] of zips.entries()) {
    progress({
      phase: `Reading ${zip.name}…`,
      completed: index,
      total: zips.length,
    });
    const unpacked = await unpackZip(zip, progress, index + 1, zips.length);
    for (const file of unpacked) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      collected.push(file);
    }
    await yieldThread();
  }
  if (!collected.length) {
    throw new Error(
      'Those ZIP files did not contain supported photos, videos, or sidecar metadata.',
    );
  }
  progress({
    phase: `Unpacked ${collected.length.toLocaleString()} files`,
    completed: zips.length,
    total: zips.length,
  });
  return collected;
}
