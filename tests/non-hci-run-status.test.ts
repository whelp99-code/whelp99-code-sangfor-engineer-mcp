import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lookupIagRunStatus } from '../packages/sangfor-product-adapters/src/apply/index.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'non-hci-status-'));
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

describe('non-HCI authenticated run status', () => {
  it('Given a committed run, When status is looked up repeatedly, Then terminal truth is stable and no action is dispatched', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const terminal = await fixture.orchestrator.execute({
      actionSource: fixture.source, authorityRequest: fixture.authorityRequest,
    });
    const dispatchCount = fixture.adapterFixture.dispatches.length;

    const first = lookupIagRunStatus(fixture.store, terminal.runId);
    const second = lookupIagRunStatus(fixture.store, terminal.runId);

    expect(first).toEqual(terminal);
    expect(second).toEqual(first);
    expect(fixture.adapterFixture.dispatches).toHaveLength(dispatchCount);
  });

  it('Given an unknown run id, When status is looked up, Then it typed-refuses without creating a run', async () => {
    const fixture = await iagOrchestratorFixture({ root });

    expect(() => lookupIagRunStatus(fixture.store, 'a'.repeat(64))).toThrow('IAG_RUN_NOT_FOUND');
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });
});
