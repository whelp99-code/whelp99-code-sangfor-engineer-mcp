import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROMIUM_PATH } from '../packages/sangfor-chrome/src/index.js';
import { readCapturePayload } from '../packages/sangfor-collector/src/capture-bundle.js';
import { ObserverSessionManager } from '../packages/sangfor-observer/src/index.js';
import { HttpCdpObserverTransport } from '../packages/sangfor-jm-execution/src/observer-transport.js';

const DEVICE_SCOPE = '018f22e2-79b0-7cc3-8c3c-0f8e5d50a2bf';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('E2E fixture server did not expose a port.');
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  if (port === 9222) return reservePort();
  return port;
}

async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch { /* not ready */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Chrome CDP did not become ready.');
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolvePromise) => process.once('exit', () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 3_000)),
  ]);
  if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
}

async function main(): Promise<void> {
  let mutationEndpointCount = 0;
  const fixture = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') mutationEndpointCount += 1;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><body><nav role="navigation"></nav><main role="main"><form></form></main></body></html>`);
  });
  const fixturePort = await listen(fixture);
  const cdpPort = await reservePort();
  const root = mkdtempSync(join(tmpdir(), 'observer-e2e-'));
  const profileDir = join(root, 'chrome-profile');
  const origin = `http://127.0.0.1:${fixturePort}`;
  const chrome = spawn(CHROMIUM_PATH, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--app=${origin}/`,
  ], { stdio: 'ignore' });
  const keyring = { activeKeyId: 'e2e-key', keys: { 'e2e-key': Buffer.alloc(32, 0x24) } };
  try {
    await waitForCdp(cdpPort);
    const transport = new HttpCdpObserverTransport();
    const initialPages = await transport.listPages(cdpPort);
    if (initialPages.length !== 1) throw new Error(`E2E expected exactly one page, got ${initialPages.length}.`);
    const before = await transport.snapshot(cdpPort);
    const manager = new ObserverSessionManager([{
      product: 'ENDPOINT_SECURE', expectedOrigin: origin, cdpPort,
      firmwareTruthId: 'e2e-firmware-truth', deviceScope: DEVICE_SCOPE,
    }], transport, () => new Date('2026-07-28T06:00:00.000Z'));
    const session = await manager.attach({
      product: 'ENDPOINT_SECURE', expectedOrigin: origin, cdpPort,
      firmwareTruthId: 'e2e-firmware-truth',
    });
    const summary = await manager.capture({
      sessionHandle: session.handle,
      durationMs: 100,
      capturesDir: join(root, 'captures'),
      stagingRoot: join(root, 'staging'),
      keyring,
      firmwareVersion: '6.0.4',
    });
    const after = await transport.snapshot(cdpPort);
    const payload = readCapturePayload(summary.path, keyring) as { capture?: { storageMutationCount?: number } };
    const pageInvariant = JSON.stringify(before.pages) === JSON.stringify(after.pages);
    const pidInvariant = before.browserPid === after.browserPid && after.browserAlive;
    const storageMutationCount = payload.capture?.storageMutationCount ?? -1;
    if (!pageInvariant || !pidInvariant || storageMutationCount !== 0 || mutationEndpointCount !== 0) {
      throw new Error('Observer E2E invariant failed.');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      forbiddenCdpAttach: 0,
      storageMutationCount,
      mutationEndpointDelta: mutationEndpointCount,
      pageInvariant,
      pidInvariant,
      bundleVersion: 'capture-bundle.v1',
    })}\n`);
  } finally {
    await stopProcess(chrome);
    await new Promise<void>((resolvePromise) => fixture.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
