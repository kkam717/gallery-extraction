import type { Mode } from './dataset';
import {
  extractApiUrl,
  extractCloudJob,
  loadGoogleLibraries,
  requestAccessToken,
  type DriveExtractResult,
  type DriveProgress,
} from './drive';

export const PHOTOS_PICKER_SCOPE =
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const PHOTOS_API = 'https://photospicker.googleapis.com/v1';

export type PhotosProgress = DriveProgress;
export type PhotosExtractResult = DriveExtractResult;

export type PickedPhotosSession = {
  token: string;
  sessionId: string;
  count: number;
};

type PickingSession = {
  id?: string;
  pickerUri?: string;
  mediaItemsSet?: boolean;
  pollingConfig?: {
    pollInterval?: string;
    timeoutIn?: string;
  };
};

function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || '';
}

export function isPhotosConfigured(): boolean {
  return Boolean(clientId() && extractApiUrl());
}

export function parseGoogleDuration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^([\d.]+)s$/.exec(value.trim());
  if (!match) return fallbackMs;
  const ms = Number(match[1]) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : fallbackMs;
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
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message || '';
    } catch {
      detail = '';
    }
    if (response.status === 403 || response.status === 401) {
      throw new Error(
        detail ||
          'Google Photos access was not granted. Allow Photos picking and try again.',
      );
    }
    throw new Error(detail || 'Google Photos could not be opened. Try again.');
  }
  return (await response.json()) as T;
}

export async function countSessionMediaItems(sessionId: string, token: string): Promise<number> {
  let count = 0;
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      sessionId,
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await photosApi<{ mediaItems?: unknown[]; nextPageToken?: string }>(
      `/mediaItems?${params}`,
      token,
    );
    count += body.mediaItems?.length ?? 0;
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return count;
}

async function waitForPickedSession(
  session: PickingSession,
  token: string,
  progress: (update: PhotosProgress) => void,
): Promise<PickingSession> {
  const sessionId = session.id || '';
  const deadline = Date.now() + parseGoogleDuration(session.pollingConfig?.timeoutIn, 15 * 60 * 1000);
  let pollMs = parseGoogleDuration(session.pollingConfig?.pollInterval, 4000);
  while (Date.now() < deadline) {
    progress({
      phase: 'Waiting for you to finish in Google Photos…',
      completed: 0,
      total: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const latest = await photosApi<PickingSession>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      token,
    );
    if (latest.mediaItemsSet) return latest;
    pollMs = parseGoogleDuration(latest.pollingConfig?.pollInterval, pollMs);
  }
  throw new Error('The Google Photos picker timed out. Open it again and tap Done when you are finished.');
}

export async function pickGooglePhotosLibrary(
  progress: (update: PhotosProgress) => void = () => undefined,
): Promise<PickedPhotosSession | null> {
  if (!isPhotosConfigured()) {
    throw new Error('Google Photos is not configured for this site.');
  }
  progress({ phase: 'Opening Google Photos…', completed: 0, total: 1 });
  const google = await loadGoogleLibraries();
  const token = await requestAccessToken(google, undefined, 0, PHOTOS_PICKER_SCOPE);
  const session = await photosApi<PickingSession>('/sessions', token, {
    method: 'POST',
    body: '{}',
  });
  if (!session.id || !session.pickerUri) {
    throw new Error('Google Photos did not return a picker. Try again.');
  }
  const pickerUrl = session.pickerUri.endsWith('/autoclose')
    ? session.pickerUri
    : `${session.pickerUri.replace(/\/$/, '')}/autoclose`;
  progress({
    phase: 'Select photos in Google Photos, then tap Done…',
    completed: 0,
    total: 1,
  });
  const popup = window.open(pickerUrl, 'google-photos-picker', 'width=480,height=820');
  if (!popup) {
    window.location.assign(pickerUrl);
  }
  const finished = await waitForPickedSession(session, token, progress);
  progress({ phase: 'Counting selected Google Photos…', completed: 0, total: 1 });
  const count = await countSessionMediaItems(finished.id || session.id, token);
  if (!count) {
    throw new Error('No Google Photos were selected. Open the picker again and tap Done.');
  }
  return { token, sessionId: finished.id || session.id, count };
}

export async function extractGooglePhotosRemote(
  token: string,
  sessionIds: string[],
  mode: Mode,
  source: string,
  progress: (update: PhotosProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<PhotosExtractResult> {
  return extractCloudJob(
    '/extract-photos',
    token,
    { sessionIds, mode, source },
    progress,
    signal,
    {
      scope: PHOTOS_PICKER_SCOPE,
      startPhase: 'Reading your Google Photos library…',
    },
  );
}
