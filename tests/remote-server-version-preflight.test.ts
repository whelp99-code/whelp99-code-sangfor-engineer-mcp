import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  createRemoteBrowserJobServer,
} from '../packages/sangfor-browser-contracts/src/remote-transport.js';
import type { BrowserExecutionRequest } from '../packages/sangfor-browser-contracts/src/browser-execution.js';
import { TestRemoteJobStore } from './helpers/remote-job-store-fake.js';
import {
  generateRemoteMtlsFixture,
  type RemoteMtlsFixture,
} from './support/remote-mtls-fixture.js';

const servers: Array<{ close(): Promise<void> }> = [];
let fixture: RemoteMtlsFixture;

beforeAll(() => {
  fixture = generateRemoteMtlsFixture();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(() => {
  fixture.remove();
});

describe('remote server contract-version preflight', () => {
  it('refuses an unsupported version before consuming a slow body or reserving a job', async () => {
    // Given an authorized peer with an unsupported version and an unfinished body.
    const store = new TestRemoteJobStore();
    const execute = vi.fn(async (_request: BrowserExecutionRequest): Promise<never> => {
      throw new Error('Execution must not be reached.');
    });
    const server = await createRemoteBrowserJobServer({
      tls: { cert: fixture.serverCert, key: fixture.serverKey, ca: fixture.caCert },
      executor: { execute },
      authorizeClient: () => true,
      jobStore: store,
    });
    servers.push(server);
    const request = httpsRequest({
      host: '127.0.0.1',
      port: server.port,
      path: REMOTE_BROWSER_JOB_PATH,
      method: 'POST',
      cert: fixture.authorizedClientCert,
      key: fixture.authorizedClientKey,
      ca: fixture.caCert,
      servername: 'localhost',
      signal: AbortSignal.timeout(2_000),
      headers: {
        [CONTRACT_VERSION_HEADER]: `${BLRO_CONTRACT_VERSION.major + 1}.0`,
        'transfer-encoding': 'chunked',
      },
    });
    const pendingResponse = new Promise<IncomingMessage>((resolve, reject) => {
      request.once('response', resolve);
      request.once('error', reject);
    });

    // When only the first body chunk is sent.
    request.write('unfinished');
    const response = await pendingResponse;
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    request.destroy();

    // Then protocol preflight refuses without waiting for or dispatching the body.
    expect(response.statusCode).toBe(426);
    expect(Buffer.concat(chunks).toString('utf8'))
      .toContain('REMOTE_CONTRACT_VERSION_UNSUPPORTED');
    expect(store.reserves).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
