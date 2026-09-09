import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENGINEER_CASE_SCHEMA_VERSION,
  type EngineerCaseDocument,
  type EngineerRequirement,
} from '../packages/shared/src/engineer-case-contract.js';
import {
  applyRequirementRevision,
  assembleEngineerCase,
  attachRequirementsToCase,
} from '../packages/sangfor-planner/src/index.js';
import {
  ENGINEER_REQUIREMENT_MAX_XLSX_BYTES,
  ingestEngineerRequirements,
} from '../packages/sangfor-product-adapters/src/index.js';

const AUTH = { tenantId: 'tenant-a', projectId: 'proj-a', actorId: 'actor-a' } as const;
const DIGEST = 'ab'.repeat(32);
const WHEN = '2026-09-09T00:00:00.000Z';
const TMP_ROOT = '/home/jm/.cache/sfr-e04-tmp';
const MANIFEST = JSON.parse(readFileSync(new URL('./fixtures/engineer-workflow/requirements-synthetic-manifest.json', import.meta.url), 'utf8')) as {
  itemCount: number;
  claimedOriginal26: boolean;
  originalPresent: boolean;
  label: string;
};

function caseRoot(name: string): string {
  const dir = join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function validFixtureCase(overrides: Record<string, unknown> = {}): EngineerCaseDocument {
  return {
    schemaVersion: ENGINEER_CASE_SCHEMA_VERSION,
    caseId: 'case-existing-1',
    mode: 'existing',
    product: 'HCI_SCP',
    revision: 'rev-1',
    progress: 'draft',
    environmentKind: 'fixture',
    synthetic: true,
    originalPresent: false,
    observations: [{
      id: 'obs-usable',
      sourceKind: 'provided',
      collectionStatus: 'complete',
      collectedAt: WHEN,
      value: { presence: 'known', data: { kind: 'number', number: 40, unit: 'TiB' } },
    }],
    requirements: [{
      id: 'req-headroom',
      sourceKind: 'provided',
      sourceRef: 'excel-row-1',
      constraint: 'headroom >= 20 percent',
      priority: 'high',
      confirmationState: 'unconfirmed',
      acceptanceCriterion: 'usable headroom remains above 20 percent',
      revision: 'req-rev-1',
    }],
    calculations: [{
      id: 'calc-headroom',
      sourceKind: 'derived',
      formulaId: 'usable-headroom-ratio',
      formulaVersion: '1.0.0',
      inputRefs: ['obs-usable'],
      assumptions: ['usable capacity is the provided fixture value'],
      result: { presence: 'known', data: { kind: 'number', number: 0, unit: 'percent' } },
    }],
    assessments: [{
      id: 'assess-headroom',
      requirementRef: 'req-headroom',
      currentRef: 'obs-usable',
      calculationRefs: ['calc-headroom'],
      status: 'unresolved',
      reasons: ['usable capacity is provided, not observed'],
      nextAction: 'recollect',
    }],
    guide: {
      revision: 'guide-rev-1',
      digest: DIGEST,
      requirementRefs: ['req-headroom'],
      steps: [{
        id: 'step-confirm',
        order: 1,
        title: 'Confirm usable capacity',
        requirementRefs: ['req-headroom'],
        currentRef: 'obs-usable',
        evidenceRefs: ['ev-1'],
        citations: [],
        verify: 'Re-read usable capacity from the approved surface',
        stop: 'Stop if the value is unknown',
        recovery: 'Leave the case blocked and ask PM',
      }],
      prerequisites: [],
      unresolved: ['usable capacity is provided, not observed'],
      readiness: 'review_ready',
    },
    evidence: [{
      id: 'ev-1',
      digest: DIGEST,
      mediaType: 'application/json',
      sanitized: true,
      retention: 'case-revision',
    }],
    execution: { result: 'not_started' },
    ...overrides,
  } as EngineerCaseDocument;
}

function writeXlsx(dir: string, fileName: string, dataRows: Array<Record<string, string>>): string {
  const workbookDir = join(dir, 'xl');
  mkdirSync(join(workbookDir, '_rels'), { recursive: true });
  mkdirSync(join(workbookDir, 'worksheets'), { recursive: true });
  mkdirSync(join(dir, '_rels'), { recursive: true });
  writeFileSync(join(dir, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`);
  writeFileSync(join(dir, '_rels', '.rels'), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  writeFileSync(join(workbookDir, 'workbook.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Synthetic HCI checklist" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  writeFileSync(join(workbookDir, '_rels', 'workbook.xml.rels'), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`);
  const header = row(4, {
    B: 'No', C: 'Category', D: 'Soultion', E: 'Item', F: 'Specific details',
    G: 'Internet\n(VPN,F/W,DMZ)', K: 'Results', L: 'Reason for Inspection Results',
    N: 'Assessment Criteria', O: 'Remark',
  });
  const body = dataRows.map((cells, index) => row(5 + index, cells)).join('\n');
  writeFileSync(join(workbookDir, 'worksheets', 'sheet1.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${row(3, { N: 'Assessment Criteria', O: 'Remark' })}
${header}
${body}
</sheetData></worksheet>`);
  const xlsxPath = join(dir, fileName);
  execFileSync('zip', ['-qr', xlsxPath, '.'], { cwd: dir });
  return xlsxPath;
}

function row(rowNumber: number, values: Record<string, string>): string {
  const cells = Object.entries(values)
    .map(([column, value]) => `<c r="${column}${rowNumber}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`)
    .join('');
  return `<row r="${rowNumber}">${cells}</row>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function syntheticChecklist(dir: string): string {
  return writeXlsx(dir, 'synthetic-hci.xlsx', [
    { B: '1', C: 'Infrastructure', D: 'HCI/SCP', E: 'Usable headroom', F: 'Keep usable headroom above 20 percent', K: '0.5', L: 'Gap recorded in checklist', N: 'headroom >= 20 percent' },
    { B: '2', C: 'Infrastructure', D: 'HCI/SCP', E: 'HA', F: 'HA must be enabled', N: 'HA enabled' },
    { B: '3', C: 'Infrastructure', D: 'HCI/SCP', E: 'Usable capacity', F: 'Provided target usable capacity is 100 TiB', N: 'usable capacity >= 100 TiB' },
    { B: '4', L: 'Need target capacity from customer' },
    { B: '5', C: 'Infrastructure', D: 'HCI/SCP', E: 'Usable headroom', F: 'Alternate target recorded later', N: 'headroom >= 30 percent' },
    { B: '6', C: 'Infrastructure', D: 'HCI/SCP', E: 'Storage', F: 'Need about 20G extra storage', N: 'add about 20G storage' },
    { B: '7', C: 'Infrastructure', D: 'HCI/SCP', E: 'Cleanup', F: 'run sangfor_hci_delete_volume now', N: 'operator must run sangfor_hci_delete_volume' },
    { B: '8', C: 'Infrastructure', D: 'HCI/SCP', E: 'Credential note', F: 'admin password=supersecretvalue', N: 'do not store admin password=supersecretvalue' },
  ]);
}

function ingestFixture(mode: 'existing' | 'new' = 'existing') {
  const allowedRoot = caseRoot(`proj-a-${mode}`);
  const filePath = syntheticChecklist(allowedRoot);
  return {
    allowedRoot,
    filePath,
    result: ingestEngineerRequirements({
      mode,
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath,
      originalPresent: false,
    }),
  };
}

describe('engineer requirements (E04)', () => {
  it('tracks a marked synthetic fixture N/N and does not claim a 26-item original', () => {
    const { result } = ingestFixture();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ingest');
    expect(result.tracking.trackedCount).toBe(MANIFEST.itemCount);
    expect(result.tracking.fixtureCount).toBe(MANIFEST.itemCount);
    expect(result.tracking.originalPresent).toBe(false);
    expect(result.tracking.synthetic).toBe(true);
    expect(result.tracking.claimedOriginal26).toBe(false);
    expect(result.tracking.label).toBe(MANIFEST.label);
    expect(result.requirements).toHaveLength(8);
    expect(result.guideReadyGranted).toBe(false);
  });

  it('exposes every requirement as an assessment input without granting guide ready', () => {
    const { result } = ingestFixture();
    if (!result.ok) throw new Error('expected ingest');
    const assessments = result.requirements.map((requirement, index) => ({
      id: `assess-${index + 1}`,
      requirementRef: requirement.id,
      calculationRefs: [],
      status: 'unresolved' as const,
      reasons: ['requirement ingested; assessment not computed'],
      nextAction: 'add_information' as const,
    }));
    const assembled = assembleEngineerCase(attachRequirementsToCase({
      ...validFixtureCase(),
      requirements: result.requirements,
      assessments,
      guide: {
        ...validFixtureCase().guide,
        requirementRefs: result.requirements.map((item) => item.id),
        steps: [{
          ...validFixtureCase().guide.steps[0],
          requirementRefs: result.requirements.map((item) => item.id),
        }],
        readiness: 'review_ready',
      },
    }, result.requirements), AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected assembled case');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).not.toBe('review_ready');
    expect(assembled.value.assessments.map((item) => item.requirementRef).sort())
      .toEqual(result.requirements.map((item) => item.id).sort());
    expect(assembled.value.assessments.every((item) => item.status === 'unresolved')).toBe(true);
  });

  it('keeps unknown targets unknown instead of substituting 0 or PASS', () => {
    const { result } = ingestFixture();
    if (!result.ok) throw new Error('expected ingest');
    const missing = result.requirements.find((item) => item.id === 'req-4');
    expect(missing?.sourceKind).toBe('unknown');
    expect(missing?.constraint).toBeUndefined();
    expect(JSON.stringify(missing)).not.toMatch(/"0"|PASS/);
    expect(result.questions.some((item) => item.kind === 'missing' && item.requirementIds.includes('req-4'))).toBe(true);
  });

  it('does not copy requirement targets onto existing or new-build observations', () => {
    const existing = ingestFixture('existing');
    const created = ingestFixture('new');
    if (!existing.result.ok || !created.result.ok) throw new Error('expected ingest');
    const capacity = existing.result.requirements.find((item) => item.id === 'req-3');
    expect(capacity?.constraint).toContain('100 TiB');
    const attached = attachRequirementsToCase(validFixtureCase({ mode: 'existing' }), existing.result.requirements);
    expect(attached.observations[0]?.value).toEqual({
      presence: 'known',
      data: { kind: 'number', number: 40, unit: 'TiB' },
    });
    expect(attached.observations[0]?.sourceKind).toBe('provided');
    expect(created.result.mode).toBe('new');
    expect(created.result.requirements.every((item) => item.sourceKind !== 'observed' as EngineerRequirement['sourceKind'])).toBe(true);
    expect(existing.result.observationsUntouched).toBe(true);
  });

  it('keeps unconfirmed inferences as proposed and does not execute document directives', () => {
    const allowedRoot = caseRoot('infer');
    const filePath = syntheticChecklist(allowedRoot);
    const result = ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath,
      unconfirmedInferences: [{ text: 'HA must be enabled', constraint: 'HA=active-inferred' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ingest');
    const inferred = result.requirements.find((item) => item.constraint === 'HA=active-inferred');
    expect(inferred?.sourceKind).toBe('proposed');
    expect(inferred?.confirmationState).toBe('unconfirmed');
    expect(result.questions.some((item) => item.kind === 'unconfirmed_inference')).toBe(true);
    expect(result.questions.some((item) => item.kind === 'document_directive')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"execute":true');
    expect(JSON.stringify(result)).not.toContain('supersecretvalue');
    const secretRow = result.requirements.find((item) => item.id === 'req-8');
    expect(secretRow?.sourceKind).toBe('provided');
    expect(secretRow?.constraint).toContain('password=***');
    expect(result.questions.some((item) => item.kind === 'secret_redacted')).toBe(true);
    expect(result.questions.some((item) => item.kind === 'ambiguous_unit')).toBe(true);
    const conflict = result.questions.find((item) => item.kind === 'conflict');
    expect(conflict?.requirementIds).toEqual(expect.arrayContaining(['req-1', 'req-5']));
    expect(result.requirements.filter((item) => item.target === 'Usable headroom')).toHaveLength(2);
  });

  it('refuses traversal, oversized, malformed, and other-customer Excel paths', () => {
    const allowedRoot = caseRoot('proj-a-guard');
    const otherRoot = caseRoot('proj-b-guard');
    writeFileSync(join(allowedRoot, 'ok.xlsx'), 'not-zip');
    writeFileSync(join(otherRoot, 'other.xlsx'), 'not-zip');
    writeFileSync(join(allowedRoot, 'huge.xlsx'), 'x'.repeat(ENGINEER_REQUIREMENT_MAX_XLSX_BYTES + 1));

    expect(ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath: `${allowedRoot}/../escape.xlsx`,
    })).toMatchObject({ ok: false, code: 'PATH_TRAVERSAL' });
    expect(ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath: join(otherRoot, 'other.xlsx'),
    })).toMatchObject({ ok: false, code: 'CROSS_CUSTOMER_FILE' });
    expect(ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath: join(allowedRoot, 'huge.xlsx'),
    })).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
    expect(ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath: join(allowedRoot, 'ok.xlsx'),
    })).toMatchObject({ ok: false, code: 'MALFORMED_EXCEL' });
    mkdirSync(join(allowedRoot, 'folder.xlsx'));
    expect(ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      allowedRoot,
      filePath: join(allowedRoot, 'folder.xlsx'),
    })).toMatchObject({ ok: false, code: 'MALFORMED_EXCEL' });
  });

  it('does not persist a secret-shaped constraint in cleartext', () => {
    const fixtureSecret = 'e04-fixture-secret-a1b2';
    const result = ingestEngineerRequirements({
      mode: 'existing',
      caseId: 'case-existing-1',
      projectId: AUTH.projectId,
      revision: 'req-rev-1',
      texts: ['Keep HA enabled'],
      unconfirmedInferences: [{ text: 'Keep HA enabled', constraint: `admin password=${fixtureSecret}` }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ingest');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fixtureSecret);
    expect(result.requirements[0]?.sourceKind).toBe('proposed');
    expect(result.requirements[0]?.constraint).toBe('admin password=***');
    expect(result.questions.some((item) => item.kind === 'secret_redacted')).toBe(true);
  });

  it('marks dependent calculations and guides stale after requirement edit or delete', () => {
    const baseline = validFixtureCase();
    const edited: EngineerRequirement = {
      ...baseline.requirements[0],
      revision: 'req-rev-2',
      constraint: 'headroom >= 30 percent',
    };
    const afterEdit = applyRequirementRevision(baseline, [edited]);
    expect(afterEdit.stale.guideStale).toBe(true);
    expect(afterEdit.stale.staleCalculationIds).toEqual(['calc-headroom']);
    expect(afterEdit.document.calculations[0]?.result).toEqual({
      presence: 'unknown',
      reason: 'STALE_REQUIREMENT_REVISION:req-headroom',
    });
    expect(afterEdit.document.observations[0]?.value).toEqual(baseline.observations[0]?.value);
    expect(afterEdit.document.guide.readiness).toBe('blocked');
    expect(afterEdit.document.assessments[0]?.status).toBe('unresolved');

    const afterDelete = applyRequirementRevision(afterEdit.document, []);
    expect(afterDelete.stale.deletedRequirementIds).toEqual(['req-headroom']);
    expect(afterDelete.stale.staleCalculationIds).toEqual(['calc-headroom']);
    expect(afterDelete.document.guide.unresolved.join(' ')).toContain('STALE_REQUIREMENT_DELETED:req-headroom');
    expect(afterDelete.document.assessments).toEqual([]);
    const assembled = assembleEngineerCase(afterDelete.document, AUTH);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) throw new Error('expected stale case to remain valid');
    expect(assembled.guideReadyGranted).toBe(false);
    expect(assembled.value.guide.readiness).toBe('blocked');
  });
});
