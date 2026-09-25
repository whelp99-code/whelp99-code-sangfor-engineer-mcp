import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeEngineerGuideBoundDryRun } from '../apps/mcp-server/src/engineer-guide-bound-dry-run.js';
import { buildEngineerGuide, type EngineerGuideStepView } from '../packages/sangfor-planner/src/engineer-guide.js';
import { proposeEngineerGuideApply } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-bind.js';
import {
  mapEngineerGuideStepViewToStored,
  toEngineerGuideApplyFile,
  writeEngineerGuideApplyFile,
} from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-file.js';
import { persistEngineerCaseAndGuideApplyFile } from '../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-persist.js';
import { BlroAuthorityStore } from '../packages/sangfor-authority/src/authority-store.js';
import {
  ENGINEER_CASE_READ_PERMISSION,
  ENGINEER_CASE_WRITE_PERMISSION,
} from '../packages/sangfor-authority/src/authority-store-contracts.js';
import { prepareEngineerCaseForPersistence } from '../packages/sangfor-authority/src/engineer-case-persistence.js';
import {
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerCaseDocument,
  type EngineerGuide,
} from '../packages/shared/src/engineer-case-contract.js';
import { evaluateEngineerFieldAcceptance } from '../packages/shared/src/engineer-field-acceptance.js';
import { computeEngineerGuideDigest } from '../packages/shared/src/engineer-guide-digest.js';
import { FakeEngineerCaseAuthorityDatabase } from './helpers/engineer-case-authority-db.js';
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

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const CASE_DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';

function iagCaseDocument(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  const incomingGuide = {
    revision: 'guide-rev-1',
    digest: CASE_DIGEST,
    requirementRefs: ['req-url-exception'],
    steps: [],
    prerequisites: [],
    unresolved: [],
    readiness: 'review_ready' as const,
  };
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-iag-1',
    mode: 'existing',
    product: 'IAG',
    revision: 'rev-1',
    progress: 'assessment_ready',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [{
      id: 'obs-url-exception',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-1',
      value: { presence: 'known', data: { kind: 'string', text: 'qa.example.invalid' } },
    }],
    requirements: [{
      id: 'req-url-exception',
      sourceKind: 'provided',
      sourceRef: 'excel-row-1',
      target: 'URL exception',
      constraint: 'allow qa.example.invalid',
      priority: 'high',
      confirmationState: 'confirmed',
      acceptanceCriterion: 'URL exception is present',
      revision: 'req-rev-1',
    }],
    calculations: [],
    assessments: [{
      id: 'assess-url-exception',
      requirementRef: 'req-url-exception',
      currentRef: 'obs-url-exception',
      calculationRefs: [],
      status: 'satisfied',
      reasons: ['provided observation matches acceptance'],
      nextAction: 'none',
    }],
    guide: incomingGuide,
    evidence: [{
      id: 'ev-1',
      digest: CASE_DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
    ...overrides,
  } as EngineerCaseDocument;
}

function persistStore(): BlroAuthorityStore {
  const db = new FakeEngineerCaseAuthorityDatabase();
  db.grant(AUTH, [ENGINEER_CASE_READ_PERMISSION, ENGINEER_CASE_WRITE_PERMISSION]);
  return new BlroAuthorityStore(db);
}

describe('engineer case persist adjacent guide apply export', () => {
  it('persists an E07-built IAG case and emits an envelope bind/MCP can read as stored executable', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    delete process.env.SANGFOR_ALLOW_REAL_EXECUTION;
    delete process.env.SANGFOR_ALLOW_PRODUCTION_EXECUTION;
    const built = buildEngineerGuide({
      document: iagCaseDocument(),
      auth: AUTH,
      caseRevision: 'rev-1',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.stepViews).toHaveLength(1);
    expect(built.stepViews[0]?.executable).toBe(true);
    expect(built.guide.readiness).toBe('review_ready');
    expect(built.guide.steps).toHaveLength(1);

    const store = persistStore();
    const outputPath = join(root, 'persisted-guide.json');
    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.saveEngineerCase(request),
      save: { auth: AUTH, document: built.document, requestId: 'req-persist-e07' },
      outputPath,
      derive: ({ document, auth }) => {
        const again = buildEngineerGuide({ document, auth, caseRevision: document.revision });
        if (!again.ok) return undefined;
        return { guide: again.guide, stepViews: again.stepViews };
      },
    });
    expect(saved.persist).toMatchObject({
      ok: true, guideReadyGranted: false, executionPassGranted: false, approved: false,
    });
    expect(saved.applyFileOmitted).toBeUndefined();
    expect(saved.applyFile).toEqual({
      product: 'IAG',
      guide: built.guide,
      stepViews: [{
        stepId: built.stepViews[0]?.step.id,
        executable: true,
        support: 'executable',
      }],
    });

    const prepared = prepareEngineerCaseForPersistence(built.document, AUTH);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('expected remapped persistable guide');
    const storedGuide = prepared.value.value.guide;
    const { digest, ...fields } = storedGuide;
    expect(storedGuide.readiness).toBe('draft');
    expect(storedGuide.readiness).not.toBe('review_ready');
    expect(digest).toBe(computeEngineerGuideDigest(fields));
    expect(JSON.stringify(prepared.value.value.guide)).not.toContain('stepViews');

    const loaded = await store.loadEngineerCase({ ...AUTH, caseId: 'case-iag-1' });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('expected load');
    const loadedGuide = (loaded.document as EngineerCaseDocument).guide;
    expect(loadedGuide).not.toHaveProperty('stepViews');
    expect(loadedGuide.readiness).toBe('draft');
    expect(loaded.guideReadyGranted).toBe(false);
    expect(loaded.executionPassGranted).toBe(false);

    const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      readonly product: string;
      readonly stepViews: readonly { readonly executable: boolean }[];
    };
    expect(parsed.product).toBe('IAG');
    expect(parsed.stepViews[0]?.executable).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/field_accepted|fieldAccepted|sangfor_engineer_guide_apply/);

    const proposed = proposeEngineerGuideApply({
      guide: built.guide,
      storedStepViews: saved.applyFile?.stepViews ?? [],
      stepViews: [],
      stepId: built.guide.steps[0]!.id,
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    });
    expect(proposed).toMatchObject({ ok: true });

    const dryRun = await executeEngineerGuideBoundDryRun({
      actionSource: fixture.source,
      guideRaw: JSON.parse(readFileSync(outputPath, 'utf8')),
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

  it('persists a case with no E07 step views without writing a grant envelope', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const store = persistStore();
    const outputPath = join(root, 'no-views-guide.json');
    const document = iagCaseDocument({ assessments: [] });
    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.saveEngineerCase(request),
      save: { auth: AUTH, document, requestId: 'req-no-views' },
      outputPath,
      derive: ({ document: parsed, auth }) => {
        const built = buildEngineerGuide({ document: parsed, auth, caseRevision: parsed.revision });
        if (!built.ok || built.stepViews.length === 0) return undefined;
        return { guide: built.guide, stepViews: built.stepViews };
      },
    });
    expect(saved.persist.ok).toBe(true);
    expect(saved.applyFile).toBeUndefined();
    expect(saved.applyFileOmitted).toBe('missing_step_views');
    expect(existsSync(outputPath)).toBe(false);

    const dryRun = await executeEngineerGuideBoundDryRun({
      actionSource: fixture.source,
      guideRaw: guideOf(),
      observedRaw: fixture.action.preState.observed,
      executor: fixture.adapterFixture.executor,
      authorityRequest: fixture.authorityRequest,
    });
    expect(dryRun).toMatchObject({
      ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false, mutationAttempted: false, verifiedSuccess: false,
    });
    expect(fixture.adapterFixture.dispatches).toHaveLength(0);
  });

  it('stores executable:false from E07 and refuses bind', async () => {
    const fixture = await iagOrchestratorFixture({ root, dryRun: true });
    const built = buildEngineerGuide({
      document: iagCaseDocument({
        assessments: [{
          id: 'assess-url-exception',
          requirementRef: 'req-url-exception',
          currentRef: 'obs-url-exception',
          calculationRefs: [],
          status: 'unresolved',
          reasons: ['URL exception is not confirmed on device'],
          nextAction: 'recollect',
        }],
        guide: {
          revision: 'guide-rev-1',
          digest: CASE_DIGEST,
          requirementRefs: ['req-url-exception'],
          steps: [],
          prerequisites: [],
          unresolved: ['URL exception is not confirmed on device'],
          readiness: 'review_ready',
        },
      }),
      auth: AUTH,
      caseRevision: 'rev-1',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.stepViews[0]?.executable).toBe(false);

    const store = persistStore();
    const outputPath = join(root, 'blocked-persist-guide.json');
    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.saveEngineerCase(request),
      save: { auth: AUTH, document: built.document, requestId: 'req-blocked' },
      outputPath,
      derive: ({ document, auth }) => {
        const again = buildEngineerGuide({ document, auth, caseRevision: document.revision });
        if (!again.ok) return undefined;
        return { guide: again.guide, stepViews: again.stepViews };
      },
    });
    expect(saved.persist.ok).toBe(true);
    expect(saved.applyFile?.stepViews[0]).toEqual({
      stepId: built.stepViews[0]?.step.id,
      executable: false,
      support: 'blocked',
    });
    const reviewReadyFields = {
      revision: built.guide.revision,
      requirementRefs: built.guide.requirementRefs,
      steps: built.guide.steps,
      prerequisites: built.guide.prerequisites,
      unresolved: [] as const,
      readiness: 'review_ready' as const,
    };
    expect(proposeEngineerGuideApply({
      guide: { ...reviewReadyFields, digest: computeEngineerGuideDigest(reviewReadyFields) },
      storedStepViews: saved.applyFile?.stepViews ?? [],
      stepViews: [],
      stepId: built.stepViews[0]?.step.id ?? 's-req-url-exception',
      product: 'IAG',
      action: fixture.action,
      currentObserved: fixture.action.preState.observed,
    })).toMatchObject({ ok: false, code: 'STEP_NOT_EXECUTABLE', retry: false });
  });

  it('omits an IAG-looking envelope when product is not evidenced IAG or HCI', async () => {
    const store = persistStore();
    const built = buildEngineerGuide({
      document: iagCaseDocument({ product: 'NGFW' }),
      auth: AUTH,
      caseRevision: 'rev-1',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    const outputPath = join(root, 'unknown-product-guide.json');
    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.saveEngineerCase(request),
      save: { auth: AUTH, document: built.document, requestId: 'req-ngfw' },
      outputPath,
      derive: ({ document, auth }) => {
        const again = buildEngineerGuide({ document, auth, caseRevision: document.revision });
        if (!again.ok) return undefined;
        return { guide: again.guide, stepViews: again.stepViews };
      },
    });
    expect(saved.persist.ok).toBe(true);
    expect(saved.applyFile).toBeUndefined();
    expect(saved.applyFileOmitted).toBe('unknown_product');
    expect(saved.unresolved).toBe('GUIDE_APPLY_PRODUCT_UNRESOLVED');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('refuses forged caller stepViews and does not write a grant envelope', async () => {
    const store = persistStore();
    const outputPath = join(root, 'forged-guide.json');
    const document = iagCaseDocument({
      assessments: [{
        id: 'assess-url-exception',
        requirementRef: 'req-url-exception',
        currentRef: 'obs-url-exception',
        calculationRefs: [],
        status: 'unresolved',
        reasons: ['URL exception is not confirmed on device'],
        nextAction: 'recollect',
      }],
    });
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.stepViews[0]?.executable).toBe(false);

    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.saveEngineerCase(request),
      save: { auth: AUTH, document, requestId: 'req-forged-views' },
      outputPath,
      stepViews: [{
        step: { id: built.stepViews[0]?.step.id ?? 's-req-url-exception' },
        executable: true,
        support: 'executable',
      }],
      derive: ({ document: parsed, auth }) => {
        const again = buildEngineerGuide({ document: parsed, auth, caseRevision: parsed.revision });
        if (!again.ok) return undefined;
        return { guide: again.guide, stepViews: again.stepViews };
      },
    });
    expect(saved.persist.ok).toBe(true);
    expect(saved.applyFile).toBeUndefined();
    expect(saved.applyFileOmitted).toBe('forged_step_views');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('omits caller-only stepViews when E07 views cannot be derived', async () => {
    const store = persistStore();
    const outputPath = join(root, 'caller-only-guide.json');
    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.saveEngineerCase(request),
      save: { auth: AUTH, document: iagCaseDocument(), requestId: 'req-caller-only' },
      outputPath,
      stepViews: [e07StepView({ executable: true, support: 'executable' })],
    });
    expect(saved.persist.ok).toBe(true);
    expect(saved.applyFile).toBeUndefined();
    expect(saved.applyFileOmitted).toBe('missing_step_views');
    expect(existsSync(outputPath)).toBe(false);
  });
});
