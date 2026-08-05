import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLedger, maskSecrets } from '@sangfor/hci-client';
import { resolveRepoData } from '@sangfor/shared';

// Path-segment safety for runId, same precedent as the product/version segment
// guard in packages/sangfor-spec/src/index.ts:137-190 (isSafeSpecPathSegment) —
// runId flows straight into a filesystem path (AuditLedger.pathFor, the
// screenshot scan below), so it must never carry a separator or traversal token.
const MAX_RUN_ID_LENGTH = 128;
const SAFE_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

export function isSafeRunId(value: unknown): value is string {
  return typeof value === 'string'
    && value === value.trim()
    && value !== '.'
    && value !== '..'
    && [...value].length <= MAX_RUN_ID_LENGTH
    && SAFE_RUN_ID_RE.test(value);
}

type LedgerKind = 'request' | 'response' | 'state' | 'verdict';

interface LedgerLine {
  seq: number;
  at: string;
  runId: string;
  kind: LedgerKind;
  payload: unknown;
  prevHash: string;
  hash: string;
  keyed: boolean;
}

function readLedgerLines(path: string): LedgerLine[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerLine);
}

function payloadField(payload: unknown, key: string): unknown {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

function summarizeStep(kind: LedgerKind, payload: unknown): string {
  if (kind === 'state') {
    const state = payloadField(payload, 'state');
    const detail = payloadField(payload, 'detail');
    return `${typeof state === 'string' ? state : 'STATE'}${typeof detail === 'string' ? ` — ${detail}` : ''}`;
  }
  if (kind === 'request') {
    const op = payloadField(payload, 'op');
    return `request: ${typeof op === 'string' ? op : JSON.stringify(payload).slice(0, 120)}`;
  }
  if (kind === 'response') {
    const status = payloadField(payload, 'status');
    return `response: status=${status ?? '?'}`;
  }
  // 'verdict' — read-back / validation results carry no fixed shape (see
  // ReadBackResult), so fall back to a bounded JSON preview.
  return `verdict: ${JSON.stringify(payload).slice(0, 200)}`;
}

// Best-effort recursive scan for evidence files whose name references this
// runId (e.g. screenshots dropped under data/evidence/<runId>/...). Read-only;
// symlinks are skipped so this never follows a link outside the evidence tree.
function findRelatedFiles(evidenceRoot: string, runId: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.includes(runId)) found.push(full);
    }
  };
  walk(evidenceRoot);
  return found.sort();
}

export interface ChangeRunStep {
  seq: number;
  at: string;
  kind: LedgerKind;
  summary: string;
}

export interface ChangeRunVerificationEntry {
  seq: number;
  at: string;
  payload: unknown;
}

export interface ChangeRunChainStatus {
  ok: boolean;
  keyed: boolean;
  brokenAt?: number;
}

export interface ChangeRunReportJson {
  runId: string;
  found: boolean;
  overview: {
    runId: string;
    startedAt: string | null;
    endedAt: string | null;
    target: string | null;
    stepCount: number;
  };
  steps: ChangeRunStep[];
  verification: ChangeRunVerificationEntry[];
  chain: ChangeRunChainStatus;
  screenshots: string[];
}

export interface ChangeRunReport {
  markdown: string;
  json: ChangeRunReportJson;
}

/**
 * Build a session/change-run work report (overview, step timeline, read-back
 * verification, hash-chain integrity, related evidence files) from the
 * change-run audit ledger. Pure function — never writes to disk. `ledgerRoot`
 * is the data/evidence root (the parent of change-runs/), matching
 * AuditLedger's own default so a caller can point this at a fixture directory.
 */
export function buildChangeRunReport(input: { runId: string; ledgerRoot?: string }): ChangeRunReport {
  if (!isSafeRunId(input.runId)) {
    throw new Error(`INVALID_RUN_ID: "${String(input.runId)}" is not a safe path segment.`);
  }
  const evidenceRoot = input.ledgerRoot ?? resolveRepoData('data/evidence', 'SANGFOR_EVIDENCE_ROOT');
  const ledger = new AuditLedger({ dir: join(evidenceRoot, 'change-runs') });
  // Defense in depth: AuditLedger.append already masks secret-bearing fields
  // at write time, but this render path re-applies the identical rule
  // (password|secret|token|authorization|cookie key -> '***') before any
  // payload reaches the rendered report, so a hypothetical write-side gap
  // (or a raw/tampered ledger line) still never surfaces a raw secret here.
  const lines = readLedgerLines(ledger.pathFor(input.runId)).map((l) => ({ ...l, payload: maskSecrets(l.payload) }));
  const found = lines.length > 0;

  const steps: ChangeRunStep[] = lines.map((l) => ({ seq: l.seq, at: l.at, kind: l.kind, summary: summarizeStep(l.kind, l.payload) }));
  const verification: ChangeRunVerificationEntry[] = lines
    .filter((l) => l.kind === 'verdict')
    .map((l) => ({ seq: l.seq, at: l.at, payload: l.payload }));

  const firstState = lines.find((l) => l.kind === 'state');
  const firstRequest = lines.find((l) => l.kind === 'request');
  const targetCandidate = payloadField(firstState?.payload, 'detail') ?? payloadField(firstRequest?.payload, 'op');
  const target = typeof targetCandidate === 'string' ? targetCandidate : null;

  const chain = ledger.verify(input.runId);
  const screenshots = findRelatedFiles(evidenceRoot, input.runId);

  const json: ChangeRunReportJson = {
    runId: input.runId,
    found,
    overview: {
      runId: input.runId,
      startedAt: lines[0]?.at ?? null,
      endedAt: lines.at(-1)?.at ?? null,
      target,
      stepCount: lines.length,
    },
    steps,
    verification,
    chain,
    screenshots,
  };

  const markdown = [
    `# Change Run Report — ${input.runId}`,
    ``,
    `## Overview`,
    `- Run ID: ${input.runId}`,
    `- Found: ${found ? 'yes' : 'no (no ledger entries at this path)'}`,
    `- Started: ${json.overview.startedAt ?? 'n/a'}`,
    `- Ended: ${json.overview.endedAt ?? 'n/a'}`,
    `- Target: ${json.overview.target ?? 'n/a'}`,
    `- Steps: ${json.overview.stepCount}`,
    ``,
    `## Step Timeline`,
    ...(steps.length ? steps.map((s) => `- [${s.seq}] ${s.at} (${s.kind}): ${s.summary}`) : ['- (no steps recorded)']),
    ``,
    `## Read-back / Verification`,
    ...(verification.length ? verification.map((v) => `- [${v.seq}] ${v.at}: ${JSON.stringify(v.payload)}`) : ['- (no verdict entries recorded)']),
    ``,
    `## Chain Integrity`,
    `- ok: ${chain.ok}`,
    `- keyed: ${chain.keyed}${chain.keyed ? '' : ' (unkeyed chain — set SANGFOR_CHANGE_LEDGER_SECRET for a tamper-evident chain)'}`,
    ...(chain.brokenAt !== undefined ? [`- brokenAt: seq ${chain.brokenAt}`] : []),
    ``,
    `## Related Evidence Files`,
    ...(screenshots.length ? screenshots.map((p) => `- ${p}`) : ['- (none found under data/evidence/)']),
    ``,
  ].join('\n');

  return { markdown, json };
}

/** List change-run ids that have a ledger file, for a runId-less discovery call. */
export function listChangeRunIds(ledgerRoot?: string): string[] {
  const dir = join(ledgerRoot ?? resolveRepoData('data/evidence', 'SANGFOR_EVIDENCE_ROOT'), 'change-runs');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name.slice(0, -'.jsonl'.length))
    .sort();
}
