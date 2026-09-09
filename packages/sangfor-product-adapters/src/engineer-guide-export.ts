/**
 * Word + JSON review export of a canonical engineer guide (E08).
 *
 * The guide is data. This module does not call buildEngineerGuide,
 * assessEngineerCase, or assembleEngineerCase, and it does not change
 * readiness. review_ready is printed as a document claim only — never as
 * field_accepted or approved_for_window. Unknown stays unknown.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOfficeCliAvailable, validateOfficeDocument, type ValidateOfficeDocumentResult } from '@sangfor/office';
import { computeEngineerGuideDigest } from '../../sangfor-planner/src/engineer-guide.js';
import {
  writeConfinedDocxArchive,
  type ConfinedDocxArchiveResult,
} from '../../sangfor-spec/src/report-docx.js';
import {
  isEngineerCaseAuthContext,
  parseEngineerCaseDocument,
  runtimeSchemaIssueCode,
  serializeEngineerValue,
  type EngineerAssessment,
  type EngineerCalculation,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
  type EngineerGuideReadiness,
  type EngineerObservation,
  type EngineerValue,
} from '../../shared/src/engineer-case-contract.js';

export const ENGINEER_GUIDE_EXPORT_MAX_DOCX_BYTES = 8 * 1024 * 1024;
export const ENGINEER_GUIDE_EXPORT_MAX_JSON_BYTES = 512 * 1024;
export const ENGINEER_GUIDE_REVIEW_SCHEMA = 'engineer-guide-review.v1' as const;

const SECRET_KEY_RE = /password|secret|token|authorization|cookie/i;
const SECRET_TEXT_RE = /(?:password|secret|token|authorization|cookie|비밀번호|패스워드|토큰)\s*[:=]\s*\S+/giu;
const FILE_NAME_RE = /^[A-Za-z0-9._-]+\.docx$/u;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="BodyText"><w:name w:val="Body Text"/><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TitleText"><w:name w:val="Title Text"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:b/><w:color w:val="0B2545"/><w:sz w:val="40"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="360" w:after="200"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:pPr><w:spacing w:after="0" w:line="280" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="18"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

export type EngineerGuideExportRequest = {
  readonly document: unknown;
  readonly auth: unknown;
  readonly outputPath: string;
  readonly outputRoot?: string;
};

export type EngineerGuideExportSuccess = {
  readonly ok: true;
  readonly caseId: string;
  readonly caseRevision: string;
  readonly guideRevision: string;
  readonly digest: string;
  readonly readiness: EngineerGuideReadiness;
  readonly draftMarked: boolean;
  readonly jsonPath: string;
  readonly docxPath: string;
  readonly jsonDigest: string;
  readonly docxDigest: string;
  readonly size: number;
  readonly validation: ValidateOfficeDocumentResult;
  readonly officeCli: ReturnType<typeof isOfficeCliAvailable>;
  readonly recomputed: false;
  readonly fieldAccepted: false;
  readonly approvedForWindow: false;
};

export type EngineerGuideExportFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly recomputed: false;
};

export type EngineerGuideExportResult = EngineerGuideExportSuccess | EngineerGuideExportFailure;

function fail(code: string, message: string): EngineerGuideExportFailure {
  return { ok: false, code, message, recomputed: false };
}

function maskText(text: string): string {
  return text.replace(SECRET_TEXT_RE, (match) => `${match.split(/[:=]/u)[0]}=***`);
}

function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) && typeof child === 'string' ? '***' : maskSecrets(child);
    }
    return out as T;
  }
  return typeof value === 'string' ? maskText(value) as T : value;
}

function storedNumber(value: number): string {
  return JSON.stringify(value);
}

export function formatStoredEngineerValue(value: EngineerValue): string {
  const serialized = serializeEngineerValue(value);
  if (serialized.presence === 'unknown') {
    return `unknown (${serialized.reason ?? 'unspecified'})`;
  }
  const data = serialized.value;
  if (!data) return 'unknown (unbound value)';
  if (data.kind === 'number') return `${storedNumber(data.number)} ${data.unit}`;
  if (data.kind === 'integer') return data.unit ? `${storedNumber(data.integer)} ${data.unit}` : storedNumber(data.integer);
  if (data.kind === 'boolean') return data.boolean ? 'true' : 'false';
  return data.text;
}

function valueById(
  document: EngineerCaseDocument,
  id: string | undefined,
): EngineerObservation | EngineerCalculation | undefined {
  if (!id) return undefined;
  return document.observations.find((item) => item.id === id)
    ?? document.calculations.find((item) => item.id === id);
}

function isCalculation(record: EngineerObservation | EngineerCalculation): record is EngineerCalculation {
  return 'formulaId' in record;
}

function formatBoundValue(document: EngineerCaseDocument, id: string | undefined): string {
  if (!id) return 'unknown (unbound ref)';
  const record = valueById(document, id);
  if (!record) return `unknown (missing ${id})`;
  if (isCalculation(record)) {
    if (record.result) return `${id}: ${formatStoredEngineerValue(record.result)} [${record.sourceKind}]`;
    return `${id}: unknown (${record.unavailableReason ?? 'unavailable'}) [${record.sourceKind}]`;
  }
  return `${id}: ${formatStoredEngineerValue(record.value)} [${record.sourceKind}]`;
}

function parseDocument(input: unknown): EngineerCaseDocument | EngineerGuideExportFailure {
  let source: string;
  if (typeof input === 'string') source = input;
  else {
    try {
      source = JSON.stringify(input);
    } catch {
      return fail('MALFORMED_JSON', 'document is not JSON');
    }
  }
  try {
    return parseEngineerCaseDocument(source);
  } catch (error) {
    return fail(runtimeSchemaIssueCode(error) ?? 'SCHEMA_MISMATCH', error instanceof Error ? error.message : 'invalid engineer-case document');
  }
}

function scopeIssues(document: EngineerCaseDocument, auth: EngineerCaseAuthContext): EngineerGuideExportFailure | undefined {
  if (document.tenantId && document.tenantId !== auth.tenantId) {
    return fail('UNTRUSTED_SCOPE_CLAIM', 'document tenantId does not match authenticated tenant');
  }
  if (document.projectId && document.projectId !== auth.projectId) {
    return fail('UNTRUSTED_SCOPE_CLAIM', 'document projectId does not match authenticated project');
  }
  if (document.actorId && document.actorId !== auth.actorId) {
    return fail('UNTRUSTED_SCOPE_CLAIM', 'document actorId does not match authenticated actor');
  }
  for (const [index, item] of document.evidence.entries()) {
    if (!item.owner) {
      return fail('OWNERSHIP_METADATA_MISSING', `evidence.${index} (${item.id}) has no owner`);
    }
    if (item.owner.tenantId !== auth.tenantId || item.owner.projectId !== auth.projectId || item.owner.caseId !== document.caseId) {
      return fail('OWNERSHIP_SCOPE_MISMATCH', `evidence.${index} owner does not match authenticated case scope`);
    }
  }
  return undefined;
}

function missingRequirement(document: EngineerCaseDocument): EngineerGuideExportFailure | undefined {
  const listed = new Set(document.guide.requirementRefs);
  for (const requirement of document.requirements) {
    if (!listed.has(requirement.id)) {
      return fail('MISSING_REQUIREMENT', `guide.requirementRefs omits ${requirement.id}`);
    }
  }
  return undefined;
}

function defaultOutputPath(document: EngineerCaseDocument): string {
  return `${document.caseId}-${document.guide.revision}.docx`;
}

function assertOutputFileName(outputPath: string): EngineerGuideExportFailure | undefined {
  if (outputPath.includes('\0') || outputPath.includes('..')) {
    return fail('PATH_TRAVERSAL', `outputPath escapes the export root: ${outputPath}`);
  }
  const base = outputPath.split(/[/\\]/u).pop() ?? '';
  if (!FILE_NAME_RE.test(base)) {
    return fail('INVALID_FILENAME', `outputPath must be a confined ${FILE_NAME_RE} name: ${outputPath}`);
  }
  return undefined;
}

function reviewJsonPath(docxPath: string): string {
  return docxPath.replace(/\.docx$/iu, '.review.json');
}

function digestFile(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function readinessBanner(readiness: EngineerGuideReadiness): { text: string; draftMarked: boolean } {
  const disclaimer = 'review_ready는 문서 주장일 뿐이며 PM 승인·field_accepted·approved_for_window가 아닙니다. 이 출력은 판정·숫자를 다시 계산하지 않습니다.';
  if (readiness === 'review_ready') {
    return {
      text: `문서 상태: review_ready (검토 준비). ${disclaimer}`,
      draftMarked: false,
    };
  }
  return {
    text: `초안 — 문서 상태: ${readiness}. 검토 준비가 아닙니다. ${disclaimer}`,
    draftMarked: true,
  };
}

function esc(value: unknown): string {
  return maskText(String(value ?? ''))
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function para(text: string, style = 'BodyText', opts: { bold?: boolean; color?: string; size?: number } = {}): string {
  const props = [
    opts.bold ? '<w:b/>' : '',
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    opts.size ? `<w:sz w:val="${opts.size}"/>` : '',
  ].join('');
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function pageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function tableCellParagraphs(text: string, header: boolean): string {
  const bold = header ? '<w:b/>' : '';
  const chunks = header || text.length < 96
    ? [text]
    : text.split(/;\s*/u).map((part, index, parts) => (index < parts.length - 1 ? `${part};` : part));
  return chunks.map((chunk) => (
    `<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(chunk)}</w:t></w:r></w:p>`
  )).join('');
}

function tableCell(text: string, width: number, header: boolean): string {
  const fill = header ? '<w:shd w:val="clear" w:color="auto" w:fill="E8EEF5"/>' : '';
  return `<w:tc><w:tcPr><w:tcW w:type="dxa" w:w="${width}"/>${fill}<w:vAlign w:val="top"/><w:noWrap w:val="0"/></w:tcPr>${tableCellParagraphs(text, header)}</w:tc>`;
}

function table(headers: string[], rows: string[][], widths: number[]): string {
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
  const body = [
    `<w:tr>${headers.map((cell, index) => tableCell(cell, widths[index] ?? 1200, true)).join('')}</w:tr>`,
    ...rows.map((row) => `<w:tr>${row.map((cell, index) => tableCell(cell, widths[index] ?? 1200, false)).join('')}</w:tr>`),
  ].join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:type="dxa" w:w="9360"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

function assessmentFor(document: EngineerCaseDocument, requirementId: string): EngineerAssessment | undefined {
  return document.assessments.find((item) => item.requirementRef === requirementId);
}

function buildDocumentXml(document: EngineerCaseDocument, banner: string): string {
  const guide = document.guide;
  const body: string[] = [];
  body.push(para('엔지니어 구축 가이드', 'TitleText'));
  body.push(para(banner, 'BodyText', { bold: true, color: guide.readiness === 'review_ready' ? '8A5A00' : '9B1B30' }));
  body.push(para(
    `사례 ${document.caseId} · 사례 revision ${document.revision} · 가이드 revision ${guide.revision} · digest ${guide.digest}`,
    'BodyText',
  ));
  body.push(para(
    `제품 ${document.product} · firmware ${document.firmware ?? 'unknown'} · 모드 ${document.mode} · 환경 ${document.environmentKind}`,
    'BodyText',
  ));

  body.push(pageBreak());
  body.push(para('1. 요약', 'Heading1'));
  body.push(table(
    ['항목', '값', '출처'],
    [
      ['caseId', document.caseId, 'document'],
      ['caseRevision', document.revision, 'document'],
      ['guideRevision', guide.revision, 'guide'],
      ['digest', guide.digest, 'guide'],
      ['readiness', guide.readiness, 'guide'],
      ['progress', document.progress, 'document'],
    ],
    [2200, 4760, 2400],
  ));

  body.push(pageBreak());
  body.push(para('2. 현재 구성', 'Heading1'));
  body.push(table(
    ['ID', '값', '출처종류', '출처'],
    document.observations.map((item) => {
      const rendered = formatStoredEngineerValue(item.value);
      return [item.id, rendered, item.sourceKind, item.evidenceRef ?? item.unknownReason ?? item.collectionStatus];
    }),
    [2000, 3360, 2000, 2000],
  ));

  body.push(pageBreak());
  body.push(para('3. 계산과 가정', 'Heading1'));
  if (document.calculations.length === 0) {
    body.push(para('계산 없음. 없는 값을 0으로 채우지 않습니다.', 'BodyText'));
  } else {
    body.push(table(
      ['ID', '수식', '결과', '가정'],
      document.calculations.map((item) => [
        item.id,
        `${item.formulaId}@${item.formulaVersion}`,
        item.result ? formatStoredEngineerValue(item.result) : `unknown (${item.unavailableReason ?? 'unavailable'})`,
        item.assumptions.join('; ') || '(none)',
      ]),
      [1800, 2200, 2680, 2680],
    ));
  }

  body.push(pageBreak());
  body.push(para('4. 요구사항별 차이', 'Heading1'));
  body.push(table(
    ['요구사항', '판정', '현재', '목표', '이유'],
    document.guide.requirementRefs.map((requirementId) => {
      const requirement = document.requirements.find((item) => item.id === requirementId);
      const assessment = assessmentFor(document, requirementId);
      return [
        requirementId,
        assessment?.status ?? 'unknown (no assessment in document)',
        formatBoundValue(document, assessment?.currentRef),
        formatBoundValue(document, assessment?.desiredRef),
        `${requirement?.acceptanceCriterion ?? ''} ${assessment?.reasons.join('; ') ?? ''}`.trim(),
      ];
    }),
    [1600, 1600, 2000, 2000, 2160],
  ));

  body.push(pageBreak());
  body.push(para('5. 작업 절차', 'Heading1'));
  body.push(para(`단계 순서는 가이드에 저장된 순서입니다. 선행조건: ${guide.prerequisites.join(' / ') || '(none)'}`, 'BodyText'));
  body.push(table(
    ['순서', '단계', '요구사항', '현재/제안'],
    guide.steps.map((step) => [
      storedNumber(step.order),
      step.title,
      step.requirementRefs.join(', '),
      `${formatBoundValue(document, step.currentRef)} / ${formatBoundValue(document, step.proposedRef)}`,
    ]),
    [1000, 3360, 2000, 3000],
  ));

  body.push(pageBreak());
  body.push(para('6. 검증', 'Heading1'));
  body.push(table(
    ['단계', '요구사항', '검증'],
    guide.steps.map((step) => [step.id, step.requirementRefs.join(', '), step.verify]),
    [1800, 2200, 5360],
  ));

  body.push(pageBreak());
  body.push(para('7. 복구·중지', 'Heading1'));
  body.push(table(
    ['단계', '중지', '복구'],
    guide.steps.map((step) => [step.id, step.stop, step.recovery]),
    [1800, 3780, 3780],
  ));

  body.push(pageBreak());
  body.push(para('8. 미확인', 'Heading1'));
  if (guide.unresolved.length === 0) {
    body.push(para('미확인 항목 없음 (가이드 unresolved가 비어 있음).', 'BodyText'));
  } else {
    body.push(table(
      ['#', '미확인'],
      guide.unresolved.map((item, index) => [storedNumber(index + 1), item]),
      [800, 8560],
    ));
  }

  body.push(pageBreak());
  body.push(para('9. 출처', 'Heading1'));
  body.push(table(
    ['증거', 'digest', '소유', '인용'],
    document.evidence.map((item) => [
      item.id,
      item.digest,
      item.owner ? `${item.owner.tenantId}/${item.owner.projectId}/${item.owner.caseId}` : 'missing',
      guide.steps.flatMap((step) => step.citations.filter((citation) => citation.includes(item.id))).join(', ') || item.mediaType,
    ]),
    [1600, 3000, 2800, 1960],
  ));

  body.push(pageBreak());
  body.push(para('10. 서명란', 'Heading1'));
  body.push(para('검토자: ____________________    날짜: __________', 'BodyText'));
  body.push(para('판정: 수정 요청 / 가이드 내용 검토 (PM) / 현장 인수 아님', 'BodyText'));
  body.push(para('이 서명은 field_accepted 또는 approved_for_window가 아닙니다. 장비 쓰기를 승인하지 않습니다.', 'BodyText', { bold: true }));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n<w:body>\n${body.join('\n')}\n<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>\n</w:body>\n</w:document>`;
}

function reviewCopy(document: EngineerCaseDocument, files: { jsonFile: string; docxFile: string }): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const item of document.observations) {
    values[item.id] = { sourceKind: item.sourceKind, ...serializeEngineerValue(item.value) };
  }
  for (const item of document.calculations) {
    values[item.id] = {
      sourceKind: item.sourceKind,
      formulaId: item.formulaId,
      formulaVersion: item.formulaVersion,
      ...(item.result ? serializeEngineerValue(item.result) : { presence: 'unknown', value: null, reason: item.unavailableReason }),
    };
  }
  return maskSecrets({
    schemaVersion: ENGINEER_GUIDE_REVIEW_SCHEMA,
    caseId: document.caseId,
    caseRevision: document.revision,
    guideRevision: document.guide.revision,
    digest: document.guide.digest,
    readiness: document.guide.readiness,
    requirementIds: [...document.guide.requirementRefs],
    unresolved: [...document.guide.unresolved],
    values,
    assessments: document.assessments.map((item) => ({
      id: item.id,
      requirementRef: item.requirementRef,
      status: item.status,
      currentRef: item.currentRef,
      desiredRef: item.desiredRef,
      reasons: item.reasons,
    })),
    steps: document.guide.steps.map((step) => ({
      id: step.id,
      order: step.order,
      requirementRefs: step.requirementRefs,
    })),
    linked: files,
    acceptanceClaims: {
      documentReadiness: document.guide.readiness,
      field_accepted: false,
      approved_for_window: false,
      pm_accepted: false,
    },
    recomputed: false,
  });
}

function cleanupPartial(paths: readonly string[]): void {
  for (const path of paths) {
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Render the supplied case/guide document as JSON + DOCX of the same revision.
 * Numbers, requirement IDs, step order, and readiness are copied, not recomputed.
 */
export async function exportEngineerGuide(request: EngineerGuideExportRequest): Promise<EngineerGuideExportResult> {
  if (!isEngineerCaseAuthContext(request.auth)) {
    return fail('AUTH_CONTEXT_INVALID', 'authenticated tenant/project/actor is required');
  }
  const parsed = parseDocument(request.document);
  if ('ok' in parsed && parsed.ok === false) return parsed;
  const document = parsed as EngineerCaseDocument;

  const scope = scopeIssues(document, request.auth);
  if (scope) return scope;
  const missing = missingRequirement(document);
  if (missing) return missing;

  const expectedDigest = computeEngineerGuideDigest({
    revision: document.guide.revision,
    requirementRefs: document.guide.requirementRefs,
    steps: document.guide.steps,
    prerequisites: document.guide.prerequisites,
    unresolved: document.guide.unresolved,
    readiness: document.guide.readiness,
  });
  if (expectedDigest !== document.guide.digest) {
    return fail('GUIDE_DIGEST_MISMATCH', 'guide.digest does not match the supplied guide fields');
  }

  const outputPath = request.outputPath.trim() || defaultOutputPath(document);
  const fileNameError = assertOutputFileName(outputPath);
  if (fileNameError) return fileNameError;

  const jsonPath = reviewJsonPath(outputPath);
  const banner = readinessBanner(document.guide.readiness);
  const review = reviewCopy(document, {
    jsonFile: jsonPath.split(/[/\\]/u).pop() ?? jsonPath,
    docxFile: outputPath.split(/[/\\]/u).pop() ?? outputPath,
  });
  const reviewText = `${JSON.stringify(review, null, 2)}\n`;
  if (Buffer.byteLength(reviewText) > ENGINEER_GUIDE_EXPORT_MAX_JSON_BYTES) {
    return fail('FILE_TOO_LARGE', `review JSON exceeds ${ENGINEER_GUIDE_EXPORT_MAX_JSON_BYTES} bytes`);
  }

  let written: ConfinedDocxArchiveResult;
  try {
    written = writeConfinedDocxArchive({
      outputPath,
      outputRoot: request.outputRoot,
      scratchPrefix: 'engdocx-',
      overwrite: false,
      files: {
        '[Content_Types].xml': CONTENT_TYPES,
        '_rels/.rels': RELS,
        'word/_rels/document.xml.rels': DOCUMENT_RELS,
        'word/styles.xml': STYLES,
        'word/document.xml': buildDocumentXml(document, banner.text),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/escapes the output root/i.test(message)) return fail('PATH_TRAVERSAL', message);
    if (/already exists/i.test(message)) return fail('FILENAME_COLLISION', message);
    if (/must end with \.docx/i.test(message)) return fail('INVALID_FILENAME', message);
    return fail('DOCX_WRITE_FAILED', message);
  }

  const jsonAbs = join(dirname(written.absPath), jsonPath.split(/[/\\]/u).pop() ?? jsonPath);
  if (existsSync(jsonAbs)) {
    cleanupPartial([written.absPath]);
    return fail('FILENAME_COLLISION', `review JSON already exists: ${jsonPath}`);
  }
  try {
    mkdirSync(dirname(jsonAbs), { recursive: true });
    writeFileSync(jsonAbs, reviewText);
  } catch (error) {
    cleanupPartial([written.absPath]);
    return fail('JSON_WRITE_FAILED', error instanceof Error ? error.message : String(error));
  }

  if (written.size > ENGINEER_GUIDE_EXPORT_MAX_DOCX_BYTES) {
    cleanupPartial([written.absPath, jsonAbs]);
    return fail('FILE_TOO_LARGE', `docx exceeds ${ENGINEER_GUIDE_EXPORT_MAX_DOCX_BYTES} bytes`);
  }
  if (statSync(jsonAbs).size > ENGINEER_GUIDE_EXPORT_MAX_JSON_BYTES) {
    cleanupPartial([written.absPath, jsonAbs]);
    return fail('FILE_TOO_LARGE', `review JSON exceeds ${ENGINEER_GUIDE_EXPORT_MAX_JSON_BYTES} bytes`);
  }

  const officeCli = isOfficeCliAvailable();
  return {
    ok: true,
    caseId: document.caseId,
    caseRevision: document.revision,
    guideRevision: document.guide.revision,
    digest: document.guide.digest,
    readiness: document.guide.readiness,
    draftMarked: banner.draftMarked,
    jsonPath,
    docxPath: written.docxPath,
    jsonDigest: digestFile(jsonAbs),
    docxDigest: digestFile(written.absPath),
    size: written.size,
    validation: await validateOfficeDocument(written.absPath),
    officeCli,
    recomputed: false,
    fieldAccepted: false,
    approvedForWindow: false,
  };
}
