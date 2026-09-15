import { isZipName } from './takeout';
import type { Mode, Row } from './dataset';

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const GAPI_SRC = 'https://apis.google.com/js/api.js';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
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
        callback: (response: { access_token?: string; error?: string; expires_in?: number }) => void;
      }) => TokenClient;
    };
  };
  picker: {
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string };
    ViewId: { DOCS: string };
    DocsViewMode?: { LIST: string };
    DocsView: new (viewId?: string) => {
      setMimeTypes: (types: string) => unknown;
      setIncludeFolders: (include: boolean) => unknown;
      setSelectFolderEnabled: (enabled: boolean) => unknown;
      setParent?: (id: string) => unknown;
      setMode?: (mode: unknown) => unknown;
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

function requestAccessToken(google: GoogleApis, prompt?: string, timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => reject(new Error('Google Drive access timed out.')), timeoutMs)
        : undefined;
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (timer) clearTimeout(timer);
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
    if (prompt === undefined) client.requestAccessToken();
    else client.requestAccessToken({ prompt });
  });
}

function isDriveFolder(doc: DriveDoc): boolean {
  return doc.mimeType === FOLDER_MIME || (!doc.mimeType && !isZipName(doc.name));
}

function configureDocsView(
  view: InstanceType<GoogleApis['picker']['DocsView']>,
  google: GoogleApis,
): void {
  if (view.setMode && google.picker.DocsViewMode?.LIST) {
    view.setMode(google.picker.DocsViewMode.LIST);
  }
}

function pickDocs(
  google: GoogleApis,
  token: string,
  options: { parentId?: string; title?: string; allowFolderSelect?: boolean } = {},
): Promise<DriveDoc[]> {
  return new Promise((resolve, reject) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS);
    view.setIncludeFolders(true);
    view.setSelectFolderEnabled(options.allowFolderSelect !== false);
    if (options.parentId && view.setParent) view.setParent(options.parentId);
    configureDocsView(view, google);

    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(apiKey())
      .setAppId(appId())
      .setTitle(options.title || 'Open Takeout and select every ZIP')
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

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function pickDriveTakeoutZips(
  progress: (update: DriveProgress) => void = () => undefined,
): Promise<{ token: string; files: DriveZipRef[]; folders: DriveZipRef[] }> {
  if (!isDriveConfigured()) {
    throw new Error('Google Drive is not configured for this site.');
  }
  progress({ phase: 'Opening Google Drive…', completed: 0, total: 1 });
  const google = await loadGoogleLibraries();
  const token = await requestAccessToken(google);
  const picked = await pickDocs(google, token, {
    title: 'Open Takeout and select every ZIP',
    allowFolderSelect: true,
  });
  if (!picked.length) return { token, files: [], folders: [] };

  const zips: DriveDoc[] = [];
  const seen = new Set<string>();
  const addZip = (doc: DriveDoc) => {
    if (seen.has(doc.id) || isDriveFolder(doc) || !isZipName(doc.name)) return;
    seen.add(doc.id);
    zips.push(doc);
  };

  for (const doc of picked) {
    if (!isDriveFolder(doc) && isZipName(doc.name)) {
      addZip(doc);
      continue;
    }
    progress({
      phase: `Select every ZIP in ${doc.name}…`,
      completed: 0,
      total: 1,
    });
    const found = await pickDocs(google, token, {
      parentId: doc.id,
      title: `Open ${doc.name} and select every takeout-*.zip`,
      allowFolderSelect: false,
    });
    for (const zip of found) addZip(zip);
  }

  if (!zips.length) {
    throw new Error(
      'No Takeout ZIP files were selected. Open the Takeout folder and select every takeout-*.zip part.',
    );
  }
  return {
    token,
    files: zips.map((zip) => ({ id: zip.id, name: zip.name })),
    folders: [],
  };
}

function driveConnectionError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The Drive extraction was cancelled.';
  }
  const message = error instanceof Error ? error.message : '';
  if (
    error instanceof TypeError ||
    /failed to fetch|network error|load failed|networkerror/i.test(message)
  ) {
    return 'The cloud extractor lost its connection. Keep this tab open and try again.';
  }
  return message || 'The Drive export could not be processed in the cloud.';
}

type SsePayload = {
  type?: string;
  jobId?: string;
  phase?: string;
  completed?: number;
  total?: number;
  message?: string;
  archive?: string;
  rows?: Row[];
  manifest?: Record<string, unknown>;
};

async function readExtractStream(
  response: Response,
  progress: (update: DriveProgress) => void,
  onJob: (jobId: string) => void,
): Promise<DriveExtractResult | null> {
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
      const line = message.split('\n').find((entry) => entry.startsWith('data: '));
      if (!line) continue;
      let payload: SsePayload;
      try {
        payload = JSON.parse(line.slice(6)) as SsePayload;
      } catch {
        continue;
      }
      if (payload.type === 'job' && payload.jobId) {
        onJob(payload.jobId);
        continue;
      }
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
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function extractDriveZipsRemote(
  token: string,
  selection: { files: DriveZipRef[]; folders?: DriveZipRef[] },
  mode: Mode,
  source: string,
  progress: (update: DriveProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<DriveExtractResult> {
  const api = extractApiUrl();
  if (!api) {
    throw new Error('Drive extraction is not configured for this site.');
  }
  const fileCount = selection.files.length;
  progress({
    phase: selection.folders?.length
      ? 'Reading the Takeout folder in Drive…'
      : 'Starting cloud extraction…',
    completed: 0,
    total: fileCount || 1,
  });
  let lastProgress: DriveProgress = {
    phase: 'Starting cloud extraction…',
    completed: 0,
    total: fileCount || 1,
  };
  const report = (update: DriveProgress) => {
    lastProgress = update;
    progress(update);
  };
  let jobId = '';
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const google = await loadGoogleLibraries();
  const pushToken = async () => {
    if (!jobId || signal?.aborted) return;
    try {
      const next = await requestAccessToken(google, '', 15_000);
      await fetch(`${api}/extract/${jobId}/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${next}` },
        signal,
      });
    } catch {
      // The current Drive token may still be valid until the next refresh.
    }
  };
  const rememberJob = (id: string) => {
    jobId = id;
    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        void pushToken();
      }, 35 * 60 * 1000);
    }
  };
  const openStream = async (url: string, init: RequestInit): Promise<DriveExtractResult | null> => {
    const response = await fetch(url, { ...init, signal });
    if (response.status === 404) {
      throw new Error('That extract job is no longer available. Start it again.');
    }
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
    return readExtractStream(response, report, rememberJob);
  };

  let result: DriveExtractResult | null = null;
  try {
    try {
      result = await openStream(`${api}/extract`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: selection.files,
          folders: selection.folders ?? [],
          mode,
          source,
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof Error && /no longer available|not granted|not configured|not allowed/i.test(error.message)) {
        throw error;
      }
      if (!jobId) throw new Error(driveConnectionError(error));
    }

    while (!result) {
      if (signal?.aborted) {
        throw new Error('The Drive extraction was cancelled.');
      }
      if (!jobId) {
        throw new Error('The cloud extractor lost its connection. Keep this tab open and try again.');
      }
      progress({
        phase: 'Reconnecting to the cloud extractor…',
        completed: lastProgress.completed,
        total: lastProgress.total,
      });
      try {
        await sleep(1000);
        result = await openStream(`${api}/extract/${jobId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof Error && /no longer available/i.test(error.message)) throw error;
        if (error instanceof Error && !(error instanceof TypeError) && !/failed to fetch|network error|load failed/i.test(error.message)) {
          throw error;
        }
      }
    }
    return result;
  } finally {
    if (refreshTimer) clearInterval(refreshTimer);
  }
}
