import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkServerIdentity } from '../packages/sangfor-jm-agent/src/index.js';
import { REMOTE_BROWSER_JOB_PATH } from '../packages/sangfor-browser-contracts/src/index.js';
import { buildGrantSnapshot } from './helpers/jm-agent-fixture.js';
import { composeJmAgent, JmAgentStartupError } from '../apps/jm-browser-agent/src/composition.js';
import {
  JmStartupPreflightError, buildCoordinator, exitCodeFor, installSignalHandlers,
  startJmAgentProcess,
} from '../apps/jm-browser-agent/src/process.js';
import {
  operatedReadinessPreflight, operatedStartupPreflight, probeLoopbackBind,
} from '../apps/jm-browser-agent/src/operated-execution.js';
import { browserRequest, createFakeExecutionPort } from './helpers/jm-agent-fixture.js';
import { ExactSignal } from './helpers/exact-signal.js';
import {
  call, chromiumStubPath, environment, fixtureRoot, freshJournalRoot, profileRootPath,
  signedDispatch, signingMaterial, tlsMaterial, withServer,
} from './helpers/jm-agent-tls-integration-fixture.js';

describe('JM agent mTLS transport and per-dispatch authority', () => {
  it('serves process-only /live and dependency-aware /ready', async () => {
    await withServer({}, async ({ port }) => {
      expect((await call(port, '/live')).status).toBe(200);
      const ready = await call(port, '/ready');
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toMatchObject({
        ok: true,
        checks: { grantSnapshot: { ok: true }, journal: { ok: true } },
      });
    });
  });

  it('fails the handshake without a client certificate or from a foreign CA', async () => {
    await withServer({}, async ({ port }) => {
      await expect(call(port, '/live', { clientCert: false })).rejects.toThrow();
      await expect(call(port, '/live', { foreign: true })).rejects.toThrow();
    });
  });

  it('dispatches a signed per-request job to the executor exactly once', async () => {
    await withServer({}, async ({ port, fake }) => {
      const dispatch = signedDispatch();

      const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });

      expect(response.status).toBe(200);
      expect(fake.calls()).toBe(1);
      // JM observes; it never returns a PASS.
      expect(JSON.parse(response.body)).toMatchObject({ status: 'INDETERMINATE' });
    });
  });

  it('refuses a job with no receipt, and calls no executor', async () => {
    await withServer({}, async ({ port, fake }) => {
      const dispatch = signedDispatch();

      const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, jobId: dispatch.jobId,
      });

      expect(response.status).toBe(403);
      expect(fake.calls()).toBe(0);
    });
  });

  it('refuses a receipt bound to another client fingerprint or another key', async () => {
    await withServer({}, async ({ port, fake }) => {
      const wrongFingerprint = signedDispatch({ fingerprint: 'a'.repeat(64) });
      const foreignKey = signedDispatch({
        receiptPatch: { privateKey: signingMaterial().foreignPrivateKey },
      });

      for (const dispatch of [wrongFingerprint, foreignKey]) {
        const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
          body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
        });
        expect(response.status).toBe(403);
      }
      expect(fake.calls()).toBe(0);
    });
  });

  it('refuses a replay of the same receipt without a second executor call', async () => {
    await withServer({}, async ({ port, fake }) => {
      const dispatch = signedDispatch();
      const send = () => call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toMatchObject({ status: 'INDETERMINATE' });
      expect(fake.calls()).toBe(1);
    });
  });

  it('refuses a duplicate dispatch after a RESTART using the same journal', async () => {
    // One operator-initialised journal shared across the simulated restart.
    const journalRoot = freshJournalRoot();
    const dispatch = signedDispatch();

    await withServer({ SANGFOR_JM_AGENT_JOURNAL_ROOT: journalRoot }, async ({ port, fake }) => {
      const first = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });
      expect(first.status).toBe(200);
      expect(fake.calls()).toBe(1);
    });

    // A brand-new process on the SAME journal must not dispatch again.
    await withServer({ SANGFOR_JM_AGENT_JOURNAL_ROOT: journalRoot }, async ({ port, fake }) => {
      const replay = await call(port, REMOTE_BROWSER_JOB_PATH, {
        body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
      });
      expect(replay.status).toBe(200);
      expect(JSON.parse(replay.body)).toMatchObject({ status: 'INDETERMINATE' });
      expect(fake.calls()).toBe(0);
    });
  });

  it('serves multiple distinct valid receipts sequentially', async () => {
    await withServer({}, async ({ port, fake }) => {
      for (let index = 0; index < 3; index += 1) {
        const dispatch = signedDispatch();
        const response = await call(port, REMOTE_BROWSER_JOB_PATH, {
          body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
        });
        expect(response.status, `dispatch ${String(index)}`).toBe(200);
      }
      expect(fake.calls()).toBe(3);
    });
  });

  it('never leaks key, certificate or path bytes in any response', async () => {
    await withServer({}, async ({ port }) => {
      const bodies = [
        (await call(port, '/live')).body,
        (await call(port, '/ready')).body,
        (await call(port, REMOTE_BROWSER_JOB_PATH, { body: '{}' })).body,
        (await call(port, '/nope')).body,
      ].join('\n');

      expect(bodies).not.toContain('PRIVATE KEY');
      expect(bodies).not.toContain('BEGIN CERTIFICATE');
      expect(bodies).not.toContain(fixtureRoot());
    });
  });
});

describe('stale and revoked dynamic grant lifecycle', () => {
  it('starts, serves TLS /live, but reports /ready 503 and refuses jobs', async () => {
    const revokedPath = join(fixtureRoot(), 'revoked-snapshot.jws');
    writeFileSync(revokedPath, buildGrantSnapshot(signingMaterial(), { state: 'revoked' }));
    const stalePath = join(fixtureRoot(), 'stale-snapshot.jws');
    writeFileSync(stalePath, buildGrantSnapshot(signingMaterial(), {
      issuedAt: new Date(Date.now() - 1_800_000),
    }));

    for (const snapshot of [revokedPath, stalePath]) {
      await withServer({ SANGFOR_JM_AGENT_GRANT_SNAPSHOT_PATH: snapshot }, async ({ port, fake }) => {
        // The static gate did NOT fail: the process is up and /live answers.
        const live = await call(port, '/live');
        const ready = await call(port, '/ready');
        const dispatch = signedDispatch();
        const job = await call(port, REMOTE_BROWSER_JOB_PATH, {
          body: dispatch.body, receipt: dispatch.receipt,
        receiptId: dispatch.receiptId, jobId: dispatch.jobId,
        });

        expect(live.status, snapshot).toBe(200);
        expect(ready.status, snapshot).toBe(503);
        expect(JSON.parse(ready.body)).toMatchObject({
          checks: { grantSnapshot: { ok: false, reason: 'GRANT_SNAPSHOT_INVALID' } },
        });
        expect(job.status, snapshot).toBe(503);
        expect(fake.calls(), snapshot).toBe(0);
      });
    }
  });
});
