import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeEngineerGuideBoundDryRun } from '../apps/mcp-server/src/engineer-guide-bound-dry-run.js';
import type { EngineerGuideStepView } from '../packages/sangfor-planner/src/engineer-guide.js';
import { proposeEngineerGuideApply } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-bind.js';
import {
  mapEngineerGuideStepViewToStored,
  toEngineerGuideApplyFile,
  writeEngineerGuideApplyFile,
} from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-file.js';
import type { EngineerGuide } from '../packages/shared/src/engineer-case-contract.js';
import { evaluateEngineerFieldAcceptance } from '../packages/shared/src/engineer-field-acceptance.js';
import { computeEngineerGuideDigest } from '../packages/shared/src/engineer-guide-digest.js';
import { cleanupTestIagMutationAuthorityEnvironment } from './helpers/iag-mutation-contract-fixture.js';
import {
  configureIagOrchestratorTestEnvironment,
  iagOrchestratorFixture,
} from './helpers/iag-orchestrator-fixture.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'e13-guide-apply-file-'));
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

function e07StepView(input: {
  readonly executable: boolean;
  readonly support: EngineerGuideStepView['support'];
}): EngineerGuideStepView {
  const step = guideOf().steps[0];
  if (step === undefined) throw new Error('E13_TEST_GUIDE_STEP_MISSING');
  return {
    step,
    support: input.support,
    executable: input.executable,
    reasons: ['E07_COMPUTED_VIEW', 'extras-must-not-become-grants'],
    target: 'URL exception',
    prerequisites: ['product:IAG', 'firmware:unknown'],
    currentSourceKind: 'observed',
    proposedSourceKind: 'proposed',
    settingPath: {
      kind: input.executable ? 'verified_verify' : 'none',
      evidence: input.executable
        ? 'bound case evidence and verify-only instruction; not a mutation path'
        : 'no verified configure path in-repo',
    },
  };
}

describe('engineer guide apply file persist (E13 leftover)', () => {
  it('maps a real E07 step view to stored executable fields only', () => {
    const view = e07StepView({ executable: true, support: 'executable' });
    const stored = mapEngineerGuideStepViewToStored(view);
    expect(stored).toEqual({
      stepId: 'step-url-exception',
      executable: true,
      support: 'executable',
    });
    expect(stored).not.toHaveProperty('reasons');
    expect(stored).not.toHaveProperty('settingPath');
    expect(stored).not.toHaveProperty('step');
  });

  it('persists a full E07 step view as a reduced envelope the bind can read', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const guide = guideOf();
    const view = e07StepView({ executable: true, support: 'executable' });
    const path = join(root, 'guide.json');
    const written = writeEngineerGuideApplyFile({
      outputPath: path,
      product: 'IAG',
      guide,
      stepViews: [view],
    });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      readonly product: string;
      readonly guide: EngineerGuide;
      readonly stepViews: readonly Record<string, unknown>[];
    };

    expect(written).toEqual({ product: 'IAG', guide, stepViews: [{
      stepId: 'step-url-exception', executable: true, support: 'executable',
    }] });
    expect(parsed.stepViews).toEqual(written.stepViews);
    expect(Object.keys(parsed.stepViews[0] ?? {}).sort()).toEqual(['executable', 'stepId', 'support']);
    expect(JSON.stringify(parsed)).not.toMatch(/field_accepted|fieldAccepted/);

    const proposed = proposeEngineerGuideApply({
      guide,
      storedStepViews: written.stepViews,
      stepViews: [],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    });
    expect(proposed).toMatchObject({ ok: true });

    const dryRun = await executeEngineerGuideBoundDryRun({
      actionSource: fixture.source,
      guideRaw: parsed,
      observedRaw: fixture.action.preState.observed,
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
    expect(evaluateEngineerFieldAcceptance({
      environmentKind: 'fixture',
      synthetic: true,
      guideReadiness: 'review_ready',
      claimedFieldAccepted: true,
    })).toMatchObject({ fieldAccepted: false, grantPath: 'none' });
  });

  it('refuses a bare persisted guide without stepViews', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const guide = guideOf();
    const dryRun = await executeEngineerGuideBoundDryRun({
      actionSource: fixture.source,
      guideRaw: guide,
      observedRaw: fixture.action.preState.observed,
      executor: fixture.adapterFixture.executor,
      authorityRequest: fixture.authorityRequest,
    });
    expect(dryRun).toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false, mutationAttempted: false, verifiedSuccess: false,
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('maps extras away so a full EngineerGuideStepView does not fail the writer', () => {
    const view = e07StepView({ executable: true, support: 'executable' });
    const file = toEngineerGuideApplyFile({
      product: 'IAG',
      guide: guideOf(),
      stepViews: [view],
    });
    expect(file.stepViews[0]).toEqual({
      stepId: 'step-url-exception',
      executable: true,
      support: 'executable',
    });
    expect(JSON.stringify(file.stepViews)).not.toContain('E07_COMPUTED_VIEW');
    expect(JSON.stringify(file.stepViews)).not.toContain('settingPath');
  });

  it('does not let caller stepViews grant over a stored blocked E07 view', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const written = writeEngineerGuideApplyFile({
      outputPath: join(root, 'blocked-guide.json'),
      product: 'IAG',
      guide: guideOf(),
      stepViews: [e07StepView({ executable: false, support: 'blocked' })],
    });
    expect(written.stepViews[0]).toEqual({
      stepId: 'step-url-exception',
      executable: false,
      support: 'blocked',
    });
    expect(proposeEngineerGuideApply({
      guide: guideOf(),
      storedStepViews: written.stepViews,
      stepViews: [{ stepId: 'step-url-exception', executable: true, support: 'executable' }],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false, mutationAttempted: false,
    });
  });

  it('copies executable:false from the E07 view and never hard-codes true', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const view = e07StepView({ executable: false, support: 'unsupported' });
    expect(mapEngineerGuideStepViewToStored(view).executable).toBe(false);
    const written = writeEngineerGuideApplyFile({
      outputPath: join(root, 'false-guide.json'),
      product: 'IAG',
      guide: guideOf(),
      stepViews: [view],
    });
    const parsed = JSON.parse(readFileSync(join(root, 'false-guide.json'), 'utf8')) as {
      readonly stepViews: readonly { readonly executable: boolean }[];
    };
    expect(parsed.stepViews[0]?.executable).toBe(false);
    expect(proposeEngineerGuideApply({
      guide: guideOf(),
      storedStepViews: written.stepViews,
      stepViews: [],
      stepId: 'step-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({ ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false });
  });

  it('does not emit field_accepted from the persist path and does not write an apply tool file', () => {
    const path = join(root, 'guide.json');
    const written = writeEngineerGuideApplyFile({
      outputPath: path,
      product: 'IAG',
      guide: guideOf(),
      stepViews: [e07StepView({ executable: true, support: 'executable' })],
    });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toMatch(/field_accepted|fieldAccepted|sangfor_engineer_guide_apply/);
    expect(JSON.stringify(written)).not.toMatch(/field_accepted|fieldAccepted/);
    writeFileSync(join(root, 'bare-guide.json'), JSON.stringify(guideOf()));
    expect(readFileSync(join(root, 'bare-guide.json'), 'utf8')).not.toContain('stepViews');
  });
});
