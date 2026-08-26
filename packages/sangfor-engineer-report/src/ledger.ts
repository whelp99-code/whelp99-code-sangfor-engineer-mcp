/**
 * Hash-chained EngineerReport ledger (design 002, block F1).
 *
 * One append-only JSONL file per ledger directory. Each line is a record whose
 * `hash` is sha256 over `prevHash|seq|canonical(report)`, so editing any
 * committed field — above all a verdict — invalidates that record and every
 * record after it. Appends run under a directory lock and rewrite the file
 * atomically (read-modify-write), so a concurrent writer can neither interleave
 * a partial line nor fork the chain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expectedLocalWriteScope, requireLocalWriteAuthority, withDirLock, writeFileAtomicSync, type LocalWriteAuthority } from '@sangfor/shared';
import { canonicalJson } from './canonical.js';
import { buildEngineerReport, type EngineerReport, type EngineerReportInput, type EngineerReportRecord } from './report.js';

export const GENESIS = 'GENESIS';
const LEDGER_FILE = 'engineer-reports.jsonl';
const LOCK_DIR = 'engineer-reports.lock';

/** The exact string hashed for a ledger record. Exported so verifiers (and tests) recompute, never trust. */
export function canonicalReportPreimage(prevHash: string, report: EngineerReport): string {
  return `${prevHash}|${canonicalJson(report)}`;
}

function hashRecord(prevHash: string, report: EngineerReport): string {
  return createHash('sha256').update(canonicalReportPreimage(prevHash, report)).digest('hex');
}

function ledgerPath(dir: string): string {
  return join(dir, LEDGER_FILE);
}

function readRecords(dir: string): EngineerReportRecord[] {
  const path = ledgerPath(dir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const records: EngineerReportRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // A malformed line is tampering or truncation, not something to skip past:
    // silently dropping it would let a deletion pass verification.
    records.push(JSON.parse(trimmed) as EngineerReportRecord);
  }
  return records;
}

export interface AppendEngineerReportResult {
  report: EngineerReport;
  record: EngineerReportRecord;
}

/** Validate, chain and durably append one report. Returns the committed record. */
export async function appendEngineerReport(
  dir: string,
  input: EngineerReportInput,
  injectedAuthority: LocalWriteAuthority,
): Promise<AppendEngineerReportResult> {
  const report = buildEngineerReport(input);
  const authority = requireLocalWriteAuthority(injectedAuthority, expectedLocalWriteScope(
    injectedAuthority, injectedAuthority?.projectId ?? '', 'evidence', dir,
  ));
  return authority.fence.write(authority, { operation: 'engineer-report.append', targetPaths: [ledgerPath(dir)] }, () => withDirLock(join(dir, LOCK_DIR), () => {
    const records = readRecords(dir);
    const head = records.at(-1);
    const prevHash = head ? head.hash : GENESIS;
    const record: EngineerReportRecord = {
      seq: records.length + 1,
      prevHash,
      hash: hashRecord(prevHash, report),
      report,
    };
    const serialized = [...records, record].map((r) => canonicalJson(r)).join('\n');
    writeFileAtomicSync(ledgerPath(dir), `${serialized}\n`);
    return { report, record };
  }));
}

/** All committed records, oldest first. */
export function listEngineerReportRecords(dir: string): EngineerReportRecord[] {
  return readRecords(dir);
}

/** All committed reports, oldest first. */
export function listEngineerReports(dir: string): EngineerReport[] {
  return readRecords(dir).map((r) => r.report);
}

export interface VerifyReportChainResult {
  ok: boolean;
  length: number;
  /** 1-based position of the first record that failed verification. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Recompute the whole chain. Detects an edited field (hash mismatch), a removed
 * or reordered record (prevHash link break, seq mismatch) and a corrupted line.
 */
export function verifyReportChain(dir: string): VerifyReportChainResult {
  let records: EngineerReportRecord[];
  try {
    records = readRecords(dir);
  } catch (error) {
    return { ok: false, length: 0, brokenAt: 1, reason: `unparseable ledger line: ${(error as Error).message}` };
  }

  let prevHash = GENESIS;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const position = i + 1;
    if (record.seq !== position) {
      return { ok: false, length: records.length, brokenAt: position, reason: `seq ${record.seq} at position ${position}` };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, length: records.length, brokenAt: position, reason: `prevHash link broken at position ${position}` };
    }
    const expected = hashRecord(record.prevHash, record.report);
    if (record.hash !== expected) {
      return { ok: false, length: records.length, brokenAt: position, reason: `hash mismatch at position ${position}` };
    }
    prevHash = record.hash;
  }
  return { ok: true, length: records.length };
}
