import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extractDriveZips, parseExtractRequest } from './extract';
import { extractGooglePhotos, parsePhotosExtractRequest } from './photos';
import {
  JOB_ID,
  createJob,
  failJob,
  finishJob,
  getJob,
  setJobProgress,
  setJobToken,
  type ExtractJob,
} from './jobs';

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://kkam717.github.io,http://127.0.0.1:43123,http://localhost:43123')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function requestOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  return typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = requestOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(origin ? 204 : 403);
    res.end();
    return true;
  }
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) {
      throw new Error('The extract request is too large.');
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function writeEvent(res: ServerResponse, payload: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  return res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startExtract(job: ExtractJob, request: ReturnType<typeof parseExtractRequest>): void {
  void extractDriveZips(() => job.token, request, (progress) => {
    setJobProgress(job, progress);
  })
    .then((result) => {
      finishJob(job, result);
      console.log(`[extract] job ${job.id} done`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'The Drive export could not be processed.';
      console.error(`[extract] job ${job.id} failed`, error);
      failJob(job, message);
    });
}

async function streamJob(job: ExtractJob, req: IncomingMessage, res: ServerResponse): Promise<void> {
  req.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`:${' '.repeat(2048)}\n\n`);
  writeEvent(res, { type: 'job', jobId: job.id });
  writeEvent(res, { type: 'progress', ...job.progress });

  let closed = false;
  const onClose = () => {
    closed = true;
  };
  req.on('close', onClose);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n');
  }, 5_000);

  try {
    let last = '';
    while (!closed && job.status === 'running') {
      const next = JSON.stringify(job.progress);
      if (next !== last) {
        last = next;
        if (!writeEvent(res, { type: 'progress', ...job.progress })) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (closed) return;
    if (job.status === 'error') {
      writeEvent(res, {
        type: 'error',
        message: job.error || 'The Drive export could not be processed.',
      });
      return;
    }
    if (job.status === 'done' && job.result) {
      writeEvent(res, {
        type: 'done',
        archive: Buffer.from(job.result.archive).toString('base64'),
        rows: job.result.rows,
        manifest: job.result.manifest,
      });
    }
  } finally {
    clearInterval(heartbeat);
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

function startPhotosExtract(job: ExtractJob, request: ReturnType<typeof parsePhotosExtractRequest>): void {
  void extractGooglePhotos(() => job.token, request, (progress) => {
    setJobProgress(job, progress);
  })
    .then((result) => {
      finishJob(job, result);
      console.log(`[extract-photos] job ${job.id} done`);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'The Google Photos library could not be processed.';
      console.error(`[extract-photos] job ${job.id} failed`, error);
      failJob(job, message);
    });
}

async function handleExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = requestOrigin(req);
  if (req.headers.origin && !origin) {
    sendJson(res, 403, { message: 'This site is not allowed to use the extractor.' });
    return;
  }
  const token = bearerToken(req);
  const request = parseExtractRequest(await readJson(req));
  const job = createJob(token);
  console.log(`[extract] job ${job.id} started`);
  startExtract(job, request);
  await streamJob(job, req, res);
}

async function handlePhotosExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = requestOrigin(req);
  if (req.headers.origin && !origin) {
    sendJson(res, 403, { message: 'This site is not allowed to use the extractor.' });
    return;
  }
  const token = bearerToken(req);
  const request = parsePhotosExtractRequest(await readJson(req));
  const job = createJob(token);
  console.log(`[extract-photos] job ${job.id} started`);
  startPhotosExtract(job, request);
  await streamJob(job, req, res);
}

async function handleJob(req: IncomingMessage, res: ServerResponse, jobId: string): Promise<void> {
  const origin = requestOrigin(req);
  if (req.headers.origin && !origin) {
    sendJson(res, 403, { message: 'This site is not allowed to use the extractor.' });
    return;
  }
  const job = getJob(jobId);
  if (!job) {
    sendJson(res, 404, { message: 'That extract job is no longer available. Start it again.' });
    return;
  }
  await streamJob(job, req, res);
}

const server = createServer((req, res) => {
  void (async () => {
    if (applyCors(req, res)) return;
    const url = new URL(req.url || '/', 'http://extractor.local');
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/extract') {
      await handleExtract(req, res);
      return;
    }
    if (req.method === 'POST' && path === '/extract-photos') {
      await handlePhotosExtract(req, res);
      return;
    }
    const tokenMatch = /^\/extract\/([^/]+)\/token$/.exec(path);
    if (req.method === 'POST' && tokenMatch?.[1] && JOB_ID.test(tokenMatch[1])) {
      const origin = requestOrigin(req);
      if (req.headers.origin && !origin) {
        sendJson(res, 403, { message: 'This site is not allowed to use the extractor.' });
        return;
      }
      const job = getJob(tokenMatch[1]);
      const token = bearerToken(req);
      if (!job || job.status !== 'running' || !token) {
        sendJson(res, 404, { message: 'That extract job is no longer available. Start it again.' });
        return;
      }
      setJobToken(job, token);
      sendJson(res, 200, { ok: true });
      return;
    }
    const jobMatch = /^\/extract\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && jobMatch?.[1] && JOB_ID.test(jobMatch[1])) {
      await handleJob(req, res, jobMatch[1]);
      return;
    }
    sendJson(res, 404, { message: 'Not found.' });
  })().catch((error) => {
    if (!res.headersSent) {
      sendJson(res, 500, {
        message:
          error instanceof Error ? error.message : 'The extractor failed unexpectedly.',
      });
      return;
    }
    if (!res.writableEnded) res.end();
  });
});

server.timeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`extract api listening on ${PORT}`);
});
