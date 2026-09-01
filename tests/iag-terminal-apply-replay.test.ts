import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  digestIagMutationAction,
  lookupIagRunStatus,
  parseIagMutationAction,
} from '../packages/sangfor-product-adapters/src/apply/index.js';
import {
  consumeIagMutationNonce,
  signIagMutationApproval,
} from '../packages/sangfor-operator/src/index.js';
import { resolveIagMutationActionAuthority } from '../packages/sangfor-competency/src/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  IAG_ORCHESTRATOR_NOW,
  IAG_ORDINARY_APPROVAL_SECRET,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iag-terminal-replay-'));
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

function request(fixture: Awaited<ReturnType<typeof iagOrchestratorFixture>>, approval: unknown, source = fixture.source) {
  return {
    actionSource: source, authorityRequest: fixture.authorityRequest,
    approval, ordinaryAuthorityRequired: true as const,
  };
}

function mint(fixture: Awaited<ReturnType<typeof iagOrchestratorFixture>>, nonce: string) {
  const fields = {
    approvedBy: 'operator-replay', changeTicketId: 'CHG-REPLAY', rollbackPlanId: 'RB-REPLAY',
    purpose: 'ordinary_change' as const, nonce, expiresAt: '2026-08-20T12:00:00.000Z',

  authorityEpoch: 0,};
  const action = fixture.action;
  const scope = {
    actionDigest: fixture.actionDigest, origin: action.target.origin,
    deviceIdentityDigest: action.target.deviceIdentityDigest,
    sessionId: action.target.sessionId, windowId: action.target.windowId,
  };
  return { ...fields, approvalToken: signIagMutationApproval(IAG_ORDINARY_APPROVAL_SECRET, scope, fields) };
}

async function successfulFixture() {
  const fixture = await iagOrchestratorFixture({ root, authorityKind: 'ordinary_active' });
  const first = await fixture.orchestrator.execute(request(fixture, fixture.approval));
  expect(first.outcome).toBe('SUCCEEDED');
  return fixture;
}

describe('terminal IAG apply replay authorization', () => {
  it('Given a successful terminal, When approval is missing, Then apply refuses instead of returning prior success', async () => {
    const fixture = await successfulFixture();

    const replay = await fixture.orchestrator.execute(request(fixture, undefined));

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_FIELDS_REQUIRED' });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });

  it('Given a successful terminal, When the consumed approval is replayed, Then apply returns APPROVAL_REPLAY', async () => {
    const fixture = await successfulFixture();

    const replay = await fixture.orchestrator.execute(request(fixture, fixture.approval));

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_REPLAY' });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given a successful terminal, When a fresh valid approval is supplied, Then status is required and its nonce stays fresh', async () => {
    const fixture = await successfulFixture();
    const fresh = mint(fixture, 'fresh-terminal-approval');

    const replay = await fixture.orchestrator.execute(request(fixture, fresh));

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'RUN_ALREADY_TERMINAL_USE_STATUS' });
    expect(lookupIagRunStatus(fixture.store, replay.runId)).toMatchObject({ outcome: 'SUCCEEDED', verifiedSuccess: true });
    await expect(consumeIagMutationNonce(fresh, IAG_ORCHESTRATOR_NOW)).resolves.toEqual({ ok: true });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given a changed action digest, When the old approval is supplied, Then signature binding refuses before conflict truth leaks', async () => {
    const fixture = await successfulFixture();
    const resolved = await resolveIagMutationActionAuthority(fixture.authorityRequest);
    if (!resolved.ok) throw new TypeError(resolved.code);
    const changedValue = JSON.parse(fixture.source);
    changedValue.preState.observed = {
      kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value: 'qa.example.invalid', effect: 'ALLOW',
    };
    const changedSource = JSON.stringify(changedValue);
    const changed = parseIagMutationAction({ source: changedSource, authority: resolved.authority });
    if (!changed.ok) throw new TypeError(changed.refusal.code);
    expect(digestIagMutationAction(changed.value)).not.toBe(fixture.actionDigest);

    const replay = await fixture.orchestrator.execute(request(fixture, fixture.approval, changedSource));

    expect(replay).toMatchObject({ outcome: 'REFUSED', reasonCode: 'APPROVAL_SIGNATURE_REFUSED' });
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
  });

  it('Given a terminal run, When consumed approval replays concurrently, Then every replay is non-success with no extra work', async () => {
    const fixture = await successfulFixture();

    const results = await Promise.all([
      fixture.orchestrator.execute(request(fixture, fixture.approval)),
      fixture.orchestrator.execute(request(fixture, fixture.approval)),
    ]);

    expect(results.every(({ outcome, reasonCode }) => outcome === 'REFUSED' && reasonCode === 'APPROVAL_REPLAY')).toBe(true);
    expect(fixture.adapterFixture.dispatches).toHaveLength(1);
    expect(fixture.adapterFixture.readBacks).toHaveLength(1);
  });
});
