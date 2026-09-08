import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyGrantSnapshot } from '../packages/sangfor-jm-agent/src/index.js';
import {
  JM_INSTALLATION_ID,
  JM_PROJECT_ID,
  JM_TENANT_ID,
  buildGrantSnapshot,
  createJmSigningMaterial,
  type JmSigningMaterial,
} from './helpers/jm-agent-fixture.js';

let root: string;
let signing: JmSigningMaterial;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'jm-agent-'));
  signing = createJmSigningMaterial(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('grant snapshot verification', () => {
  // Evaluated strictly after minting, so validity is decided by the fixture's
  // own offsets rather than by which side of a millisecond boundary we land on.
  const now = new Date(Date.now() + 1_000);
  const expected = {
    tenantId: JM_TENANT_ID, projectId: JM_PROJECT_ID, installationId: JM_INSTALLATION_ID,
  };

  it('accepts a signed active snapshot and reports revoked/expired distinctly', () => {
    const cases = [
      { snapshot: buildGrantSnapshot(signing), ok: true, reason: undefined },
      {
        snapshot: buildGrantSnapshot(signing, { state: 'revoked' }),
        ok: false, reason: 'SNAPSHOT_ENROLLMENT_REVOKED',
      },
      {
        snapshot: buildGrantSnapshot(signing, {
          issuedAt: new Date(now.getTime() - 7_200_000),
          expiresAt: new Date(now.getTime() - 3_600_000),
        }),
        ok: false, reason: 'SNAPSHOT_EXPIRED',
      },
      {
        snapshot: buildGrantSnapshot(signing, { privateKey: signing.foreignPrivateKey }),
        ok: false, reason: 'SNAPSHOT_SIGNATURE_INVALID',
      },
    ];

    for (const testCase of cases) {
      const decision = verifyGrantSnapshot({
        snapshot: testCase.snapshot,
        publicKeyPem: signing.currentPublicKeyPem,
        expected,
        now,
      });
      expect(decision.ok, testCase.reason ?? 'active').toBe(testCase.ok);
      if (!decision.ok && testCase.reason) expect(decision.reason).toBe(testCase.reason);
    }
  });
});
