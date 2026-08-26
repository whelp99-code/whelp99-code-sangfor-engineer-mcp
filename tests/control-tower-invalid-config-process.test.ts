import { on, once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close', { signal: AbortSignal.timeout(5_000) });
  child.kill('SIGTERM');
  await closed;
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
});

async function startMalformedConfigProcess(databaseUrl: string): Promise<{
  readonly baseUrl: string;
  readonly child: ChildProcess;
  readonly stderr: () => string;
}> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'MCP_NO_SERVE' && key !== 'VITEST'),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/control-tower/src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...inherited,
      PORT: '0',
      BIND_HOST: '127.0.0.1',
      SANGFOR_API_TOKEN: 'test-token',
      SANGFOR_TOWER_SEED_PLAYBOOKS: '0',
      SANGFOR_BLRO_AUTHORITY_STORE: 'postgres',
      DATABASE_URL: databaseUrl,
      SANGFOR_TENANT_ID: 'tenant-a',
      SANGFOR_PROJECT_ID: 'project-a',
      SANGFOR_BLRO_SIGNING_PRIVATE_KEY_PATH: '/missing/signing.key',
      SANGFOR_BLRO_TRUST_BUNDLE_PATH: '/missing/ca.crt',
      SANGFOR_BLRO_AUDIT_SECRET: 'a'.repeat(32),
      SANGFOR_OPERATOR_APPROVAL_SECRET: 'o'.repeat(32),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  if (!child.stdout || !child.stderr) throw new Error('Control Tower stdio pipes unavailable.');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  for await (const [line] of on(lines, 'line', { signal: AbortSignal.timeout(5_000) })) {
    const match = String(line).match(/Control Tower listening on (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match?.[1] && !match[1].endsWith(':0')) return { baseUrl: match[1], child, stderr: () => stderr };
  }
  throw new Error('Control Tower closed before listening.');
}

async function get(baseUrl: string, path: string, method = 'GET'): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('control-tower malformed authority config process shell', () => {
  it('keeps process truth live and refuses readiness and authority APIs with redacted typed reasons', async () => {
    const malformedUrl = 'postgresql://operator:must-not-leak@%';
    const processHandle = await startMalformedConfigProcess(malformedUrl);

    const [health, live, ready, dispatch] = await Promise.all([
      get(processHandle.baseUrl, '/health'),
      get(processHandle.baseUrl, '/live'),
      get(processHandle.baseUrl, '/ready'),
      get(processHandle.baseUrl, '/api/runs', 'POST'),
    ]);

    expect(health).toMatchObject({ status: 200, body: { ok: true, state: 'running' } });
    expect(live).toMatchObject({ status: 200, body: { ok: true, state: 'running' } });
    expect(ready).toMatchObject({
      status: 503,
      body: {
        ok: false,
        checks: { config: { ok: false, reason: { code: 'CONFIG_INVALID', fields: ['DATABASE_URL'] } } },
      },
    });
    expect(dispatch).toMatchObject({
      status: 503,
      body: { error: 'BLRO authority is not ready', reason: 'CONFIG_INVALID' },
    });
    expect(processHandle.stderr()).not.toContain(malformedUrl);
    await stopChild(processHandle.child);
  });
});
