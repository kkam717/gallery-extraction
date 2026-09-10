import { isZipFile } from './takeout';
import type { Mode, Row } from './dataset';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ZIP_MIME =
  'application/zip,application/x-zip-compressed,application/x-zip,application/octet-stream';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

type DriveDoc = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: string | number;
};

type TokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

type PickerBuilder = {
  addView: (view: unknown) => PickerBuilder;
  enableFeature: (feature: unknown) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  setCallback: (callback: (data: { action: string; docs?: DriveDoc[] }) => void) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  build: () => { setVisible: (visible: boolean) => void };
};

type GoogleApis = {
  accounts: {
    oauth2: {
      initTokenClient: (config: {
        client_id: string;
        scope: string;
        callback: (response: { access_token?: string; error?: string }) => void;
      }) => TokenClient;
    };
  };
  picker: {
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string };
    ViewId: { DOCS: string };
    DocsView: new (viewId?: string) => {
      setMimeTypes: (types: string) => unknown;
      setIncludeFolders: (include: boolean) => unknown;
      setSelectFolderEnabled: (enabled: boolean) => unknown;
    };
    PickerBuilder: new () => PickerBuilder;
  };
};

type GapiLoader = {
  load: (api: string, callback: () => void) => void;
};

declare global {
  interface Window {
    google?: GoogleApis;
    gapi?: GapiLoader;
  }
}

export type DriveProgress = {
  phase: string;
  completed: number;
  total: number;
};

export type DriveZipRef = {
  id: string;
  name: string;
};

export type DriveExtractResult = {
  archive: Uint8Array;
  rows: Row[];
  manifest: Record<string, unknown>;
};

function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
}

function apiKey(): string {
  return import.meta.env.VITE_GOOGLE_API_KEY?.trim() || '';
}

function appId(): string {
  const configured = import.meta.env.VITE_GOOGLE_APP_ID?.trim();
  if (configured) return configured;
  return clientId().split('-')[0] || '';
}

export function extractApiUrl(): string {
  return import.meta.env.VITE_EXTRACT_API_URL?.trim().replace(/\/$/, '') || '';
}

export function isDriveConfigured(): boolean {
  return Boolean(clientId() && apiKey() && extractApiUrl());
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') resolve();
      else existing.addEventListener('load', () => resolve(), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error('Google Drive could not be loaded. Check your connection and try again.'));
    document.head.appendChild(script);
  });
}

async function loadGoogleLibraries(): Promise<GoogleApis> {
  await Promise.all([loadScript(GIS_SRC), loadScript(GAPI_SRC)]);
  await new Promise<void>((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error('Google Drive could not be loaded. Reload the page and try again.'));
      return;
    }
    window.gapi.load('picker', () => resolve());
  });
  if (!window.google?.accounts || !window.google.picker) {
    throw new Error('Google Drive could not be loaded. Reload the page and try again.');
  }
  return window.google;
}

function requestAccessToken(google: GoogleApis): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              'Google Drive access was not granted. Allow Drive file access to select Takeout ZIPs.',
            ),
          );
          return;
        }
        resolve(response.access_token);
      },
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
}

function pickDocs(google: GoogleApis, token: string): Promise<DriveDoc[]> {
  return new Promise((resolve, reject) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    view.setMimeTypes(`${ZIP_MIME},${FOLDER_MIME}`);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(true);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(apiKey())
      .setAppId(appId())
      .setTitle('Select Google Takeout ZIP files')
      .setCallback((data) => {
        if (data.action === google.picker.Action.CANCEL) {
          resolve([]);
          return;
        }
        if (data.action === google.picker.Action.PICKED) {
          resolve(data.docs ?? []);
        }
      })
      .build();
    try {
      picker.setVisible(true);
    } catch {
      reject(new Error('The Google Drive picker could not be opened. Disable popup blockers and try again.'));
    }
  });
}

async function listFolderZips(folderId: string, token: string): Promise<DriveDoc[]> {
  const zips: DriveDoc[] = [];
  let pageToken = '';
  do {
    const query = `'${folderId}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Could not list ZIP files in that Drive folder.');
    }
    const body = (await response.json()) as {
      nextPageToken?: string;
      files?: DriveDoc[];
    };
    for (const file of body.files ?? []) {
      if (file.mimeType === FOLDER_MIME) {
        zips.push(...(await listFolderZips(file.id, token)));
        continue;
      }
      const fake = new File([], file.name, { type: file.mimeType });
      if (isZipFile(fake)) zips.push(file);
    }
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return zips;
}

async function resolveZipDocs(docs: DriveDoc[], token: string): Promise<DriveDoc[]> {
  const zips: DriveDoc[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const found =
      doc.mimeType === FOLDER_MIME
        ? await listFolderZips(doc.id, token)
        : isZipFile(new File([], doc.name, { type: doc.mimeType }))
          ? [doc]
          : [];
    for (const zip of found) {
      if (seen.has(zip.id)) continue;
      seen.add(zip.id);
      zips.push(zip);
    }
  }
  return zips;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function pickDriveTakeoutZips(
  progress: (update: DriveProgress) => void = () => undefined,
): Promise<{ token: string; files: DriveZipRef[] }> {
  if (!isDriveConfigured()) {
    throw new Error('Google Drive is not configured for this site.');
  }
  progress({ phase: 'Opening Google Drive…', completed: 0, total: 1 });
  const google = await loadGoogleLibraries();
  const token = await requestAccessToken(google);
  const picked = await pickDocs(google, token);
  if (!picked.length) return { token, files: [] };
  progress({ phase: 'Finding Takeout ZIP files…', completed: 0, total: 1 });
  const zips = await resolveZipDocs(picked, token);
  if (!zips.length) {
    throw new Error('No Takeout ZIP files were selected. Choose takeout-*.zip, or a folder that contains them.');
  }
  return {
    token,
    files: zips.map((zip) => ({ id: zip.id, name: zip.name })),
  };
}

export async function extractDriveZipsRemote(
  token: string,
  files: DriveZipRef[],
  mode: Mode,
  source: string,
  progress: (update: DriveProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<DriveExtractResult> {
  const api = extractApiUrl();
  if (!api) {
    throw new Error('Drive extraction is not configured for this site.');
  }
  progress({ phase: 'Starting cloud extraction…', completed: 0, total: files.length || 1 });
  const response = await fetch(`${api}/extract`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files, mode, source }),
    signal,
  });
  if (!response.ok) {
    let message = 'The Drive export could not be processed in the cloud.';
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Keep the generic error when the extractor does not return JSON.
    }
    throw new Error(message);
  }
  if (!response.body) {
    throw new Error('The Drive extractor returned no data.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: DriveExtractResult | null = null;
  while (!result) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const messages = buffer.split('\n\n');
    buffer = done ? '' : (messages.pop() ?? '');
    for (const message of messages) {
      const line = message
        .split('\n')
        .find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      const payload = JSON.parse(line.slice(6)) as {
        type?: string;
        phase?: string;
        completed?: number;
        total?: number;
        message?: string;
        archive?: string;
        rows?: Row[];
        manifest?: Record<string, unknown>;
      };
      if (payload.type === 'progress') {
        progress({
          phase: payload.phase || 'Extracting…',
          completed: payload.completed ?? 0,
          total: payload.total || 1,
        });
        continue;
      }
      if (payload.type === 'error') {
        throw new Error(payload.message || 'The Drive export could not be processed.');
      }
      if (payload.type === 'done' && payload.archive && payload.manifest && payload.rows) {
        result = {
          archive: decodeBase64(payload.archive),
          rows: payload.rows,
          manifest: payload.manifest,
        };
        break;
      }
    }
    if (done) break;
  }
  if (!result) {
    throw new Error('The Drive extractor closed before finishing.');
  }
  return result;
}
