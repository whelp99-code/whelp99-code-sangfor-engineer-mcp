import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRemoteBrowserExecutionPortFromEnv } from '../apps/mcp-server/src/remote-browser-runtime.js';
import { NODE_RUNTIME_PINS } from '../packages/sangfor-browser-contracts/src/protocol-version.js';

const repoFile = (relative: string): string => readFileSync(
  new URL(`../${relative}`, import.meta.url),
  'utf8',
);

const runtimePackageSchema = z.object({
  packageManager: z.literal(`pnpm@${NODE_RUNTIME_PINS.pnpm}`),
  engines: z.object({
    node: z.literal(`>=${NODE_RUNTIME_PINS.blroMajor} <${NODE_RUNTIME_PINS.jmMajor + 1}`),
    pnpm: z.literal(NODE_RUNTIME_PINS.pnpm),
  }).strict(),
}).strip();

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
      SANGFOR_AUTHORITY_EPOCH: '0',
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

describe('pinned runtime lanes', () => {
  it('declares the supported Node engine range in the package manifest', () => {
    const manifest: unknown = JSON.parse(repoFile('package.json'));
    expect(() => runtimePackageSchema.parse(manifest)).not.toThrow();
  });

  it('rejects a workspace package manifest whose engine pins are omitted', () => {
    const omittedEnginePins = { packageManager: `pnpm@${NODE_RUNTIME_PINS.pnpm}` };
    expect(runtimePackageSchema.safeParse(omittedEnginePins).success).toBe(false);
  });

  it('makes the declared engine range binding for local installs', () => {
    // Given engines is only advisory to pnpm by default,
    // Then .npmrc must turn it into a refusal.
    expect(repoFile('.npmrc')).toMatch(/^engine-strict=true$/m);
  });

  it('ships the container on the BLRO Node major', () => {
    expect(repoFile('Dockerfile'))
      .toMatch(new RegExp(`^FROM node:${NODE_RUNTIME_PINS.blroMajor}-alpine AS base$`, 'm'));
    expect(repoFile('Dockerfile')).not.toMatch(/node:20/);
  });
});
