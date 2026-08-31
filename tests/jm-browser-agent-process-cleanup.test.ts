import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJmAgentServer } from '../apps/jm-browser-agent/src/server.js';
import { startJmAgentProcess } from '../apps/jm-browser-agent/src/process.js';
import { InFlightJobs, type JmAgentEnvironment } from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_DEVICE_DIGEST,
  JM_INSTALLATION_ID,
  JM_JOURNAL_GENESIS,
  JM_ORIGIN,
  JM_PROJECT_ID,
  JM_SESSION_ID,
  JM_TENANT_ID,
  buildGrantSnapshot,
  createFakeExecutionPort,
  createJmSigningMaterial,
  createJmTlsMaterial,
  initialiseTestJournal,
  type JmSigningMaterial,
  type JmTlsMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let tls: JmTlsMaterial;
let signing: JmSigningMaterial;
let profileRoot: string;
let snapshotPath: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-process-cleanup-'));
  tls = createJmTlsMaterial(root);
  signing = createJmSigningMaterial(root);
  profileRoot = join(root, 'profile');
  mkdirSync(profileRoot, { mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  snapshotPath = join(root, 'snapshot.jws');
  writeFileSync(snapshotPath, buildGrantSnapshot(signing));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function environment(port = 0): JmAgentEnvironment {
  const journalRoot = join(root, `journal-${crypto.randomUUID()}`);
  initialiseTestJournal(journalRoot, { journalEpoch: 7, genesisDigest: JM_JOURNAL_GENESIS });
  return {
    SANGFOR_JM_AGENT_BIND_HOST: '127.0.0.1',
    SANGFOR_JM_AGENT_PORT: String(port),
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
    SANGFOR_JM_AGENT_JOURNAL_ROOT: journalRoot,
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
    SANGFOR_JM_AGENT_DRAIN_DEADLINE_MS: '5000',
    SANGFOR_JM_AGENT_SNAPSHOT_MAX_AGE_MS: '900000',
  };
}

describe('JM process startup cleanup', () => {
  it('preserves a TLS server creation error while closing execution exactly once', async () => {
    // Given valid composition and a TLS server factory that rejects synchronously.
    const execution = createFakeExecutionPort();
    const primary = new TypeError('TLS key material rejected');

    // When startup reaches server creation.
    const startup = startJmAgentProcess(environment(), {
      executionPort: execution,
      createServer: () => { throw primary; },
    });

    // Then the primary error survives cleanup and the owned execution resource closes once.
    await expect(startup).rejects.toBe(primary);
    expect(execution.closes()).toBe(1);
  });

  it('closes server and execution exactly once while preserving a listen rejection', async () => {
    // Given cleanup that also rejects after a primary listen failure.
    const execution = createFakeExecutionPort();
    const primary = new Error('listen rejected');
    let serverCloses = 0;

    // When process startup rejects from listen.
    const startup = startJmAgentProcess(environment(), {
      executionPort: execution,
      createServer: () => ({
        server: createHttpsServer(),
        inFlight: new InFlightJobs(),
        listen: async () => { throw primary; },
        close: async () => { serverCloses += 1; throw new Error('cleanup rejected'); },
      }),
    });

    // Then cleanup runs once for both owners without replacing the primary error.
    await expect(startup).rejects.toBe(primary);
    expect(serverCloses).toBe(1);
    expect(execution.closes()).toBe(1);
  });

  it('closes the real server and execution once when the preflight-to-listen bind race is lost', async () => {
    // Given a port that becomes occupied only after startup preflight succeeds.
    const reservation = createNetServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (address === null || typeof address === 'string') throw new TypeError('Expected TCP address.');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
    const blocker = createNetServer();
    const execution = createFakeExecutionPort({
      startupPreflight: async () => {
        await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
        return { ok: true };
      },
    });
    let serverCloses = 0;

    try {
      // When the real HTTPS server loses that bind race.
      const startup = startJmAgentProcess(environment(port), {
        executionPort: execution,
        createServer: (composition) => {
          const server = createJmAgentServer(composition);
          return {
            ...server,
            close: async () => { serverCloses += 1; await server.close(); },
          };
        },
      });

      // Then EADDRINUSE remains primary and every owned resource closes exactly once.
      await expect(startup).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(serverCloses).toBe(1);
      expect(execution.closes()).toBe(1);
    } finally {
      if (blocker.listening) {
        await new Promise<void>((resolve, reject) => blocker.close((error) => {
          if (error) reject(error);
          else resolve();
        }));
      }
    }
  });
});
