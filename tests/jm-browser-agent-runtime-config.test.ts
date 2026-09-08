import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseJmAgentConfig,
  type JmAgentEnvironment,
} from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_SESSION_ID,
  JM_TENANT_ID,
  buildGrantSnapshot,
  createJmSigningMaterial,
  createJmTlsMaterial,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;
let snapshotPath: string;
let profileRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
  profileRoot = join(root, 'profile');
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  snapshotPath = join(root, 'grant-snapshot.jws');
  writeFileSync(snapshotPath, buildGrantSnapshot(signing));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function baseEnvironment(): Record<string, string> {
  return {
    SANGFOR_JM_AGENT_BIND_HOST: '127.0.0.1',
    SANGFOR_JM_AGENT_PORT: '39443',
    SANGFOR_JM_AGENT_TLS_CERT_PATH: tls.serverCertPath,
    SANGFOR_JM_AGENT_TLS_KEY_PATH: tls.serverKeyPath,
    SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: tls.caPath,
    SANGFOR_JM_AGENT_BLRO_CLIENT_FINGERPRINT_SHA256: tls.clientFingerprint256,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SUBJECT_CN: 'blro-control-tower',
    SANGFOR_JM_AGENT_BLRO_CLIENT_SERIAL: tls.clientSerial,
    SANGFOR_JM_AGENT_BLRO_CLIENT_SAN_URI: tls.clientSubjectAltName,
    SANGFOR_JM_AGENT_BLRO_CLIENT_ISSUER_CN: 'Task26-Trusted-CA',
    SANGFOR_JM_AGENT_VERIFY_KEY_RING_PATH: signing.keyRingPath,
    SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH: snapshotPath,
    SANGFOR_JM_AGENT_JOURNAL_ROOT: join(root, 'journal'),
    SANGFOR_JM_AGENT_TENANT_ID: JM_TENANT_ID,
    SANGFOR_JM_AGENT_PROJECT_ID: JM_PROJECT_ID,
    SANGFOR_JM_AGENT_INSTALLATION_ID: JM_INSTALLATION_ID,
    SANGFOR_JM_AGENT_DEVICE_BINDING_DIGEST: JM_DEVICE_DIGEST,
    SANGFOR_JM_AGENT_BROWSER_PROFILE_REF: 'task26-profile',
    SANGFOR_JM_AGENT_BROWSER_PROFILE_ROOT: profileRoot,
    SANGFOR_JM_AGENT_BROWSER_SESSION_ID: JM_SESSION_ID,
    SANGFOR_JM_AGENT_BROWSER_CHROMIUM_PATH: '/usr/bin/chromium',
    SANGFOR_JM_AGENT_ALLOWED_ORIGIN: JM_ORIGIN,
    SANGFOR_JM_AGENT_JOB_TIMEOUT_MS: '30000',
    SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '10000',
    SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS: '900000',
  };
}

function parse(overrides: Record<string, string | undefined> = {}) {
  return parseJmAgentConfig({ ...baseEnvironment(), ...overrides } as JmAgentEnvironment);
}

describe('JM agent configuration boundary', () => {
  it('accepts a complete operated loopback configuration', () => {
    const result = parse();

    expect(result.success, JSON.stringify(result.success ? [] : result.issues)).toBe(true);
    if (!result.success) return;
    expect(result.data.bindHost).toBe('127.0.0.1');
    expect(result.data.browserProfileRef).toBe('task26-profile');
  });

  it('has no execution-mode field at all and refuses every mock switch', () => {
    // Given the shipped field set. Then no mode/mock field exists.
    expect(Object.keys(baseEnvironment())).not.toContain('SANGFOR_JM_AGENT_EXECUTION_MODE');

    // When a leftover mock switch is present. Then startup is refused by name.
    for (const field of [
      'SANGFOR_JM_AGENT_EXECUTION_MODE',
      'SANGFOR_JM_AGENT_MOCK',
      'SANGFOR_JM_AGENT_MOCK_EXECUTION',
      'SANGFOR_JM_AGENT_USE_MOCK',
    ]) {
      const result = parse({ [field]: 'mock' });
      expect(result.success, field).toBe(false);
      if (result.success) continue;
      expect(result.issues.some((issue) => (
        issue.field === field && issue.code === 'CONFIG_FIELD_FORBIDDEN'
      )), field).toBe(true);
    }
  });

  it('refuses every missing required field by name', () => {
    for (const field of Object.keys(baseEnvironment())) {
      const result = parse({ [field]: undefined });
      expect(result.success, `${field} must be required`).toBe(false);
      if (result.success) continue;
      expect(result.issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it('refuses unknown extra configuration fields', () => {
    const result = parse({ SANGFOR_JM_AGENT_UNKNOWN_EXTRA: 'x' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.some((issue) => issue.code === 'CONFIG_FIELD_UNKNOWN')).toBe(true);
  });

  it('refuses a non-loopback bind host', () => {
    for (const host of ['0.0.0.0', '10.0.0.5', '::']) {
      expect(parse({ SANGFOR_JM_AGENT_BIND_HOST: host }).success, host).toBe(false);
    }
  });

  it('refuses a world-readable private key and a symlinked material path', () => {
    const loose = join(root, 'loose.key');
    writeFileSync(loose, readFileSync(tls.serverKeyPath));
    chmodSync(loose, 0o644);
    const link = join(root, 'linked-ca.crt');
    rmSync(link, { force: true });
    symlinkSync(tls.caPath, link);

    const weak = parse({ SANGFOR_JM_AGENT_TLS_KEY_PATH: loose });
    const symlinked = parse({ SANGFOR_JM_AGENT_TLS_CLIENT_CA_PATH: link });

    expect(weak.success).toBe(false);
    expect(symlinked.success).toBe(false);
    if (!weak.success) expect(weak.issues.map((i) => i.code)).toContain('KEY_PERMISSIONS_WEAK');
    if (!symlinked.success) {
      expect(symlinked.issues.map((i) => i.code)).toContain('PATH_NOT_REGULAR_FILE');
    }
  });

  it('never echoes private key or certificate bytes in issues', () => {
    const loose = join(root, 'leaky.key');
    writeFileSync(loose, readFileSync(tls.serverKeyPath));
    chmodSync(loose, 0o644);

    const serialized = JSON.stringify(parse({ SANGFOR_JM_AGENT_TLS_KEY_PATH: loose }));

    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('BEGIN CERTIFICATE');
  });
});
