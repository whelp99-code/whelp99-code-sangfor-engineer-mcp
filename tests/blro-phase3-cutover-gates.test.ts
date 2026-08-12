import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from '../apps/control-tower/src/registry.js';
import { assertLocalApprovalAuthorityAllowed } from '../apps/control-tower/src/api.js';
import { AuditLedger } from '../packages/sangfor-hci-client/src/audit-ledger.js';
import { assertLocalRagAuthorityAllowed } from '../packages/sangfor-rag/src/index.js';
import { RunStore } from '../packages/sangfor-runs/src/run-store.js';

const previousAuthority = process.env.SANGFOR_BLRO_AUTHORITY_STORE;

afterEach(() => {
  if (previousAuthority === undefined) delete process.env.SANGFOR_BLRO_AUTHORITY_STORE;
  else process.env.SANGFOR_BLRO_AUTHORITY_STORE = previousAuthority;
});

describe('BLRO Phase 3 cutover gates', () => {
  it('refuses every superseded JM-local authority before it can write', () => {
    process.env.SANGFOR_BLRO_AUTHORITY_STORE = 'postgres';
    const root = mkdtempSync(join(tmpdir(), 'blro-cutover-'));
    try {
      expect(() => new Registry(join(root, 'registry'))).toThrow('JM_LOCAL_REGISTRY_SUPERSEDED');
      expect(() => new RunStore(join(root, 'runs'))).toThrow('JM_LOCAL_RUN_STORE_SUPERSEDED');
      expect(() => new AuditLedger({ dir: join(root, 'audit') })).toThrow('JM_LOCAL_AUDIT_SUPERSEDED');
      expect(() => assertLocalRagAuthorityAllowed()).toThrow('JM_LOCAL_RAG_INDEX_SUPERSEDED');
      expect(() => assertLocalApprovalAuthorityAllowed()).toThrow('JM_LOCAL_APPROVAL_SUPERSEDED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps legacy JM-local stores available before project cutover', () => {
    delete process.env.SANGFOR_BLRO_AUTHORITY_STORE;
    const root = mkdtempSync(join(tmpdir(), 'jm-before-cutover-'));
    try {
      expect(new Registry(join(root, 'registry'))).toBeDefined();
      expect(new RunStore(join(root, 'runs'))).toBeDefined();
      expect(new AuditLedger({ dir: join(root, 'audit') })).toBeDefined();
      expect(() => assertLocalRagAuthorityAllowed()).not.toThrow();
      expect(() => assertLocalApprovalAuthorityAllowed()).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
