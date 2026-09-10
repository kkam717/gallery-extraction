import { createRequire } from 'node:module';
import { createDataset, type Mode, type Result } from '../src/lib/dataset';
import { filesFromTakeoutZipChunks, isZipFile } from '../src/lib/takeout';

const require = createRequire(import.meta.url);
const FILE_ID = /^[\w-]+$/;
const MAX_ZIPS = 100;

export type DriveZipRef = {
  id: string;
  name: string;
};

export type ExtractRequest = {
  files: DriveZipRef[];
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
    mode?: unknown;
    source?: unknown;
  };
  if (!Array.isArray(value.files) || !value.files.length) {
    throw new Error('Select at least one Takeout ZIP in Google Drive.');
  }
  if (value.files.length > MAX_ZIPS) {
    throw new Error(`Choose at most ${MAX_ZIPS} Takeout ZIP files at once.`);
  }
  const files = value.files.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Drive file ${index + 1} is not valid.`);
    }
    const file = item as { id?: unknown; name?: unknown };
    const id = typeof file.id === 'string' ? file.id.trim() : '';
    const name = typeof file.name === 'string' ? file.name.trim() : 'takeout.zip';
    if (!FILE_ID.test(id)) {
      throw new Error(`Drive file ${index + 1} is not valid.`);
    }
    return { id, name: asZipName(name) };
  });
  const mode = value.mode === 'limited' ? 'limited' : 'full';
  const source =
    value.source === 'google' || value.source === 'apple' || value.source === 'mixed'
      ? value.source
      : 'google';
  return { files, mode, source };
}

async function* driveFileChunks(
  file: DriveZipRef,
  token: string,
): AsyncIterable<Uint8Array> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`Could not read ${file.name} from Google Drive.`);
  }
  if (!response.body) {
    throw new Error(`Google Drive returned no data for ${file.name}.`);
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function extractDriveZips(
  token: string,
  request: ExtractRequest,
  progress: (update: ExtractProgress) => void,
): Promise<Result> {
  if (!token) {
    throw new Error('Google Drive access expired. Allow access and try again.');
  }
  const collected = [];
  const seen = new Set<string>();
  for (const [index, file] of request.files.entries()) {
    if (!isZipFile(new File([], file.name, { type: 'application/zip' }))) {
      throw new Error(`${file.name} is not a ZIP file.`);
    }
    progress({
      phase: `Reading ${file.name} from Drive…`,
      completed: index,
      total: request.files.length,
    });
    const unpacked = await filesFromTakeoutZipChunks(
      file.name,
      driveFileChunks(file, token),
      progress,
      index + 1,
      request.files.length,
    );
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
