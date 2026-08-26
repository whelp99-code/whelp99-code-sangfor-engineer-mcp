import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { X509Certificate, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRemoteBrowserJobServer,
  fingerprintsMatch,
  type BrowserExecutionRequest,
} from '../../packages/sangfor-browser-contracts/src/index.js';
import { z } from 'zod';
import { executorObservation, executorResult } from './iag-executor-runtime-fixture.js';
import type { iagOrchestratorFixture } from './iag-orchestrator-fixture.js';
import { StdioJsonRpcClient, type StdioProcess } from './stdio-json-rpc-client.js';

type IagFixture = Awaited<ReturnType<typeof iagOrchestratorFixture>>;

export const persistedCounterSchema = z.object({
  preflight: z.number().int().nonnegative(),
  dispatch: z.number().int().nonnegative(),
  readBack: z.number().int().nonnegative(),
}).strict().readonly();

function openssl(root: string, args: readonly string[]): void {
  execFileSync('openssl', args, { cwd: root, stdio: 'pipe' });
}

function createMtlsFiles(root: string) {
  openssl(root, ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'ca.key', '-out', 'ca.crt',
    '-days', '1', '-nodes', '-subj', '/CN=IAG-MCP-STDIO-Test-CA']);
  openssl(root, ['req', '-newkey', 'rsa:2048', '-keyout', 'server.key', '-out', 'server.csr',
    '-nodes', '-subj', '/CN=localhost']);
  writeFileSync(join(root, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl(root, ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'server.ext']);
  openssl(root, ['req', '-newkey', 'rsa:2048', '-keyout', 'client.key', '-out', 'client.csr',
    '-nodes', '-subj', '/CN=iag-mcp-stdio-client']);
  openssl(root, ['x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'client.crt', '-days', '1']);
  const read = (name: string) => readFileSync(join(root, name), 'utf8');
  const serverCert = read('server.crt');
  const clientCert = read('client.crt');
  return {
    caPath: join(root, 'ca.crt'), serverCert, serverKey: read('server.key'),
    clientCertPath: join(root, 'client.crt'), clientKeyPath: join(root, 'client.key'),
    serverFingerprint: new X509Certificate(serverCert).fingerprint256,
    clientFingerprint: new X509Certificate(clientCert).fingerprint256,
  };
}

function adaptChild(child: ChildProcessWithoutNullStreams): StdioProcess {
  return {
    write: (line) => { child.stdin.write(line); },
    endInput: () => { child.stdin.end(); },
    kill: (signal) => { child.kill(signal); },
    onStdout: (listener) => { child.stdout.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))); },
    onStderr: (listener) => { child.stderr.on('data', (chunk: Buffer) => listener(chunk.toString('utf8'))); },
    onError: (listener) => { child.once('error', listener); },
    onExit: (listener) => { child.once('exit', (code, signal) => listener(code, signal)); },
    onClose: (listener) => { child.once('close', listener); },
  };
}

export async function startIagMcpStdioProcess(input: {
  readonly root: string;
  readonly fixture: IagFixture;
  readonly environment: Readonly<Record<string, string>>;
}) {
  const tls = createMtlsFiles(input.root);
  const counterPath = join(input.root, 'mock-counters.json');
  const counters = { preflight: 0, dispatch: 0, readBack: 0 };
  writeFileSync(counterPath, JSON.stringify(counters));
  const server = await createRemoteBrowserJobServer({
    host: '127.0.0.1', port: 0,
    tls: { cert: tls.serverCert, key: tls.serverKey, ca: readFileSync(tls.caPath, 'utf8') },
    authorizeClient: (identity) => fingerprintsMatch(identity.fingerprint256, tls.clientFingerprint),
    executor: { async execute(request: BrowserExecutionRequest) {
      const present = request.requestId.endsWith('-independent-readback');
      if (request.requestId.endsWith('-preflight')) counters.preflight += 1;
      else if (present) counters.readBack += 1;
      else counters.dispatch += 1;
      writeFileSync(counterPath, JSON.stringify(counters));
      return request.operation.kind === 'observe_console'
        ? executorResult(request, executorObservation(input.fixture.action, present))
        : executorResult(request);
    } },
  });
  const capability = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const capabilityPath = join(input.root, 'capability-private.pem');
  writeFileSync(capabilityPath, capability);
  const env = { ...process.env, ...input.environment,
    SANGFOR_REMOTE_BROWSER_URL: server.baseUrl, SANGFOR_TENANT_ID: 'todo17-tenant',
    SANGFOR_PROJECT_ID: 'todo17-project', SANGFOR_REMOTE_BROWSER_INSTALLATION_ID: 'todo17-installation',
    SANGFOR_REMOTE_BROWSER_CLIENT_IDENTITY_ID: 'todo17-client',
    SANGFOR_REMOTE_BROWSER_CAPABILITY_PRIVATE_KEY_PATH: capabilityPath,
    SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH: tls.clientCertPath,
    SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH: tls.clientKeyPath,
    SANGFOR_REMOTE_BROWSER_CA_CERT_PATH: tls.caPath,
    SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256: tls.serverFingerprint,
    SANGFOR_REMOTE_BROWSER_SERVER_NAME: 'localhost' };
  Reflect.deleteProperty(env, 'VITEST');
  Reflect.deleteProperty(env, 'MCP_NO_SERVE');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/mcp-server/src/index.ts'], {
    cwd: join(import.meta.dirname, '../..'), env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new StdioJsonRpcClient({ process: adaptChild(child) });
  try {
    await client.ready();
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      await server.close();
      throw new AggregateError([error, closeError], 'MCP_STDIO_START_AND_CLOSE_FAILED');
    }
    await server.close();
    throw error;
  }
  return {
    client, counterPath,
    close: async () => {
      try {
        await client.close();
      } finally {
        await server.close();
      }
    },
  };
}
