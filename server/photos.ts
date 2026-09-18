import { createRequire } from 'node:module';
import {
  createDatasetFromParsed,
  parseMediaInput,
  type Mode,
  type ParsedMediaFile,
} from '../src/lib/dataset';
import { HEADER_BYTES } from '../src/lib/exif';
import type { ExtractProgress } from './extract';

const require = createRequire(import.meta.url);
const PHOTOS_API = 'https://photospicker.googleapis.com/v1';
const SESSION_ID = /^[\w.=/-]{6,512}$/;
const DOWNLOAD_CONCURRENCY = 4;

export type PhotosExtractRequest = {
  sessionIds: string[];
  mode: Mode;
  source: string;
};

export type PickedPhoto = {
  id?: string;
  createTime?: string;
  type?: string;
  mediaFile?: {
    baseUrl?: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: {
      width?: number;
      height?: number;
      cameraMake?: string;
      cameraModel?: string;
      photoMetadata?: {
        focalLength?: number;
        apertureFNumber?: number;
        isoEquivalent?: number;
        exposureTime?: string;
      };
      videoMetadata?: {
        fps?: number;
        processingStatus?: string;
      };
    };
  };
};

function sqliteFile(name: string): string {
  return require.resolve(`sql.js/dist/${name}`);
}

export function parsePhotosExtractRequest(body: unknown): PhotosExtractRequest {
  if (!body || typeof body !== 'object') {
    throw new Error('Send the Google Photos picker session as JSON.');
  }
  const value = body as {
    sessionIds?: unknown;
    sessionId?: unknown;
    mode?: unknown;
    source?: unknown;
  };
  const rawIds = Array.isArray(value.sessionIds)
    ? value.sessionIds
    : typeof value.sessionId === 'string'
      ? [value.sessionId]
      : [];
  const sessionIds = rawIds.map((id, index) => {
    if (typeof id !== 'string' || !SESSION_ID.test(id.trim()) || id.includes('..')) {
      throw new Error(`Google Photos session ${index + 1} is not valid.`);
    }
    return id.trim();
  });
  if (!sessionIds.length) {
    throw new Error('Select photos in Google Photos first.');
  }
  const mode = value.mode === 'limited' ? 'limited' : 'full';
  const source =
    value.source === 'google' || value.source === 'apple' || value.source === 'mixed'
      ? value.source
      : 'google';
  return { sessionIds, mode, source };
}

export function parseExposureSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([\d.]+)s$/.exec(value.trim());
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

export function tagsFromPickedPhoto(item: PickedPhoto): Record<string, unknown> {
  const file = item.mediaFile;
  const meta = file?.mediaFileMetadata;
  const photo = meta?.photoMetadata;
  const tags: Record<string, unknown> = {};
  if (item.createTime) {
    tags.CreateDate = item.createTime;
    tags.DateTimeOriginal = item.createTime.replace('T', ' ').replace(/\.\d+Z$/, '').replace(/Z$/, '');
  }
  if (meta?.cameraMake) tags.Make = meta.cameraMake;
  if (meta?.cameraModel) tags.Model = meta.cameraModel;
  if (meta?.width) tags.ExifImageWidth = meta.width;
  if (meta?.height) tags.ExifImageHeight = meta.height;
  if (photo?.isoEquivalent != null) tags.ISO = photo.isoEquivalent;
  if (photo?.apertureFNumber != null) tags.FNumber = photo.apertureFNumber;
  if (photo?.focalLength != null) tags.FocalLength = photo.focalLength;
  const exposure = parseExposureSeconds(photo?.exposureTime);
  if (exposure != null) tags.ExposureTime = exposure;
  if (file?.mimeType) tags.MIMEType = file.mimeType;
  return tags;
}

async function photosApi<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${PHOTOS_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'Google Photos access expired. Keep this tab open and try again.'
        : 'Google Photos could not be read. Open the picker again.',
    );
  }
  return (await response.json()) as T;
}

export async function listPickedPhotos(
  sessionId: string,
  getToken: () => string,
): Promise<PickedPhoto[]> {
  const items: PickedPhoto[] = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      sessionId,
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await photosApi<{ mediaItems?: PickedPhoto[]; nextPageToken?: string }>(
      `/mediaItems?${params}`,
      getToken(),
    );
    items.push(...(body.mediaItems ?? []));
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return items;
}

async function downloadPhotoHeader(baseUrl: string, token: string): Promise<Uint8Array> {
  const downloadUrl = baseUrl.includes('=d') ? baseUrl : `${baseUrl}=d`;
  const response = await fetch(downloadUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Range: `bytes=0-${HEADER_BYTES - 1}`,
    },
  });
  if (!response.ok) {
    throw new Error('A Google Photo could not be downloaded.');
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  return buffer.length > HEADER_BYTES ? buffer.subarray(0, HEADER_BYTES) : buffer;
}

async function parsePickedPhoto(
  item: PickedPhoto,
  getToken: () => string,
): Promise<ParsedMediaFile> {
  const filename = item.mediaFile?.filename || `${item.id || 'photo'}.jpg`;
  const path = `google-photos/${filename}`;
  const apiTags = tagsFromPickedPhoto(item);
  const isVideo = item.type === 'VIDEO' || (item.mediaFile?.mimeType || '').startsWith('video/');
  if (isVideo || !item.mediaFile?.baseUrl) {
    return { path, fileBytes: 0, raw: apiTags, failed: !item.createTime && !apiTags.Make };
  }
  try {
    const bytes = await downloadPhotoHeader(item.mediaFile.baseUrl, getToken());
    const parsed = await parseMediaInput(
      { file: new File([bytes], filename, { type: item.mediaFile.mimeType || 'image/jpeg' }), path },
      bytes.byteLength,
    );
    return {
      ...parsed,
      raw: { ...apiTags, ...parsed.raw },
    };
  } catch {
    return { path, fileBytes: 0, raw: apiTags, failed: !apiTags.DateTimeOriginal };
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function extractGooglePhotos(
  getToken: () => string,
  request: PhotosExtractRequest,
  progress: (update: ExtractProgress) => void,
): Promise<ReturnType<typeof createDatasetFromParsed>> {
  if (!getToken()) {
    throw new Error('Google Photos access expired. Keep this tab open and try again.');
  }
  const items: PickedPhoto[] = [];
  const seen = new Set<string>();
  for (const sessionId of request.sessionIds) {
    progress({
      phase: 'Listing photos you selected in Google Photos…',
      completed: items.length,
      total: Math.max(items.length, 1),
    });
    for (const item of await listPickedPhotos(sessionId, getToken)) {
      const key = item.id || `${item.mediaFile?.filename}:${item.createTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  if (!items.length) {
    throw new Error('Those Google Photos sessions did not contain any photos or videos.');
  }
  progress({
    phase: `Reading EXIF from ${items.length.toLocaleString()} Google Photos…`,
    completed: 0,
    total: items.length,
  });
  let completed = 0;
  const media = await mapPool(items, DOWNLOAD_CONCURRENCY, async (item) => {
    const parsed = await parsePickedPhoto(item, getToken);
    completed += 1;
    if (completed % 4 === 0 || completed === items.length) {
      progress({
        phase: `Reading EXIF from ${item.mediaFile?.filename || 'Google Photos'}…`,
        completed,
        total: items.length,
      });
    }
    return parsed;
  });
  return createDatasetFromParsed(
    media,
    [],
    request.mode,
    request.source,
    progress,
    sqliteFile,
    { maxAccountBytes: 2 * 1024 * 1024 * 1024 },
  );
}
