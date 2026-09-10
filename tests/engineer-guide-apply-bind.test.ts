import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeEngineerGuideDigest } from '../packages/shared/src/engineer-guide-digest.js';
import type { EngineerGuide } from '../packages/shared/src/engineer-case-contract.js';
import {
  assertEngineerGuideApplyBinding,
  dryRunEngineerGuideApply,
  proposeEngineerGuideApply,
  type EngineerGuideApplyStepView,
} from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-bind.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'e13-guide-apply-'));
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

function guideOf(readiness: EngineerGuide['readiness'] = 'review_ready'): EngineerGuide {
  const withoutDigest = {
    revision: 'guide-e13-1',
    requirementRefs: ['req-url-exception'],
    steps: [{
      id: 'step-url-exception',
      order: 1,
      title: 'Add lab URL exception',
      requirementRefs: ['req-url-exception'],
      evidenceRefs: [],
      citations: [],
      verify: 'Independent IAG read-back of the exception',
      stop: 'Stop if pre-state drifts',
      recovery: 'Do not auto-rollback; replan',
    }],
    prerequisites: [],
    unresolved: [],
    readiness,
  } as const;
  return { ...withoutDigest, digest: computeEngineerGuideDigest(withoutDigest) };
}

const executableView: EngineerGuideApplyStepView = {
  stepId: 'step-url-exception',
  executable: true,
  support: 'executable',
};

function bindInput(
  fixture: { readonly action: Parameters<typeof proposeEngineerGuideApply>[0]['action'] },
  overrides: Partial<Parameters<typeof proposeEngineerGuideApply>[0]> = {},
): Parameters<typeof proposeEngineerGuideApply>[0] {
  return {
    guide: guideOf(),
    storedStepViews: [executableView],
    stepViews: [],
    stepId: 'step-url-exception',
    product: 'IAG',
    action: fixture.action,
    currentObserved: fixture.action.preState.observed,
    ...overrides,
  };
}

describe('engineer guide apply bind (E13)', () => {
  it('binds one review_ready IAG step and dry-runs without mutation or verified success', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const guide = guideOf();
    const proposed = proposeEngineerGuideApply(bindInput(fixture, { guide }));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const dryRun = await dryRunEngineerGuideApply({
      proposal: proposed.proposal,
      currentGuide: guide,
      currentObserved: fixture.action.preState.observed,
      storedStepViews: [executableView],
      stepViews: [],
      executor: fixture.adapterFixture.executor,
      authorityRequest: fixture.authorityRequest,
    });
    expect(dryRun).toMatchObject({
      ok: true,
      mutationAttempted: false,
      verifiedSuccess: false,
      httpSuccessIgnored: true,
      retry: false,
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
    if (dryRun.ok) {
      expect(dryRun.dryRun.outcome).toBe('DRY_RUN_COMPLETE');
      expect(dryRun.dryRun.verifiedSuccess).toBe(false);
    }
  });

  it('refuses HCI guide apply as unsupported', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const proposed = proposeEngineerGuideApply(bindInput(fixture, { product: 'HCI' }));
    expect(proposed).toMatchObject({
      ok: false, code: 'HCI_GUIDE_APPLY_UNSUPPORTED', mutationAttempted: false, retry: false,
    });
  });

  it('refuses a multi-step guide even if the caller marks one view executable', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const base = guideOf();
    const withoutDigest = {
      revision: base.revision,
      requirementRefs: base.requirementRefs,
      steps: [
        base.steps[0],
        {
          ...base.steps[0],
          id: 'step-other',
          order: 2,
          title: 'Another step',
        },
      ],
      prerequisites: base.prerequisites,
      unresolved: base.unresolved,
      readiness: base.readiness,
    } as const;
    const multi = { ...withoutDigest, digest: computeEngineerGuideDigest(withoutDigest) };
    expect(proposeEngineerGuideApply(bindInput(fixture, {
      guide: multi,
      storedStepViews: [
        executableView,
        { stepId: 'step-other', executable: true, support: 'executable' },
      ],
      stepViews: [
        executableView,
        { stepId: 'step-other', executable: true, support: 'executable' },
      ],
    }))).toMatchObject({ ok: false, code: 'SINGLE_GUIDE_STEP_REQUIRED', retry: false });
  });

  it('refuses a tampered proposal digest', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const guide = guideOf();
    const proposed = proposeEngineerGuideApply(bindInput(fixture, { guide }));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const tampered = assertEngineerGuideApplyBinding({
      proposal: { ...proposed.proposal, digest: 'c'.repeat(64) },
      currentGuide: guide,
      currentObserved: fixture.action.preState.observed,
    });
    expect(tampered).toMatchObject({ ok: false, code: 'PROPOSAL_TAMPERED', retry: false });
  });

  it('refuses a non-executable or draft guide', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    expect(proposeEngineerGuideApply(bindInput(fixture, {
      guide: guideOf('draft'),
    }))).toMatchObject({ ok: false, code: 'GUIDE_NOT_REVIEW_READY' });
    expect(proposeEngineerGuideApply(bindInput(fixture, {
      storedStepViews: [{ stepId: 'step-url-exception', executable: false, support: 'blocked' }],
      stepViews: [{ stepId: 'step-url-exception', executable: false, support: 'blocked' }],
    }))).toMatchObject({ ok: false, code: 'STEP_NOT_EXECUTABLE' });
  });

  it('refuses empty stepViews when the stored guide has no executable evidence', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    expect(proposeEngineerGuideApply({
      guide: guideOf(),
      storedStepViews: [],
      stepViews: [],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', mutationAttempted: false, retry: false,
    });
  });

  it('refuses caller-supplied executable views when the stored guide is not executable', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const blockedStored: EngineerGuideApplyStepView = {
      stepId: 'step-url-exception',
      executable: false,
      support: 'blocked',
    };
    expect(proposeEngineerGuideApply({
      guide: guideOf(),
      storedStepViews: [],
      stepViews: [executableView],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', mutationAttempted: false, retry: false,
    });
    expect(proposeEngineerGuideApply({
      guide: guideOf(),
      storedStepViews: [blockedStored],
      stepViews: [executableView],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', mutationAttempted: false, retry: false,
    });
  });

  it('derives executable from stored E07 step views, not from a hard-coded grant', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    expect(proposeEngineerGuideApply({
      guide: guideOf(),
      storedStepViews: [executableView],
      stepViews: [],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({ ok: true });
  });

  it('invalidates a stale guide digest and observed drift', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const guide = guideOf();
    const proposed = proposeEngineerGuideApply(bindInput(fixture, { guide }));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const stale = assertEngineerGuideApplyBinding({
      proposal: proposed.proposal,
      currentGuide: { ...guide, digest: 'b'.repeat(64) },
      currentObserved: fixture.action.preState.observed,
    });
    expect(stale).toMatchObject({ ok: false, code: 'STALE_GUIDE', retry: false });

    const drifted = assertEngineerGuideApplyBinding({
      proposal: proposed.proposal,
      currentGuide: guide,
      currentObserved: {
        kind: 'URL_DOMAIN_EXCEPTION_PRESENT',
        value: 'qa.example.invalid',
        effect: 'ALLOW',
      },
    });
    expect(drifted).toMatchObject({ ok: false, code: 'DRIFT_REQUIRES_REPLAN', retry: false });
  });

  it('does not retry when pre-state is indeterminate', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const proposed = proposeEngineerGuideApply(bindInput(fixture, {
      currentObserved: { kind: 'UNAVAILABLE', reasonCode: 'READ_BACK_INDETERMINATE' },
    }));
    expect(proposed).toMatchObject({
      ok: false, code: 'PRESTATE_INDETERMINATE', mutationAttempted: false, retry: false,
    });
  });

  it('refuses a live (non-dry-run) action even if execution env is set', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: false });
    expect(process.env.SANGFOR_ALLOW_REAL_EXECUTION).toBe('true');
    const proposed = proposeEngineerGuideApply(bindInput(fixture));
    expect(proposed).toMatchObject({
      ok: false, code: 'IAG_DRY_RUN_ACTION_REQUIRED', mutationAttempted: false,
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });
});
