import {
  extension,
  isMedia,
  isSidecar,
  parseMediaInput,
  parseSidecarInput,
  type InputFile,
  type ParsedMediaFile,
  type ParsedSidecarFile,
} from './dataset';

export type StagedLibrary = {
  media: ParsedMediaFile[];
  sidecars: ParsedSidecarFile[];
};

export type GalleryProgress = {
  phase: string;
  completed: number;
  total: number;
};

const SIDECAR_BYTES = 10 * 1024 * 1024;

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/heic-sequence': 'heic',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
  'image/dng': 'dng',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
};

export function galleryItemKey(file: File, path: string): string {
  return `${path}|${file.size}|${file.lastModified}`;
}

export function emptyLibrary(): StagedLibrary {
  return { media: [], sidecars: [] };
}

/** Android Photo Picker / Google Photos in Chrome will not return more than this. */
export const ANDROID_PHOTO_PICKER_MAX = 100;

export type PhonePlatform = 'ios' | 'android' | 'other';

export function phonePlatform(
  ua = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchMac = typeof document !== 'undefined' && 'ontouchend' in document,
): PhonePlatform {
  if (/Android/i.test(ua)) return 'android';
  if (/iP(hone|ad|od)/i.test(ua)) return 'ios';
  if (/Macintosh/i.test(ua) && touchMac) return 'ios';
  return 'other';
}

export function isPhotoPickerCap(batchSize: number): boolean {
  return batchSize >= ANDROID_PHOTO_PICKER_MAX;
}

export function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner)),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function mediaMime(file: File): string {
  return file.type.toLowerCase().split(';')[0]?.trim() || '';
}

export function isGalleryMedia(item: InputFile): boolean {
  if (isMedia(item)) return true;
  const type = mediaMime(item.file);
  return type.startsWith('image/') || type.startsWith('video/');
}

export function sniffMediaExtension(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 12) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (['heic', 'heix', 'heif', 'mif1', 'msf1'].includes(brand)) return 'heic';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'dash'].includes(brand)) return 'mp4';
    if (brand === 'qt  ') return 'mov';
  }
  return null;
}

export function withMediaExtension(path: string, ext: string): string {
  if (path.toLowerCase().endsWith(`.${ext}`)) return path;
  return path ? `${path}.${ext}` : `photo.${ext}`;
}

export function galleryMediaPath(item: InputFile): string {
  if (extension(item.path) && isMedia(item)) return item.path;
  const fromMime = MIME_EXTENSION[mediaMime(item.file)];
  if (!fromMime) return item.path;
  return withMediaExtension(item.path, fromMime);
}

async function resolvedGalleryMediaPath(item: InputFile): Promise<string | null> {
  if (isGalleryMedia(item)) return galleryMediaPath(item);
  if (isSidecar(item)) return null;
  try {
    const bytes = new Uint8Array(await item.file.slice(0, 16).arrayBuffer());
    const sniffed = sniffMediaExtension(bytes);
    return sniffed ? withMediaExtension(item.path, sniffed) : null;
  } catch {
    return null;
  }
}

function yieldThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function parseGalleryItems(
  items: InputFile[],
  progress: (update: GalleryProgress) => void = () => undefined,
  seen = new Set<string>(),
): Promise<{ library: StagedLibrary; added: number; skipped: number }> {
  const media: ParsedMediaFile[] = [];
  const sidecars: ParsedSidecarFile[] = [];
  let added = 0;
  let skipped = 0;
  const total = items.length || 1;
  progress({ phase: `Reading ${items.length.toLocaleString()} items…`, completed: 0, total });
  for (const [index, item] of items.entries()) {
    const key = galleryItemKey(item.file, item.path);
    try {
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      if (isSidecar(item) && item.file.size > SIDECAR_BYTES) {
        skipped += 1;
        continue;
      }
      const mediaPath = await resolvedGalleryMediaPath(item);
      if (mediaPath) {
        const parsed = await parseMediaInput({ ...item, path: mediaPath }, item.file.size);
        parsed.raw = jsonSafeRecord(parsed.raw);
        media.push(parsed);
        seen.add(key);
        added += 1;
      } else if (isSidecar(item) || ['json', 'xmp'].includes(extension(item.path))) {
        const parsed = await parseSidecarInput(item);
        parsed.metadata = jsonSafeRecord(parsed.metadata);
        sidecars.push(parsed);
        seen.add(key);
        added += 1;
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
    progress({
      phase: `Reading EXIF in ${item.path.split('/').pop() || item.path}…`,
      completed: index + 1,
      total,
    });
    await yieldThread();
  }
  return { library: { media, sidecars }, added, skipped };
}

export function mergeLibraries(base: StagedLibrary, extra: StagedLibrary): StagedLibrary {
  const paths = new Set(base.media.map((file) => file.path));
  const sidecarPaths = new Set(base.sidecars.map((file) => file.path));
  return {
    media: [
      ...base.media,
      ...extra.media.filter((file) => {
        if (paths.has(file.path)) return false;
        paths.add(file.path);
        return true;
      }),
    ],
    sidecars: [
      ...base.sidecars,
      ...extra.sidecars.filter((file) => {
        if (sidecarPaths.has(file.path)) return false;
        sidecarPaths.add(file.path);
        return true;
      }),
    ],
  };
}
