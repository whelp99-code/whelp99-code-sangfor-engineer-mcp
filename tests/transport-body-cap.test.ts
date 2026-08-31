import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  readCappedRequestBody,
} from '../packages/shared/src/runtime-body-cap.js';

// Importing the bridge module must NOT assert bind safety or bind a real port.
process.env.BRIDGE_NO_SERVE = '1';

const TOKEN = 'body-cap-token';

// ── reader unit rung ────────────────────────────────────────────────────────
// A counting generator stands in for a socket: it reports how much of the body
// the reader actually pulled, which is the only way to tell "refused after
// buffering everything" apart from "stopped as the bytes crossed the limit".
type CountingBody = {
  readonly stream: Readable;
  readonly pulledChunks: () => number;
};

function countingBody(chunkBytes: number, chunkCount: number): CountingBody {
  const chunk = Buffer.alloc(chunkBytes, 0x78);
  let pulled = 0;
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let index = 0; index < chunkCount; index += 1) {
      pulled += 1;
      yield chunk;
    }
  }
  return { stream: Readable.from(chunks()), pulledChunks: () => pulled };
}

async function captureTooLarge(action: () => Promise<unknown>): Promise<RequestBodyTooLargeError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return error;
    throw error;
  }
  throw new Error('expected the reader to refuse the body');
}

describe('capped request body reader', () => {
  it('Given the shared cap, When it is read, Then it is 64 MiB', () => {
    // Given / When / Then — the number the three servers share.
    expect(MAX_REQUEST_BODY_BYTES).toBe(64 * 1024 * 1024);
  });

  it('Given a body under the cap, When it is read, Then the whole text is returned', async () => {
    // Given
    const stream = Readable.from([Buffer.from('{"name":"'), Buffer.from('device-1"}')]);

    // When
    const body = await readCappedRequestBody(stream, 1_024);

    // Then
    expect(body).toBe('{"name":"device-1"}');
  });

  it('Given a body exactly at the cap, When it is read, Then it is accepted', async () => {
    // Given
    const body = countingBody(512, 2);

    // When
    const text = await readCappedRequestBody(body.stream, 1_024);

    // Then
    expect(text).toHaveLength(1_024);
  });

  it('Given a body one byte past the cap, When it is read, Then it is refused with the limit and the observed size', async () => {
    // Given
    const stream = Readable.from([Buffer.alloc(1_024, 0x78), Buffer.alloc(1, 0x78)]);

    // When
    const error = await captureTooLarge(() => readCappedRequestBody(stream, 1_024));

    // Then
    expect(error.limitBytes).toBe(1_024);
    expect(error.observedBytes).toBe(1_025);
  });

  it('Given a body far past the cap, When it is read, Then it stops at the crossing chunk instead of buffering the rest', async () => {
    // Given — 4 MiB offered, 4 KiB allowed, in 1 KiB chunks.
    const body = countingBody(1_024, 4_096);

    // When
    const error = await captureTooLarge(() => readCappedRequestBody(body.stream, 4_096));

    // Then — refused after the 5th KiB, not after the 4096th.
    expect(error.observedBytes).toBe(5_120);
    expect(body.pulledChunks()).toBeLessThan(64);
    expect(body.pulledChunks()).toBeLessThan(4_096);
  });

  it('Given an oversized body, When it is refused, Then the stream is left undestroyed so a 413 can still be written', async () => {
    // Given
    const body = countingBody(1_024, 4_096);

    // When
    await captureTooLarge(() => readCappedRequestBody(body.stream, 2_048));

    // Then — destroying here would reset the socket and lose the response.
    expect(body.stream.destroyed).toBe(false);
  });

  it('Given multi-byte text, When it is read, Then the cap counts UTF-8 bytes and not characters', async () => {
    // Given — 4 characters, 12 UTF-8 bytes.
    const stream = Readable.from(['한글테스트'.slice(0, 4)]);

    // When
    const error = await captureTooLarge(() => readCappedRequestBody(stream, 11));

    // Then
    expect(error.observedBytes).toBe(12);
  });
});

// ── server rung ────────────────────────────────────────────────────────────
const OVERSIZED_BODY = Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1_024, 0x78);
const DECLARED_HUGE_BYTES = MAX_REQUEST_BODY_BYTES * 4;

let servers: http.Server[] = [];
let tempDirs: string[] = [];
let savedApiToken: string | undefined;

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  if (savedApiToken === undefined) delete process.env.SANGFOR_API_TOKEN;
  else process.env.SANGFOR_API_TOKEN = savedApiToken;
  savedApiToken = undefined;
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function statusOf(request: http.ClientRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    let answered = false;
    request.on('response', (response) => {
      answered = true;
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', (error) => {
      // Once the server has answered it stops reading the upload, so the write
      // side breaking is the expected end of an early-stopped request.
      if (!answered) reject(error);
    });
  });
}

function oversizedPost(port: number, path: string, headers: Record<string, string>): Promise<number> {
  const request = http.request({
    host: '127.0.0.1', port, path, method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
  const status = statusOf(request);
  request.end(OVERSIZED_BODY);
  return status;
}

/** Declares a huge body and sends almost none of it: only a server that
 *  authenticates before touching the stream can answer at all. */
function declaredHugePost(port: number, path: string, headers: Record<string, string>): Promise<number> {
  const request = http.request({
    host: '127.0.0.1', port, path, method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(DECLARED_HUGE_BYTES),
      ...headers,
    },
  });
  const status = statusOf(request);
  request.write(Buffer.alloc(1_024, 0x78));
  return status;
}

async function bridgeServer(): Promise<number> {
  const { createBridgeServer } = await import('../apps/http-bridge/src/server.js');
  return listen(createBridgeServer({
    apiToken: TOKEN,
    mcpRequest: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
  }));
}

async function towerServer(): Promise<number> {
  const { createTowerServer } = await import('../apps/control-tower/src/server.js');
  const runsDir = mkdtempSync(join(tmpdir(), 'body-cap-runs-'));
  const registryDir = mkdtempSync(join(tmpdir(), 'body-cap-registry-'));
  tempDirs.push(runsDir, registryDir);
  return listen(createTowerServer({
    authorityMode: 'local',
    runsDir,
    registryDir,
    approvalSecret: 'body-cap-secret',
    apiToken: TOKEN,
    bridgeUrl: 'http://127.0.0.1:1',
    mockConsoleUrl: 'http://127.0.0.1:1',
  }));
}

async function operatorServer(token: string | undefined): Promise<number> {
  savedApiToken = process.env.SANGFOR_API_TOKEN;
  if (token === undefined) delete process.env.SANGFOR_API_TOKEN;
  else process.env.SANGFOR_API_TOKEN = token;
  const { createOperatorServer } = await import('../apps/operator-console/src/server.js');
  return listen(createOperatorServer());
}

describe('http-bridge request body cap', () => {
  it('Given an authorized POST past the cap, When it is sent, Then the bridge answers 413', async () => {
    // Given
    const port = await bridgeServer();

    // When
    const status = await oversizedPost(port, '/mcp', { authorization: `Bearer ${TOKEN}` });

    // Then
    expect(status).toBe(413);
  }, 60_000);

  it('Given an unauthorized POST declaring a huge body, When it is sent, Then the bridge answers 401 without reading it', async () => {
    // Given
    const port = await bridgeServer();

    // When
    const status = await declaredHugePost(port, '/mcp', {});

    // Then
    expect(status).toBe(401);
  }, 30_000);
});

describe('control-tower request body cap', () => {
  it('Given an authorized POST past the cap, When it is sent, Then the tower answers 413', async () => {
    // Given
    const port = await towerServer();

    // When
    const status = await oversizedPost(port, '/api/devices', { authorization: `Bearer ${TOKEN}` });

    // Then
    expect(status).toBe(413);
  }, 60_000);

  it('Given an unauthorized POST declaring a huge body, When it is sent, Then the tower answers 401 without reading it', async () => {
    // Given
    const port = await towerServer();

    // When
    const status = await declaredHugePost(port, '/api/devices', {});

    // Then
    expect(status).toBe(401);
  }, 30_000);
});

describe('operator-console request body cap', () => {
  it('Given an authorized POST past the cap, When it is sent, Then the console answers 413', async () => {
    // Given
    const port = await operatorServer(TOKEN);

    // When
    const status = await oversizedPost(port, '/api/analyze-project', { authorization: `Bearer ${TOKEN}` });

    // Then
    expect(status).toBe(413);
  }, 60_000);

  it('Given an unauthorized POST declaring a huge body, When it is sent, Then the console answers 401 without reading it', async () => {
    // Given
    const port = await operatorServer(TOKEN);

    // When
    const status = await declaredHugePost(port, '/api/analyze-project', {});

    // Then
    expect(status).toBe(401);
  }, 30_000);
});
