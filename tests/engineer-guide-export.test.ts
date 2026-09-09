import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessEngineerCase,
  assembleEngineerCase,
  buildEngineerGuide,
  computeEngineerGuideDigest,
} from '../packages/sangfor-planner/src/index.js';
import {
  exportEngineerGuide,
  formatStoredEngineerValue,
} from '../packages/sangfor-product-adapters/src/engineer-guide-export.js';
import {
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerAssessment,
  type EngineerCaseDocument,
  type EngineerObservation,
  type EngineerValue,
} from '../packages/shared/src/engineer-case-contract.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const OWNER = { tenantId: AUTH.tenantId, projectId: AUTH.projectId, caseId: 'case-existing-1' } as const;

function observation(partial: EngineerObservation): EngineerObservation {
  return partial;
}

function remainingRequirement() {
  return {
    id: 'req-remaining',
    sourceKind: 'provided' as const,
    sourceRef: 'excel-row-1',
    target: 'Usable remaining',
    constraint: 'remaining >= 20 GiB',
    priority: 'high' as const,
    confirmationState: 'confirmed' as const,
    acceptanceCriterion: 'remaining >= 20 GiB',
    revision: 'req-rev-1',
  };
}

function haRequirement() {
  return {
    id: 'req-ha',
    sourceKind: 'provided' as const,
    sourceRef: 'excel-row-2',
    target: 'HA',
    constraint: 'HA enabled',
    priority: 'high' as const,
    confirmationState: 'confirmed' as const,
    acceptanceCriterion: 'HA enabled',
    revision: 'req-rev-1',
  };
}

function cpuRequirement() {
  return {
    id: 'req-cpu',
    sourceKind: 'provided' as const,
    sourceRef: 'excel-row-3',
    target: 'Host CPU',
    constraint: 'host cpu >= 16 cores',
    priority: 'medium' as const,
    confirmationState: 'confirmed' as const,
    acceptanceCriterion: 'host cpu >= 16 cores',
    revision: 'req-rev-1',
  };
}

function providedCapacityObservations(): EngineerObservation[] {
  return [
    observation({
      id: 'obs-total',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-1',
      value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
    }),
    observation({
      id: 'obs-used',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-1',
      value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
    }),
    observation({
      id: 'obs-ha_status',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-1',
      value: { presence: 'known', data: { kind: 'boolean', boolean: true } },
    }),
    observation({
      id: 'obs-fraction',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      evidenceRef: 'ev-1',
      value: { presence: 'known', data: { kind: 'number', number: 12.25, unit: 'GiB' } },
    }),
  ];
}

function emptyGuide() {
  return {
    revision: 'guide-rev-1',
    digest: DIGEST,
    requirementRefs: ['req-remaining', 'req-ha'],
    steps: [],
    prerequisites: [],
    unresolved: ['assessment not yet computed'],
    readiness: 'review_ready' as const,
  };
}

function validGuideCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    firmware: '6.7.0',
    revision: 'rev-1',
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: providedCapacityObservations(),
    requirements: [remainingRequirement(), haRequirement()],
    calculations: [],
    assessments: [],
    guide: emptyGuide(),
    evidence: [{
      id: 'ev-1',
      owner: OWNER,
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
    ...overrides,
  } as EngineerCaseDocument;
}

function remainingBinding() {
  return {
    requirementId: 'req-remaining',
    formulaId: 'confirmed-remaining-capacity' as const,
    formulaRoles: { total: 'obs-total', used: 'obs-used' },
    fitnessBaseline: { source: 'HCI sizing table 4', op: 'gte' as const, threshold: 20, unit: 'GiB' as const },
  };
}

function assessedGuideCase(overrides: Record<string, unknown> = {}) {
  const document = validGuideCase(overrides);
  const assessed = assessEngineerCase({
    document,
    auth: AUTH,
    caseRevision: document.revision,
    now: WHEN,
    bindings: document.requirements.some((item) => item.id === 'req-remaining') ? [remainingBinding()] : [],
  });
  expect(assessed.ok).toBe(true);
  if (!assessed.ok) throw new Error(assessed.message);
  expect(assessed.assembled.ok).toBe(true);
  if (!assessed.assembled.ok) throw new Error('assemble failed');
  return {
    assessed,
    document: {
      ...assessed.assembled.value,
      calculations: assessed.calculations,
      assessments: assessed.assessments,
    },
  };
}

function withOwnedGuide(document: EngineerCaseDocument): EngineerCaseDocument {
  return {
    ...document,
    evidence: document.evidence.map((item) => ({
      ...item,
      owner: item.owner ?? { tenantId: AUTH.tenantId, projectId: AUTH.projectId, caseId: document.caseId },
    })),
  };
}

function tempRoots(prefix: string): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)).sort();
}

function documentXml(absDocx: string): string {
  return execFileSync('unzip', ['-p', absDocx, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 10_000_000 });
}

describe('formatStoredEngineerValue', () => {
  it('prints stored numbers without extra rounding and keeps unknown unknown', () => {
    const known: EngineerValue = { presence: 'known', data: { kind: 'number', number: 12.25, unit: 'GiB' } };
    const unknown: EngineerValue = { presence: 'unknown', reason: 'host cpu was not collected' };
    expect(formatStoredEngineerValue(known)).toBe('12.25 GiB');
    expect(formatStoredEngineerValue(unknown)).toBe('unknown (host cpu was not collected)');
    expect(formatStoredEngineerValue(unknown)).not.toMatch(/^0\b/);
  });
});

describe('exportEngineerGuide', () => {
  let root: string;
  const previousRoot = process.env.SANGFOR_OUTPUT_ROOT;

  beforeEach(() => {
    root = join(tmpdir(), `e08-export-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(root, { recursive: true });
    process.env.SANGFOR_OUTPUT_ROOT = root;
  });

  afterEach(() => {
    if (previousRoot === undefined) delete process.env.SANGFOR_OUTPUT_ROOT;
    else process.env.SANGFOR_OUTPUT_ROOT = previousRoot;
  });

  it('copies guide numbers, requirement IDs, unresolved items, and revision into JSON and DOCX', async () => {
    const { document } = assessedGuideCase();
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.guide.readiness).toBe('review_ready');

    const exportable = withOwnedGuide({
      ...built.document,
      guide: built.guide,
    });
    const remaining = exportable.calculations.find((item) => item.formulaId === 'confirmed-remaining-capacity');
    expect(remaining?.result).toEqual({ presence: 'known', data: { kind: 'number', number: 60, unit: 'GiB' } });

    const result = await exportEngineerGuide({
      document: exportable,
      auth: AUTH,
      outputPath: 'case-existing-1-g-rev-1.docx',
      outputRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.recomputed).toBe(false);
    expect(result.fieldAccepted).toBe(false);
    expect(result.approvedForWindow).toBe(false);
    expect(result.guideRevision).toBe(built.guide.revision);
    expect(result.digest).toBe(built.guide.digest);
    expect(result.readiness).toBe('review_ready');
    expect(result.draftMarked).toBe(false);

    const docxAbs = join(root, result.docxPath);
    const jsonAbs = join(root, result.jsonPath);
    expect(existsSync(docxAbs)).toBe(true);
    expect(existsSync(jsonAbs)).toBe(true);
    expect(statSync(docxAbs).size).toBeGreaterThan(0);

    const xml = documentXml(docxAbs);
    expect(xml).toContain('1. 요약');
    expect(xml).toContain('2. 현재 구성');
    expect(xml).toContain('3. 계산과 가정');
    expect(xml).toContain('4. 요구사항별 차이');
    expect(xml).toContain('5. 작업 절차');
    expect(xml).toContain('6. 검증');
    expect(xml).toContain('7. 복구·중지');
    expect(xml).toContain('8. 미확인');
    expect(xml).toContain('9. 출처');
    expect(xml).toContain('10. 서명란');
    expect(xml).toContain('req-remaining');
    expect(xml).toContain('req-ha');
    expect(xml).toContain('60 GiB');
    expect(xml).toContain('12.25 GiB');
    expect(xml).toContain('100 GiB');
    expect(xml).toContain('40 GiB');
    expect(xml).not.toContain('60.00');
    expect(xml).not.toContain('12.3');
    expect(xml).toContain(built.guide.digest);
    expect(xml).toContain(built.guide.revision);
    expect(xml).toContain('review_ready');
    expect(xml).toContain('field_accepted');
    expect(xml).toContain('approved_for_window가 아닙니다');
    expect(xml).not.toContain('field_accepted=true');
    const styles = execFileSync('unzip', ['-p', docxAbs, 'word/styles.xml'], { encoding: 'utf8' });
    expect(styles).toContain('Malgun Gothic');

    const review = JSON.parse(readFileSync(jsonAbs, 'utf8')) as {
      digest: string;
      guideRevision: string;
      readiness: string;
      requirementIds: string[];
      unresolved: string[];
      values: Record<string, { value?: { number?: number; unit?: string } }>;
      acceptanceClaims: { field_accepted: boolean; approved_for_window: boolean; pm_accepted: boolean };
      recomputed: boolean;
    };
    expect(review.digest).toBe(built.guide.digest);
    expect(review.guideRevision).toBe(built.guide.revision);
    expect(review.readiness).toBe('review_ready');
    expect(review.requirementIds).toEqual(['req-remaining', 'req-ha']);
    expect(review.unresolved).toEqual(built.guide.unresolved);
    expect(review.values['obs-fraction']?.value?.number).toBe(12.25);
    expect(review.values[remaining?.id ?? '']?.value?.number).toBe(60);
    expect(review.acceptanceClaims).toEqual({
      documentReadiness: 'review_ready',
      field_accepted: false,
      approved_for_window: false,
      pm_accepted: false,
    });
    expect(review.recomputed).toBe(false);
    expect(result.validation.valid === true || result.validation.valid === null).toBe(true);
    if (result.validation.valid === null) {
      expect(result.officeCli.available === false || result.validation.code).toBeTruthy();
    }
  });

  it('prints 초안 when the supplied guide is draft or blocked and does not upgrade readiness', async () => {
    const { document } = assessedGuideCase({
      requirements: [remainingRequirement(), haRequirement(), cpuRequirement()],
      guide: { ...emptyGuide(), requirementRefs: ['req-remaining', 'req-ha', 'req-cpu'] },
    });
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    expect(built.guide.readiness).toBe('blocked');
    expect(built.assembled.ok).toBe(true);
    if (built.assembled.ok) {
      expect(built.assembled.value.guide.readiness).not.toBe('review_ready');
    }

    const assembled = assembleEngineerCase(withOwnedGuide({ ...built.document, guide: built.guide }), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error(assembled.issues[0]?.message ?? 'assemble failed');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).not.toBe('review_ready');

    const fromGuide = await exportEngineerGuide({
      document: withOwnedGuide({ ...built.document, guide: built.guide }),
      auth: AUTH,
      outputPath: 'blocked-guide.docx',
      outputRoot: root,
    });
    expect(fromGuide.ok).toBe(true);
    if (!fromGuide.ok) throw new Error(fromGuide.message);
    expect(fromGuide.readiness).toBe('blocked');
    expect(fromGuide.draftMarked).toBe(true);
    const blockedXml = documentXml(join(root, fromGuide.docxPath));
    expect(blockedXml).toContain('초안');
    expect(blockedXml).toContain('blocked');
    expect(blockedXml).toContain('req-cpu');
    expect(blockedXml).toMatch(/UNRESOLVED_ASSESSMENT:req-cpu|미확인/);

    const fromAssembled = await exportEngineerGuide({
      document: assembled.value,
      auth: AUTH,
      outputPath: 'assembled-draft.docx',
      outputRoot: root,
    });
    expect(fromAssembled.ok).toBe(true);
    if (!fromAssembled.ok) throw new Error(fromAssembled.message);
    expect(fromAssembled.readiness).toBe(assembled.value.guide.readiness);
    expect(fromAssembled.readiness).not.toBe('review_ready');
    expect(fromAssembled.draftMarked).toBe(true);
    expect(documentXml(join(root, fromAssembled.docxPath))).toContain('초안');
  });

  it('refuses path escape, filename collision, and missing ownership without leaving scratch', async () => {
    const { document } = assessedGuideCase();
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    const exportable = withOwnedGuide({ ...built.document, guide: built.guide });

    const before = new Set(tempRoots('engdocx-'));
    const escaped = await exportEngineerGuide({
      document: exportable,
      auth: AUTH,
      outputPath: '../../etc/evil.docx',
      outputRoot: root,
    });
    expect(escaped).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(tempRoots('engdocx-').filter((name) => !before.has(name))).toEqual([]);

    const first = await exportEngineerGuide({
      document: exportable,
      auth: AUTH,
      outputPath: 'same-name.docx',
      outputRoot: root,
    });
    expect(first.ok).toBe(true);
    const collision = await exportEngineerGuide({
      document: exportable,
      auth: AUTH,
      outputPath: 'same-name.docx',
      outputRoot: root,
    });
    expect(collision).toMatchObject({ ok: false, code: 'FILENAME_COLLISION' });

    writeFileSync(join(root, 'json-taken.review.json'), '{}\n');
    const jsonCollision = await exportEngineerGuide({
      document: exportable,
      auth: AUTH,
      outputPath: 'json-taken.docx',
      outputRoot: root,
    });
    expect(jsonCollision).toMatchObject({ ok: false, code: 'FILENAME_COLLISION' });
    expect(existsSync(join(root, 'json-taken.docx'))).toBe(false);

    const unowned = {
      ...exportable,
      evidence: exportable.evidence.map((item) => {
        const { owner: _owner, ...rest } = item;
        return rest;
      }),
    };
    const missingOwner = await exportEngineerGuide({
      document: unowned,
      auth: AUTH,
      outputPath: 'unowned.docx',
      outputRoot: root,
    });
    expect(missingOwner).toMatchObject({ ok: false, code: 'OWNERSHIP_METADATA_MISSING' });
  });

  it('refuses a missing requirement and a digest mismatch without rewriting readiness', async () => {
    const { document } = assessedGuideCase({
      requirements: [remainingRequirement(), haRequirement(), cpuRequirement()],
      guide: { ...emptyGuide(), requirementRefs: ['req-remaining', 'req-ha', 'req-cpu'] },
    });
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);

    const omitted = withOwnedGuide({
      ...built.document,
      guide: {
        ...built.guide,
        requirementRefs: built.guide.requirementRefs.filter((id) => id !== 'req-cpu'),
        digest: computeEngineerGuideDigest({
          revision: built.guide.revision,
          requirementRefs: built.guide.requirementRefs.filter((id) => id !== 'req-cpu'),
          steps: built.guide.steps,
          prerequisites: built.guide.prerequisites,
          unresolved: built.guide.unresolved,
          readiness: built.guide.readiness,
        }),
      },
    });
    const missing = await exportEngineerGuide({
      document: omitted,
      auth: AUTH,
      outputPath: 'missing-req.docx',
      outputRoot: root,
    });
    expect(missing).toMatchObject({ ok: false, code: 'MISSING_REQUIREMENT' });

    const tampered = withOwnedGuide({
      ...built.document,
      guide: { ...built.guide, digest: 'cd'.repeat(32) },
    });
    const mismatch = await exportEngineerGuide({
      document: tampered,
      auth: AUTH,
      outputPath: 'bad-digest.docx',
      outputRoot: root,
    });
    expect(mismatch).toMatchObject({ ok: false, code: 'GUIDE_DIGEST_MISMATCH' });
  });

  it('masks secret-shaped text and does not treat review_ready as field acceptance', async () => {
    const { document } = assessedGuideCase();
    const secretAssessment: EngineerAssessment = {
      id: 'assess-secret',
      requirementRef: 'req-ha',
      currentRef: 'obs-ha_status',
      calculationRefs: [],
      status: 'satisfied',
      reasons: ['password=historical-not-for-use'],
      nextAction: 'none',
    };
    const assessed = {
      ...document,
      assessments: document.assessments.map((item) => item.requirementRef === 'req-ha' ? secretAssessment : item),
    };
    const built = buildEngineerGuide({ document: assessed, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);

    const result = await exportEngineerGuide({
      document: withOwnedGuide({ ...built.document, guide: built.guide }),
      auth: AUTH,
      outputPath: 'masked.docx',
      outputRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const xml = documentXml(join(root, result.docxPath));
    const json = readFileSync(join(root, result.jsonPath), 'utf8');
    expect(xml).not.toContain('historical-not-for-use');
    expect(json).not.toContain('historical-not-for-use');
    expect(xml).toContain('password=***');
    expect(result.fieldAccepted).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/"fieldAccepted":true|"approvedForWindow":true/);
  });

  it('refuses a normal-looking Word export after collection failure', async () => {
    const { document } = assessedGuideCase();
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    const unresolved = [...built.guide.unresolved, 'collection failed; guide output is not a normal completion'];
    const fields = {
      revision: built.guide.revision,
      requirementRefs: built.guide.requirementRefs,
      steps: built.guide.steps,
      prerequisites: built.guide.prerequisites,
      unresolved,
      readiness: 'blocked' as const,
    };
    const result = await exportEngineerGuide({
      document: withOwnedGuide({
        ...built.document,
        progress: 'inputs_pending',
        guide: { ...fields, digest: computeEngineerGuideDigest(fields) },
      }),
      auth: AUTH,
      outputPath: 'collect-fail.docx',
      outputRoot: root,
    });
    expect(result).toMatchObject({ ok: false, code: 'COLLECTION_FAILED' });
    expect(existsSync(join(root, 'collect-fail.docx'))).toBe(false);
  });

  it('refuses a cross-scope auth claim', async () => {
    const { document } = assessedGuideCase();
    const built = buildEngineerGuide({ document, auth: AUTH, caseRevision: 'rev-1' });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.message);
    const result = await exportEngineerGuide({
      document: withOwnedGuide({ ...built.document, guide: built.guide, tenantId: AUTH.tenantId, projectId: AUTH.projectId }),
      auth: { tenantId: 'tenant-b', projectId: 'proj-b', actorId: 'actor-b' },
      outputPath: 'cross-scope.docx',
      outputRoot: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toMatch(/UNTRUSTED_SCOPE_CLAIM|OWNERSHIP_SCOPE_MISMATCH/);
  });
});
