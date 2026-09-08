/**
 * EngineerReport contract (design 002, block F1).
 *
 * An agent's output about one device snapshot. The engine verdict travels
 * VERBATIM: `engineResult` is the deterministic `evaluateSpec` output, typed
 * deeply readonly so no agent-side code path can rewrite a verdict on its way
 * into the ledger. Everything the model produced — risk note, recommendations,
 * rollback plan — is annotation that sits BESIDE the verdict, never over it.
 */
import type { EvaluationResult } from '@sangfor/spec';
import { parseBoundaryEngineerEvaluationCloneV1 } from './runtime-boundaries.js';

export const ENGINEER_REPORT_SCHEMA_VERSION = 1;

export interface RagCitation {
  chunkId: string;
  filePath: string;
}

export type ReadonlyEvaluationResult = Readonly<{
  specId: EvaluationResult['specId'];
  ok: EvaluationResult['ok'];
  items: readonly Readonly<EvaluationResult['items'][number]>[];
  summary: Readonly<EvaluationResult['summary']>;
  coverage: Readonly<EvaluationResult['coverage']>;
}>;

export interface EngineerReport {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly deviceId: string;
  /** Content address of the snapshot the agent reasoned over (chronicle hash). */
  readonly snapshotHash: string;
  /** Engine-produced verdicts, carried verbatim. Never authored by the agent. */
  readonly engineResult: ReadonlyEvaluationResult;
  readonly riskNote: string;
  readonly recommendations: readonly string[];
  readonly rollbackPlan: readonly string[];
  readonly ragCitations: readonly RagCitation[];
  readonly modelId: string;
  /** sha256 of the exact prompt used — the reproducibility anchor with snapshotHash. */
  readonly promptHash: string;
  readonly createdAt: string;
}

/** Caller-supplied fields; `schemaVersion` is stamped by the package, not the caller. */
export interface EngineerReportInput {
  reportId: string;
  deviceId: string;
  snapshotHash: string;
  engineResult: EvaluationResult;
  riskNote: string;
  recommendations: readonly string[];
  rollbackPlan: readonly string[];
  ragCitations: readonly RagCitation[];
  modelId: string;
  promptHash: string;
  createdAt: string;
}

/** A ledger line: the report plus its position and hash-chain links. */
export interface EngineerReportRecord {
  seq: number;
  prevHash: string;
  hash: string;
  report: EngineerReport;
}

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;

function assertId(field: 'reportId' | 'deviceId', value: string): void {
  // Both ids end up in ledger keys and audit joins; a traversal-shaped or empty
  // id must fail loud rather than silently produce an unaddressable record.
  if (value === '.' || value === '..' || value.includes('..') || !ID_RE.test(value)) {
    throw new Error(`Invalid ${field} "${value}": must match ${ID_RE.source}`);
  }
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${field}: must be a non-empty string`);
  }
}

/** Validate + normalize caller input into an immutable report value. */
export function buildEngineerReport(input: EngineerReportInput): EngineerReport {
  assertId('reportId', input.reportId);
  assertId('deviceId', input.deviceId);
  assertNonEmpty('snapshotHash', input.snapshotHash);
  assertNonEmpty('modelId', input.modelId);
  assertNonEmpty('promptHash', input.promptHash);
  assertNonEmpty('createdAt', input.createdAt);
  if (Number.isNaN(Date.parse(input.createdAt))) {
    throw new Error(`Invalid createdAt "${input.createdAt}": must be an ISO timestamp`);
  }

  // Deep copy: a caller that keeps mutating its EvaluationResult after handing
  // it over must not be able to change what the ledger already committed to.
  const engineResult = parseBoundaryEngineerEvaluationCloneV1(JSON.stringify(input.engineResult));

  return Object.freeze({
    schemaVersion: ENGINEER_REPORT_SCHEMA_VERSION,
    reportId: input.reportId,
    deviceId: input.deviceId,
    snapshotHash: input.snapshotHash,
    engineResult,
    riskNote: input.riskNote,
    recommendations: [...input.recommendations],
    rollbackPlan: [...input.rollbackPlan],
    ragCitations: input.ragCitations.map((c) => ({ chunkId: c.chunkId, filePath: c.filePath })),
    modelId: input.modelId,
    promptHash: input.promptHash,
    createdAt: input.createdAt,
  });
}
