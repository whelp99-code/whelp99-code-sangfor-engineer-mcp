import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIagOrchestrator,
  type IagExecutor,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import { consumeIagMutationNonce } from '../packages/sangfor-operator/src/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_NOW,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';
import { changedTerminalReplaySource } from './helpers/iag-terminal-replay-fixture.js';

type Fixture = Awaited<ReturnType<typeof iagOrchestratorFixture>>;
type EvidenceCase =
  | 'altered_digest' | 'wrong_origin' | 'wrong_device' | 'stale_evidence'
  | 'expired_approval' | 'missing_nonce';
type StoreCase =
  | 'missing_authority' | 'corrupt_authority' | 'corrupt_nonce'
  | 'missing_ledger' | 'corrupt_ledger' | 'missing_checkpoint' | 'corrupt_checkpoint';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iag-negative-evidence-'));
  configureIagOrchestratorTestEnvironment(root);
});

afterEach(() => {
  cleanupTestIagMutationAuthorityEnvironment();
  for (const key of [
    'SANGFOR_ALLOW_REAL_EXECUTION', 'SANGFOR_ALLOW_PRODUCTION_EXECUTION',
    'SANGFOR_IAG_BOOTSTRAP_APPROVAL_SECRET', 'SANGFOR_OPERATOR_APPROVAL_SECRET',
    'SANGFOR_NONCE_STORE', 'SANGFOR_NONCE_STORE_PATH',
  ]) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

function baseRequest(fixture: Fixture) {
  return {
    actionSource: fixture.source,
    authorityRequest: fixture.authorityRequest,
    approval: fixture.approval,
  };
}

function ordinaryRequest(fixture: Fixture) {
  return { ...baseRequest(fixture), ordinaryAuthorityRequired: true as const };
}

function evidenceRequest(fixture: Fixture, kind: EvidenceCase) {
  const request = ordinaryRequest(fixture);
  switch (kind) {
    case 'altered_digest':
      return { ...request, actionSource: changedTerminalReplaySource(fixture) };
    case 'wrong_origin':
      return { ...request, authorityRequest: { ...request.authorityRequest, origin: 'https://192.0.2.99' } };
    case 'wrong_device':
      return { ...request, actionSource: request.actionSource.replace(fixture.action.target.deviceIdentityDigest, '9'.repeat(64)) };
    case 'stale_evidence':
      return { ...request, authorityRequest: { ...request.authorityRequest, now: new Date('2027-08-20T11:01:00.000Z') } };
    case 'expired_approval':
      return { ...request, approval: { ...fixture.approval, expiresAt: '2026-08-20T10:00:00.000Z' } };
    case 'missing_nonce': {
      const approval = { ...fixture.approval };
      Reflect.deleteProperty(approval, 'nonce');
      return { ...request, approval };
    }
    default:
      kind satisfies never;
      return request;
  }
}

function corruptStore(fixture: Fixture, kind: StoreCase): void {
  switch (kind) {
    case 'missing_authority':
      unlinkSync(fixture.authorityRequest.references.manifestPath);
      return;
    case 'corrupt_authority':
      writeFileSync(fixture.authorityRequest.references.validationContextPath, '{');
      return;
    case 'corrupt_nonce':
      writeFileSync(join(root, 'nonces.json'), '{');
      return;
    case 'missing_ledger':
      unlinkSync(fixture.ledgerPath);
      return;
    case 'corrupt_ledger':
      writeFileSync(fixture.ledgerPath, '{');
      return;
    case 'missing_checkpoint':
      unlinkSync(`${fixture.ledgerPath}.head.json`);
      return;
    case 'corrupt_checkpoint':
      writeFileSync(`${fixture.ledgerPath}.head.json`, '{');
      return;
    default:
      kind satisfies never;
  }
}

describe('Todo 17 IAG negative evidence table', () => {
  it.each([
    ['altered_digest', 'APPROVAL_SIGNATURE_REFUSED'],
    ['wrong_origin', 'IAG_MUTATION_AUTHORITY_REFUSED'],
    ['wrong_device', 'ACTION_AUTHORITY_REFUSED'],
    ['stale_evidence', 'ACTION_AUTHORITY_REFUSED'],
    ['expired_approval', 'APPROVAL_EXPIRED'],
    ['missing_nonce', 'APPROVAL_FIELDS_REQUIRED'],
  ] as const)('Given %s evidence, When apply is requested, Then it REFUSES before mutation', async (kind, reasonCode) => {
    const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });

    const result = await fixture.orchestrator.execute(evidenceRequest(fixture, kind));

    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode, mutationAttempted: false, retryCount: 0, promotionEligible: false });
    expect(fixture.adapterFixture.preflights).toHaveLength(0);
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(fixture.adapterFixture.readBacks).toHaveLength(0);
  });

  it('Given failed preflight, When apply halts, Then approval remains unconsumed and no mutation work starts', async () => {
    const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });
    const base = fixture.adapterFixture.executor;
    const executor: IagExecutor = {
      ...base,
      async preflight(action) {
        const observed = await base.preflight(action);
        return { ...observed, status: 'UNREADY', reasonCode: 'PREFLIGHT_EVIDENCE_REFUSED' };
      },
    };
    const orchestrator = createIagOrchestrator({ executor, store: fixture.store, now: () => IAG_ORCHESTRATOR_NOW });

    const result = await orchestrator.execute(ordinaryRequest(fixture));

    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'PREFLIGHT_EVIDENCE_REFUSED', mutationAttempted: false });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(fixture.adapterFixture.readBacks).toHaveLength(0);
    await expect(consumeIagMutationNonce(fixture.approval, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
  });

  it.each([
    ['missing_authority', 'REFUSED'],
    ['corrupt_authority', 'REFUSED'],
    ['corrupt_nonce', 'REFUSED'],
  ] as const)('Given %s state, When apply runs, Then it fails closed without dispatch', async (kind, outcome) => {
    const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });
    corruptStore(fixture, kind);

    const result = await fixture.orchestrator.execute(ordinaryRequest(fixture));

    expect(result).toMatchObject({ outcome, mutationAttempted: false, retryCount: 0, promotionEligible: false });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    expect(fixture.adapterFixture.readBacks).toHaveLength(0);
  });

  it.each(['missing_ledger', 'corrupt_ledger', 'missing_checkpoint', 'corrupt_checkpoint'] as const)(
    'Given %s state, When apply runs, Then unavailable durable truth cannot dispatch or become terminal success',
    async (kind) => {
      const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });
      corruptStore(fixture, kind);

      await expect(fixture.orchestrator.execute(ordinaryRequest(fixture))).rejects.toThrow('IAG_ORCHESTRATOR_STORE_UNAVAILABLE');
      expect(fixture.adapterFixture.dispatches).toHaveLength(0);
      expect(fixture.adapterFixture.readBacks).toHaveLength(0);
    },
  );

  it('Given exact terminal and conflicting replay, When both are queried, Then truth is stable and conflict REFUSES', async () => {
    const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });
    const first = await fixture.orchestrator.execute(baseRequest(fixture));

    const exact = await fixture.orchestrator.execute(baseRequest(fixture));
    const conflict = await fixture.orchestrator.execute({
      ...baseRequest(fixture), actionSource: changedTerminalReplaySource(fixture),
    });

    expect(exact).toEqual(first);
    expect(conflict).toMatchObject({ outcome: 'REFUSED', mutationAttempted: false });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });
});
