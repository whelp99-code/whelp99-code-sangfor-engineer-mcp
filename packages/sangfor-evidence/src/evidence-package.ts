/**
 * Customer-facing evidence-package .docx builder (card O3).
 *
 * Built out of the ITAC engagement's one-off 417-line
 * scripts/build_evidence_docx.py (python-docx): cover page, a summary table
 * (ITEM/REQ/verdict/observed + counts per verdict), one section per
 * checklist item with its evidence images embedded, and — when a capture
 * run is supplied — an "증적 무결성" (evidence integrity) section reporting
 * the AuditLedger chain + per-file hash verification.
 *
 * Unlike packages/sangfor-product-adapters/src/docx-builder.ts (hand-rolled
 * OpenXML strings, which is how the w:shd schema bug happened), this module
 * builds the document THROUGH officecli itself (create + batch add), so the
 * output is schema-valid by construction rather than by after-the-fact
 * validation. officecli is therefore a hard dependency of this module (not
 * a best-effort extra) — if it's unavailable, buildEvidencePackage throws;
 * there is no hand-rolled fallback builder here.
 *
 * Data-fidelity rule (same as the python script it replaces): observed/
 * verdict text is used exactly as supplied — never summarized, truncated,
 * or inferred. Missing values are rendered as "미확인" (unconfirmed) or an
 * explicit "(증적 파일 없음)" (no evidence file) marker, never silently
 * dropped or guessed at.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  closeOfficeDocument,
  confineOfficePath,
  createOfficeDocument,
  runOfficeBatch,
  validateOfficeDocument,
  type ValidateOfficeDocumentResult,
} from '@sangfor/office';
import { verifyCaptureLedger, type CaptureLedgerFileCheck } from '@sangfor/screenshot';
import type { AuditLedger } from '@sangfor/hci-client';
import type { GapReportItem } from '@sangfor/audit';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvidencePackageItem {
  itemId: string;
  topic: string;
  reqIds: string[];
  status: string;
  verdict: string;
  observed?: string;
  evidenceFiles?: string[];
}

export interface BuildEvidencePackageInput {
  frameworkId?: string;
  title: string;
  customer: string;
  dateStamp: string;
  items: EvidencePackageItem[];
  /** Optional captureConsoleEvidence runId — when given, a "증적 무결성"
   * section reports the AuditLedger chain + per-file hash verification for
   * that run (see @sangfor/screenshot's verifyCaptureLedger). */
  captureRunId?: string;
  /** Defaults to <engagement evidence root>/packages/<dateStamp>/evidence-package_<dateStamp>.docx. */
  outputPath?: string;
  /** Defaults to false: if outputPath already exists on disk, buildEvidencePackage
   * refuses (OFFICE_FILE_EXISTS) rather than silently overwriting a
   * customer-facing submission. Pass true to explicitly allow regenerating
   * an existing package (e.g. re-running for the same engagement/dateStamp). */
  overwrite?: boolean;
}

export interface EvidenceIntegritySummary {
  runId: string;
  chainOk: boolean;
  allMatch: boolean;
  files: CaptureLedgerFileCheck[];
  /** Set when the ledger had no entries for this runId, or verification
   * itself failed — an honest "could not verify" rather than a silent
   * false-positive allMatch:true. */
  note?: string;
}

export interface BuildEvidencePackageResult {
  outputPath: string;
  itemCount: number;
  verdictCounts: Record<string, number>;
  imagesEmbedded: number;
  imagesMissing: number;
  integrity?: EvidenceIntegritySummary;
  validation: ValidateOfficeDocumentResult;
}

// ─── @sangfor/audit adapter ─────────────────────────────────────────────────

/**
 * Maps @sangfor/audit's GapReportItem[] (the output of
 * sangfor_audit_gap_report / computeGapReport) into EvidencePackageItem[]
 * without touching @sangfor/audit itself. Every field is carried over
 * verbatim — observed/verdict text is never reworded, and evidenceRefs
 * becomes evidenceFiles as-is (the caller is responsible for evidenceRefs
 * being real file paths if it wants images embedded; this adapter does not
 * invent or validate paths).
 */
export function gapReportItemsToEvidenceItems(items: readonly GapReportItem[]): EvidencePackageItem[] {
  return items.map((item) => {
    const out: EvidencePackageItem = {
      itemId: item.itemId,
      topic: item.topic,
      reqIds: item.reqIds,
      status: item.status,
      verdict: item.verdict,
    };
    if (item.observed !== undefined) out.observed = item.observed;
    if (item.evidenceRefs !== undefined) out.evidenceFiles = item.evidenceRefs;
    return out;
  });
}

// ─── officecli batch-command helpers ────────────────────────────────────────

type BatchCommand = Record<string, unknown>;

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// officecli's table `data` prop is CSV-ish: rows separated by ';', cells by
// ',', quote-aware — wrap a cell containing a separator (or a literal quote)
// in double quotes, doubling any quote inside it.
function csvCell(raw: string | undefined): string {
  const value = raw ?? '';
  return /[,;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(cells: Array<string | undefined>): string {
  return cells.map(csvCell).join(',');
}

function csvTable(header: string[], rows: Array<Array<string | undefined>>): string {
  return [csvRow(header), ...rows.map(csvRow)].join(';');
}

function paragraph(props: Record<string, unknown>): BatchCommand {
  return { command: 'add', parent: '/body', type: 'paragraph', props };
}

function pagebreak(): BatchCommand {
  return { command: 'add', parent: '/body', type: 'pagebreak' };
}

function table(data: string): BatchCommand {
  return { command: 'add', parent: '/body', type: 'table', props: { data, style: 'medium2' } };
}

function picture(src: string, alt: string): BatchCommand {
  return { command: 'add', parent: '/body', type: 'picture', props: { src, width: '14cm', alt } };
}

function countByVerdict(items: readonly EvidencePackageItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.verdict || '(빈 값)';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ─── document assembly ───────────────────────────────────────────────────────

function buildCoverCommands(input: BuildEvidencePackageInput): BatchCommand[] {
  const metaLines = [`고객사: ${input.customer}`, `작성일: ${input.dateStamp}`];
  if (input.frameworkId) metaLines.unshift(`프레임워크: ${input.frameworkId}`);
  return [
    paragraph({ text: input.title, style: 'Title', align: 'center', bold: true }),
    paragraph({ text: metaLines.join('\n'), align: 'center' }),
    pagebreak(),
  ];
}

function buildSummaryCommands(items: readonly EvidencePackageItem[], verdictCounts: Record<string, number>): BatchCommand[] {
  const countsLine = Object.entries(verdictCounts).map(([verdict, count]) => `${verdict}: ${count}건`).join(', ');
  const summaryCsv = csvTable(
    ['ITEM', 'REQ', '판정', '실측 요약'],
    items.map((item) => [item.itemId, item.reqIds.join(', '), item.verdict, item.observed ?? '미확인']),
  );
  return [
    paragraph({ text: '요약', style: 'Heading1' }),
    paragraph({ text: `전체 ${items.length}건 — ${countsLine || '해당 없음'}` }),
    table(summaryCsv),
  ];
}

function buildItemCommands(item: EvidencePackageItem, isLast: boolean): { commands: BatchCommand[]; embedded: number; missing: number } {
  const commands: BatchCommand[] = [
    paragraph({ text: `항목 #${item.itemId} — ${item.topic} [${item.verdict}]`, style: 'Heading2' }),
    paragraph({ text: `REQ: ${item.reqIds.join(', ') || '미확인'}` }),
    paragraph({ text: `상태: ${item.status}` }),
    paragraph({ text: `실측: ${item.observed ?? '미확인'}` }),
    paragraph({ text: `판정: ${item.verdict}`, bold: true }),
  ];

  const claimed = item.evidenceFiles ?? [];
  const present = claimed.filter((f) => existsSync(f));
  const missing = claimed.filter((f) => !existsSync(f));

  if (present.length === 0) {
    // P3 fix: when files WERE claimed but none exist, name them — an audit
    // document must never let "what was expected but missing" disappear
    // behind a generic marker (that would read as less complete than the
    // partial-missing branch below, which does list names). Only fall back
    // to the bare marker when no evidence was ever claimed for this item.
    const text = claimed.length > 0
      ? `(증적 파일 없음: ${claimed.map((f) => basename(f)).join(', ')})`
      : '(증적 파일 없음)';
    commands.push(paragraph({ text, bold: true, color: 'C00000' }));
  } else {
    for (const filePath of present) {
      commands.push(picture(filePath, basename(filePath)));
      commands.push(paragraph({ text: basename(filePath), align: 'center', italic: true }));
    }
    if (missing.length > 0) {
      commands.push(paragraph({ text: `(누락된 증적 파일: ${missing.map((f) => basename(f)).join(', ')})`, color: 'C00000' }));
    }
  }

  if (!isLast) commands.push(pagebreak());

  return { commands, embedded: present.length, missing: missing.length };
}

async function buildIntegrityCommands(
  captureRunId: string,
  deps: { ledger?: AuditLedger } = {},
): Promise<{ commands: BatchCommand[]; summary: EvidenceIntegritySummary }> {
  const commands: BatchCommand[] = [pagebreak(), paragraph({ text: '증적 무결성', style: 'Heading1' })];

  let verify: ReturnType<typeof verifyCaptureLedger>;
  try {
    verify = verifyCaptureLedger(captureRunId, deps);
  } catch (error) {
    const note = `캡처 원장 확인 중 오류: ${errMsg(error)}`;
    commands.push(paragraph({ text: note, color: 'C00000' }));
    return { commands, summary: { runId: captureRunId, chainOk: false, allMatch: false, files: [], note } };
  }

  if (verify.files.length === 0) {
    const note = `캡처 원장(runId=${captureRunId})에서 항목을 찾을 수 없음 — 무결성 확인 불가.`;
    commands.push(paragraph({ text: note, color: 'C00000' }));
    return { commands, summary: { runId: captureRunId, chainOk: verify.chainOk, allMatch: false, files: [], note } };
  }

  commands.push(paragraph({
    text: `체인 무결성: ${verify.chainOk ? '정상' : '손상됨'} / 파일 해시 일치: ${verify.allMatch ? '전체 일치' : '불일치 있음'}`,
    bold: !verify.allMatch,
    color: verify.allMatch ? undefined : 'C00000',
  }));
  const integrityCsv = csvTable(
    ['파일', '기록된 해시', '현재 해시', '일치', '비고'],
    verify.files.map((f) => [f.filePath, f.recordedHash ?? '', f.currentHash ?? '', f.match ? 'O' : 'X', f.note ?? '']),
  );
  commands.push(table(integrityCsv));

  return { commands, summary: { runId: captureRunId, chainOk: verify.chainOk, allMatch: verify.allMatch, files: verify.files } };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface BuildEvidencePackageDeps {
  /** Custom AuditLedger for the captureRunId integrity check — tests inject
   * a scratch-dir ledger here instead of touching the real data/evidence
   * ledger (see @sangfor/screenshot's verifyCaptureLedger deps). */
  ledger?: AuditLedger;
}

export async function buildEvidencePackage(
  input: BuildEvidencePackageInput,
  deps: BuildEvidencePackageDeps = {},
): Promise<BuildEvidencePackageResult> {
  const target = input.outputPath ?? join('packages', input.dateStamp, `evidence-package_${input.dateStamp}.docx`);
  const outputPath = confineOfficePath(target);

  const created = await createOfficeDocument(outputPath, 'docx', { overwrite: input.overwrite ?? false });
  if (!created.ok) {
    throw new Error(`EVIDENCE_PACKAGE_CREATE_FAILED: ${created.error ?? 'unknown error'}`);
  }

  const items = input.items;
  const verdictCounts = countByVerdict(items);

  const commands: BatchCommand[] = [
    ...buildCoverCommands(input),
    ...buildSummaryCommands(items, verdictCounts),
  ];
  if (items.length > 0) commands.push(pagebreak());

  let imagesEmbedded = 0;
  let imagesMissing = 0;
  items.forEach((item, idx) => {
    const { commands: itemCommands, embedded, missing } = buildItemCommands(item, idx === items.length - 1);
    commands.push(...itemCommands);
    imagesEmbedded += embedded;
    imagesMissing += missing;
  });

  let integrity: EvidenceIntegritySummary | undefined;
  if (input.captureRunId) {
    const { commands: integrityCommands, summary } = await buildIntegrityCommands(input.captureRunId, deps);
    commands.push(...integrityCommands);
    integrity = summary;
  }

  const batchResult = await runOfficeBatch(outputPath, commands);
  if (!batchResult.ok) {
    throw new Error(`EVIDENCE_PACKAGE_BATCH_FAILED: ${batchResult.error ?? 'unknown error'}`);
  }

  // validateOfficeDocument runs THROUGH officecli, which — like create/batch
  // — opens its own resident on the file as a side effect. So validate must
  // run BEFORE the close below, not after: closing first and validating
  // second would leave a fresh resident open post-return, silently
  // relocking the file for whatever touches it next (a plain fs reader, or
  // a later regeneration's createOfficeDocument, which would then fail with
  // "currently opened by a resident process"). officecli's own reads always
  // see the batch's in-memory edits regardless of resident/flush state, so
  // validating before the flush is still validating the real content.
  const validation = await validateOfficeDocument(outputPath);

  // Flush to disk and release the resident (from batch, and/or from the
  // validate call above) — required before anything outside officecli (the
  // caller, a customer's copy of Word, a later officecli invocation) reads
  // or re-touches the file.
  await closeOfficeDocument(outputPath);

  const result: BuildEvidencePackageResult = {
    outputPath,
    itemCount: items.length,
    verdictCounts,
    imagesEmbedded,
    imagesMissing,
    validation,
  };
  if (integrity) result.integrity = integrity;
  return result;
}
