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

export function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    ZIP_TYPES.has(file.type) ||
    name.endsWith('.zip') ||
    name.endsWith('.zip.001')
  );
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

async function unpackZip(
  zip: File,
  progress: (update: UnpackProgress) => void,
  zipIndex: number,
  zipTotal: number,
): Promise<InputFile[]> {
  const buffer = new Uint8Array(await zip.arrayBuffer());
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
      const chunks: Uint8Array[] = [];
      let received = 0;
      const limit = keepLimit(path);
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        files.push({
          file: new File([bytes], fileName(path), { type: mimeFor(path) }),
          path,
        });
        pending -= 1;
        progress({
          phase: `Unpacking ${zip.name}…`,
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
          chunks.push(take);
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
    const chunkSize = 1024 * 1024;
    const push = async () => {
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        unzipper.push(
          buffer.subarray(offset, offset + chunkSize),
          offset + chunkSize >= buffer.length,
        );
        if (offset > 0 && offset % (8 * chunkSize) === 0) await yieldThread();
      }
      finish();
    };
    void push().catch(reject);
  });
  return files;
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
