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

export function galleryItemKey(file: File, path: string): string {
  return `${path}|${file.size}|${file.lastModified}`;
}

export function emptyLibrary(): StagedLibrary {
  return { media: [], sidecars: [] };
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
  progress({ phase: 'Reading photos from your gallery…', completed: 0, total });
  for (const [index, item] of items.entries()) {
    const key = galleryItemKey(item.file, item.path);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    if (isSidecar(item) && item.file.size > SIDECAR_BYTES) {
      skipped += 1;
      continue;
    }
    if (isMedia(item)) {
      media.push(await parseMediaInput(item, item.file.size));
      seen.add(key);
      added += 1;
    } else if (isSidecar(item) || ['json', 'xmp'].includes(extension(item.path))) {
      sidecars.push(await parseSidecarInput(item));
      seen.add(key);
      added += 1;
    } else {
      skipped += 1;
    }
    if ((index + 1) % 4 === 0 || index + 1 === items.length) {
      progress({
        phase: `Reading EXIF in ${item.path.split('/').pop() || item.path}…`,
        completed: index + 1,
        total,
      });
      await yieldThread();
    }
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
