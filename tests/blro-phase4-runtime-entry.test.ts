import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteBrowserExecutionPortFromEnv } from '../apps/mcp-server/src/remote-browser-runtime.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Phase 4 MCP remote runtime entry', () => {
  it('stays local when no remote URL is configured', () => {
    expect(createRemoteBrowserExecutionPortFromEnv({})).toBeUndefined();
  });

  it('fails closed when remote mode is incomplete', () => {
    expect(() => createRemoteBrowserExecutionPortFromEnv({
      SANGFOR_REMOTE_BROWSER_URL: 'https://127.0.0.1:4443/v1/browser-jobs',
    })).toThrow('REMOTE_BROWSER_CONFIG_MISSING');
  });

  it('constructs the remote port only with complete file-backed TLS and signing keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase4-runtime-'));
    dirs.push(dir);
    const pair = generateKeyPairSync('ed25519');
    const values = {
      'client.crt': 'not-read-until-dispatch',
      'client.key': 'not-read-until-dispatch',
      'ca.crt': 'not-read-until-dispatch',
      'capability.key': pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    };
    for (const [name, value] of Object.entries(values)) {
      writeFileSync(join(dir, name), value, { mode: 0o600 });
    }
    const port = createRemoteBrowserExecutionPortFromEnv({
      SANGFOR_REMOTE_BROWSER_URL: 'https://127.0.0.1:4443/v1/browser-jobs',
      SANGFOR_TENANT_ID: 'tenant-a',
      SANGFOR_PROJECT_ID: 'project-a',
      SANGFOR_REMOTE_BROWSER_INSTALLATION_ID: 'install-a',
      SANGFOR_REMOTE_BROWSER_CLIENT_IDENTITY_ID: 'client:install-a',
      SANGFOR_REMOTE_BROWSER_CAPABILITY_PRIVATE_KEY_PATH: join(dir, 'capability.key'),
      SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH: join(dir, 'client.crt'),
      SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH: join(dir, 'client.key'),
      SANGFOR_REMOTE_BROWSER_CA_CERT_PATH: join(dir, 'ca.crt'),
      SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256: 'a'.repeat(64),
    });
    expect(port).toHaveProperty('execute');
  });
});
