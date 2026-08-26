import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProductionLocalWriteAuthority, resolveEngagementScopedData } from '../../shared/src/index.js';
import { AuditLedger } from '../../sangfor-hci-client/src/index.js';
import { sha256File } from './console-evidence-paths.js';
import type {
  CaptureLedgerFileCheck,
  VerifyCaptureLedgerResult,
} from './console-evidence-types.js';

interface RawLedgerLine {
  seq: number;
  kind: string;
  payload: unknown;
  prevHash: string;
  hash: string;
  keyed: boolean;
}

function readLedgerLines(ledger: AuditLedger, runId: string): RawLedgerLine[] {
  try {
    const raw = readFileSync(ledger.pathFor(runId), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function ledgerDigest(
  secret: string | undefined,
  prevHash: string,
  seq: number,
  kind: string,
  payload: unknown,
): string {
  const material = `${prevHash}\n${seq}\n${kind}\n${JSON.stringify(payload)}`;
  return secret
    ? createHmac('sha256', secret).update(material).digest('hex')
    : createHash('sha256').update(material).digest('hex');
}

function verifyChainFromLines(
  lines: RawLedgerLine[],
  secret: string | undefined,
): boolean {
  let prevHash = 'GENESIS';
  for (const [index, line] of lines.entries()) {
    const expected = ledgerDigest(secret, prevHash, line.seq, line.kind, line.payload);
    if (
      line.seq !== index
      || line.prevHash !== prevHash
      || line.hash !== expected
    ) return false;
    prevHash = line.hash;
  }
  return true;
}

function isCapturePayloadShape(
  payload: unknown,
): payload is { filePath: string; sha256: string | null } {
  if (typeof payload !== 'object' || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return typeof value.filePath === 'string'
    && (typeof value.sha256 === 'string' || value.sha256 === null);
}

export function verifyCaptureLedger(
  runId: string,
  deps: { ledger?: AuditLedger; secret?: string } = {},
): VerifyCaptureLedgerResult {
  const ledgerRoot = join(resolveEngagementScopedData('data/evidence'), 'change-runs');
  const ledger = deps.ledger ?? new AuditLedger({ authority: resolveProductionLocalWriteAuthority({
    tenantId: 'local-primary', projectId: process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary', actorId: 'screenshot-verifier',
    aggregate: 'audit', sourceRoot: ledgerRoot,
  }) });
  const secret = deps.secret ?? process.env.SANGFOR_CHANGE_LEDGER_SECRET;
  const lines = readLedgerLines(ledger, runId);
  const chainOk = verifyChainFromLines(lines, secret);
  const files: CaptureLedgerFileCheck[] = lines.map((line) => {
    if (!isCapturePayloadShape(line.payload)) {
      const value = line.payload as Record<string, unknown> | null;
      const filePath = typeof value?.filePath === 'string' ? value.filePath : '';
      return {
        filePath,
        recordedHash: null,
        currentHash: null,
        match: false,
        note: 'LEDGER_SHAPE_UNEXPECTED',
      };
    }
    const { filePath, sha256: recordedHash } = line.payload;
    let currentHash: string | null = null;
    try {
      currentHash = sha256File(filePath);
    } catch {
      currentHash = null;
    }
    return {
      filePath,
      recordedHash,
      currentHash,
      match: recordedHash !== null
        && currentHash !== null
        && recordedHash === currentHash,
    };
  });
  return {
    runId,
    chainOk,
    files,
    allMatch: chainOk && files.every((file) => file.match),
  };
}
