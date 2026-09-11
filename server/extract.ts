import { createRequire } from 'node:module';
import { createDataset, type Mode, type Result } from '../src/lib/dataset';
import { isZipFile, isZipName } from '../src/lib/takeout';
import { filesFromDriveZip } from './drive-zip';

const require = createRequire(import.meta.url);
const FILE_ID = /^[\w.-]+$/;
const MAX_ZIPS = 250;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ZIP_MIME = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'application/octet-stream',
]);

export type DriveZipRef = {
  id: string;
  name: string;
};

export type ExtractRequest = {
  files: DriveZipRef[];
  folders: DriveZipRef[];
  mode: Mode;
  source: string;
};

export type ExtractProgress = {
  phase: string;
  completed: number;
  total: number;
};

function sqliteFile(name: string): string {
  return require.resolve(`sql.js/dist/${name}`);
}

function asZipName(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim() || 'takeout.zip';
  return base.toLowerCase().endsWith('.zip') || base.toLowerCase().endsWith('.zip.001')
    ? base
    : `${base}.zip`;
}

export function parseExtractRequest(body: unknown): ExtractRequest {
  if (!body || typeof body !== 'object') {
    throw new Error('Send the selected Drive ZIP files as JSON.');
  }
  const value = body as {
    files?: unknown;
    folders?: unknown;
    mode?: unknown;
    source?: unknown;
  };
  const files = parseDriveRefs(value.files, 'file').map((file) => ({
    ...file,
    name: asZipName(file.name),
  }));
  const folders = parseDriveRefs(value.folders, 'folder');
  if (!files.length && !folders.length) {
    throw new Error('Select the Takeout folder in Google Drive, or at least one Takeout ZIP.');
  }
  if (files.length > MAX_ZIPS) {
    throw new Error(`Choose at most ${MAX_ZIPS} Takeout ZIP files at once.`);
  }
  const mode = value.mode === 'limited' ? 'limited' : 'full';
  const source =
    value.source === 'google' || value.source === 'apple' || value.source === 'mixed'
      ? value.source
      : 'google';
  return { files, folders, mode, source };
}

function parseDriveRefs(value: unknown, kind: 'file' | 'folder'): DriveZipRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`The selected Drive ${kind}s are not valid.`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Drive ${kind} ${index + 1} is not valid.`);
    }
    const ref = item as { id?: unknown; name?: unknown };
    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    const name =
      typeof ref.name === 'string' && ref.name.trim()
        ? ref.name.trim()
        : kind === 'folder'
          ? 'Takeout'
          : 'takeout.zip';
    if (!FILE_ID.test(id)) {
      throw new Error(`Drive ${kind} ${index + 1} is not valid.`);
    }
    return { id, name };
  });
}

async function listFolderZips(folder: DriveZipRef, token: string): Promise<DriveZipRef[]> {
  const zips: DriveZipRef[] = [];
  let pageToken = '';
  do {
    const query = `'${folder.id}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Could not list ZIP files in ${folder.name}.`);
    }
    const body = (await response.json()) as {
      nextPageToken?: string;
      files?: Array<{ id?: string; name?: string; mimeType?: string }>;
    };
    for (const file of body.files ?? []) {
      if (!file.id || !file.name) continue;
      if (file.mimeType === FOLDER_MIME) {
        zips.push(...(await listFolderZips({ id: file.id, name: file.name }, token)));
        continue;
      }
      if (isZipName(file.name) || (file.mimeType && ZIP_MIME.has(file.mimeType))) {
        zips.push({ id: file.id, name: file.name });
      }
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return zips;
}

async function resolveZipFiles(request: ExtractRequest, token: string): Promise<DriveZipRef[]> {
  const seen = new Set<string>();
  const files: DriveZipRef[] = [];
  const add = (file: DriveZipRef) => {
    if (seen.has(file.id)) return;
    seen.add(file.id);
    files.push({ id: file.id, name: asZipName(file.name) });
  };
  for (const file of request.files) add(file);
  for (const folder of request.folders) {
    const found = await listFolderZips(folder, token);
    for (const file of found) add(file);
  }
  if (!files.length) {
    throw new Error(
      'That Drive folder did not contain Takeout ZIP files. Select the Takeout folder that holds takeout-*.zip.',
    );
  }
  if (files.length > MAX_ZIPS) {
    throw new Error(`Choose at most ${MAX_ZIPS} Takeout ZIP files at once.`);
  }
  return files;
}

export async function extractDriveZips(
  token: string,
  request: ExtractRequest,
  progress: (update: ExtractProgress) => void,
): Promise<Result> {
  if (!token) {
    throw new Error('Google Drive access expired. Allow access and try again.');
  }
  const zips = await resolveZipFiles(request, token);
  progress({
    phase: `Found ${zips.length.toLocaleString()} Takeout ZIP file${zips.length === 1 ? '' : 's'}`,
    completed: 0,
    total: zips.length,
  });
  const collected = [];
  const seen = new Set<string>();
  for (const [index, file] of zips.entries()) {
    if (!isZipFile(new File([], file.name, { type: 'application/zip' }))) {
      throw new Error(`${file.name} is not a ZIP file.`);
    }
    progress({
      phase: `Reading ${file.name} from Drive…`,
      completed: index,
      total: zips.length,
    });
    const unpacked = await filesFromDriveZip(file, token, progress);
    for (const item of unpacked) {
      if (seen.has(item.path)) continue;
      seen.add(item.path);
      collected.push(item);
    }
  }
  if (!collected.length) {
    throw new Error(
      'Those ZIP files did not contain supported photos, videos, or sidecar metadata.',
    );
  }
  return createDataset(
    collected,
    request.mode,
    request.source,
    progress,
    sqliteFile,
  );
}
