import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportEngineerGuide,
  formatStoredEngineerValue,
} from '../packages/sangfor-product-adapters/src/engineer-guide-export.js';
import {
  computeEngineerGuideDigest,
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerAssessment,
  type EngineerCaseDocument,
  type EngineerGuide,
  type EngineerValue,
} from '../packages/shared/src/engineer-case-contract.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const WHEN = '2026-09-09T00:00:00.000Z';
const OWNER = { tenantId: AUTH.tenantId, projectId: AUTH.projectId, caseId: 'case-existing-1' } as const;

function withDigest(guide: Omit<EngineerGuide, 'digest'>): EngineerGuide {
  return { ...guide, digest: computeEngineerGuideDigest(guide) };
}

function exportable(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  const guide = withDigest({
    revision: 'guide-rev-1',
    requirementRefs: ['req-remaining', 'req-ha'],
    steps: [{
      id: 'step-1',
      order: 1,
      title: 'Confirm remaining capacity',
      requirementRefs: ['req-remaining'],
      currentRef: 'obs-total',
      proposedRef: 'calc-remaining',
      evidenceRefs: ['ev-1'],
      citations: ['ev-1'],
      verify: 'Read remaining after change',
      stop: 'Stop if remaining is unknown',
      recovery: 'Do not apply a guessed value',
    }],
    prerequisites: ['saved case'],
    unresolved: ['usable capacity is provided, not observed'],
    readiness: 'review_ready',
  });
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
    observations: [
      {
        id: 'obs-total',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 100, unit: 'GiB' } },
      },
      {
        id: 'obs-used',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'GiB' } },
      },
      {
        id: 'obs-fraction',
        sourceKind: 'provided',
        collectionStatus: 'complete',
        collectedAt: WHEN,
        evidenceRef: 'ev-1',
        value: { presence: 'known', data: { kind: 'number', number: 12.25, unit: 'GiB' } },
      },
    ],
    requirements: [
      {
        id: 'req-remaining',
        sourceKind: 'provided',
        sourceRef: 'excel-row-1',
        constraint: 'remaining >= 20 GiB',
        priority: 'high',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'remaining >= 20 GiB',
        revision: 'req-rev-1',
      },
      {
        id: 'req-ha',
        sourceKind: 'provided',
        sourceRef: 'excel-row-2',
        constraint: 'HA enabled',
        priority: 'high',
        confirmationState: 'confirmed',
        acceptanceCriterion: 'HA enabled',
        revision: 'req-rev-1',
      },
    ],
    calculations: [{
      id: 'calc-remaining',
      sourceKind: 'derived',
      formulaId: 'remaining-capacity',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-total', 'obs-used'],
      assumptions: ['usable capacity is the provided fixture value'],
      result: { presence: 'known', data: { kind: 'number', number: 60, unit: 'GiB' } },
    }],
    assessments: [{
      id: 'assess-remaining',
      requirementRef: 'req-remaining',
      currentRef: 'calc-remaining',
      calculationRefs: ['calc-remaining'],
      status: 'unresolved',
      reasons: ['usable capacity is provided, not observed'],
      nextAction: 'recollect',
    }],
    guide,
    evidence: [{
      id: 'ev-1',
      owner: OWNER,
      digest: 'ab'.repeat(32),
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
    ...overrides,
  } as EngineerCaseDocument;
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
    const document = exportable();
    const result = await exportEngineerGuide({
      document,
      auth: AUTH,
      outputPath: 'case-existing-1-g-rev-1.docx',
      outputRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.recomputed).toBe(false);
    expect(result.fieldAccepted).toBe(false);
    expect(result.approvedForWindow).toBe(false);
    expect(result.guideRevision).toBe(document.guide.revision);
    expect(result.digest).toBe(document.guide.digest);
    expect(result.readiness).toBe('review_ready');
    expect(result.draftMarked).toBe(false);

    const docxAbs = join(root, result.docxPath);
    const jsonAbs = join(root, result.jsonPath);
    expect(existsSync(docxAbs)).toBe(true);
    expect(statSync(docxAbs).size).toBeGreaterThan(0);
    const xml = documentXml(docxAbs);
    expect(xml).toContain('req-remaining');
    expect(xml).toContain('req-ha');
    expect(xml).toContain('60 GiB');
    expect(xml).toContain('12.25 GiB');
    expect(xml).toContain('100 GiB');
    expect(xml).not.toContain('60.00');
    expect(xml).toContain(document.guide.digest);
    expect(xml).toContain('review_ready');
    expect(xml).toContain('approved_for_window가 아닙니다');
    expect(xml).not.toContain('field_accepted=true');

    const review = JSON.parse(readFileSync(jsonAbs, 'utf8')) as {
      digest: string;
      requirementIds: string[];
      unresolved: string[];
      values: Record<string, { value?: { number?: number } }>;
      acceptanceClaims: { field_accepted: boolean; approved_for_window: boolean; pm_accepted: boolean };
      recomputed: boolean;
    };
    expect(review.digest).toBe(document.guide.digest);
    expect(review.requirementIds).toEqual(['req-remaining', 'req-ha']);
    expect(review.unresolved).toEqual(document.guide.unresolved);
    expect(review.values['obs-fraction']?.value?.number).toBe(12.25);
    expect(review.values['calc-remaining']?.value?.number).toBe(60);
    expect(review.acceptanceClaims).toEqual({
      documentReadiness: 'review_ready',
      field_accepted: false,
      approved_for_window: false,
      pm_accepted: false,
    });
    expect(review.recomputed).toBe(false);
  });

  it('prints 초안 when the supplied guide is blocked and does not upgrade readiness', async () => {
    const document = exportable({
      guide: withDigest({
        revision: 'guide-rev-1',
        requirementRefs: ['req-remaining', 'req-ha'],
        steps: [],
        prerequisites: [],
        unresolved: ['host cpu missing'],
        readiness: 'blocked',
      }),
    });
    const result = await exportEngineerGuide({
      document,
      auth: AUTH,
      outputPath: 'blocked-guide.docx',
      outputRoot: root,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.readiness).toBe('blocked');
    expect(result.draftMarked).toBe(true);
    expect(documentXml(join(root, result.docxPath))).toContain('초안');
  });

  it('refuses path escape, filename collision, and missing ownership without leaving scratch', async () => {
    const document = exportable();
    const before = new Set(tempRoots('engdocx-'));
    const escaped = await exportEngineerGuide({
      document,
      auth: AUTH,
      outputPath: '../../etc/evil.docx',
      outputRoot: root,
    });
    expect(escaped).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(tempRoots('engdocx-').filter((name) => !before.has(name))).toEqual([]);

    const first = await exportEngineerGuide({
      document,
      auth: AUTH,
      outputPath: 'same-name.docx',
      outputRoot: root,
    });
    expect(first.ok).toBe(true);
    const collision = await exportEngineerGuide({
      document,
      auth: AUTH,
      outputPath: 'same-name.docx',
      outputRoot: root,
    });
    expect(collision).toMatchObject({ ok: false, code: 'FILENAME_COLLISION' });

    writeFileSync(join(root, 'json-taken.review.json'), '{}\n');
    const jsonCollision = await exportEngineerGuide({
      document,
      auth: AUTH,
      outputPath: 'json-taken.docx',
      outputRoot: root,
    });
    expect(jsonCollision).toMatchObject({ ok: false, code: 'FILENAME_COLLISION' });
    expect(existsSync(join(root, 'json-taken.docx'))).toBe(false);

    const unowned = {
      ...document,
      evidence: document.evidence.map((item) => {
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
    const document = exportable({
      requirements: [
        ...(exportable().requirements),
        {
          id: 'req-cpu',
          sourceKind: 'provided',
          sourceRef: 'excel-row-3',
          constraint: 'host cpu >= 16 cores',
          priority: 'medium',
          confirmationState: 'confirmed',
          acceptanceCriterion: 'host cpu >= 16 cores',
          revision: 'req-rev-1',
        },
      ],
    });
    const omitted = {
      ...document,
      guide: withDigest({
        revision: document.guide.revision,
        requirementRefs: ['req-remaining', 'req-ha'],
        steps: document.guide.steps,
        prerequisites: document.guide.prerequisites,
        unresolved: document.guide.unresolved,
        readiness: document.guide.readiness,
      }),
    };
    const missing = await exportEngineerGuide({
      document: omitted,
      auth: AUTH,
      outputPath: 'missing-req.docx',
      outputRoot: root,
    });
    expect(missing).toMatchObject({ ok: false, code: 'MISSING_REQUIREMENT' });

    const mismatch = await exportEngineerGuide({
      document: { ...exportable(), guide: { ...exportable().guide, digest: 'cd'.repeat(32) } },
      auth: AUTH,
      outputPath: 'bad-digest.docx',
      outputRoot: root,
    });
    expect(mismatch).toMatchObject({ ok: false, code: 'GUIDE_DIGEST_MISMATCH' });
  });

  it('masks secret-shaped text and does not treat review_ready as field acceptance', async () => {
    const secret: EngineerAssessment = {
      id: 'assess-remaining',
      requirementRef: 'req-remaining',
      currentRef: 'calc-remaining',
      calculationRefs: ['calc-remaining'],
      status: 'unresolved',
      reasons: ['password=historical-not-for-use'],
      nextAction: 'recollect',
    };
    const result = await exportEngineerGuide({
      document: exportable({ assessments: [secret] }),
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
  });

  it('refuses a cross-scope auth claim', async () => {
    const result = await exportEngineerGuide({
      document: { ...exportable(), tenantId: AUTH.tenantId, projectId: AUTH.projectId },
      auth: { tenantId: 'tenant-b', projectId: 'proj-b', actorId: 'actor-b' },
      outputPath: 'cross-scope.docx',
      outputRoot: root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.code).toMatch(/UNTRUSTED_SCOPE_CLAIM|OWNERSHIP_SCOPE_MISMATCH/);
  });
});
