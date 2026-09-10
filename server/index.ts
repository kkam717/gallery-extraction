import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extractDriveZips, parseExtractRequest } from './extract';

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

function writeEvent(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleExtract(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = requestOrigin(req);
  if (req.headers.origin && !origin) {
    sendJson(res, 403, { message: 'This site is not allowed to use the extractor.' });
    return;
  }
  const token = bearerToken(req);
  const request = parseExtractRequest(await readJson(req));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const heartbeat = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);
  try {
    const result = await extractDriveZips(token, request, (progress) => {
      writeEvent(res, { type: 'progress', ...progress });
    });
    writeEvent(res, {
      type: 'done',
      archive: Buffer.from(result.archive).toString('base64'),
      rows: result.rows,
      manifest: result.manifest,
    });
  } catch (error) {
    writeEvent(res, {
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'The Drive export could not be processed.',
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

const server = createServer((req, res) => {
  void (async () => {
    if (applyCors(req, res)) return;
    const path = new URL(req.url || '/', 'http://extractor.local').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/extract') {
      await handleExtract(req, res);
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
    res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`extract api listening on ${PORT}`);
});
