import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, resolveRepoData } from '@sangfor/shared';
import { maskSecrets } from './mask.js';

export type RunStatus = 'pending_approval' | 'rejected' | 'running' | 'succeeded' | 'failed';
export type RunSafety = 'read_only' | 'write' | 'destructive';

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  toolId: string;
  toolSafety: RunSafety;
  args: Record<string, unknown>;
  status: RunStatus;
  requestedAt: string;
  finishedAt?: string;
  durationMs?: number;
  resultSummary?: string;
  resultJson?: unknown;
  error?: string;
  deviceId?: string;
  sweepId?: string;
  approval?: { approvedBy: string; approvedAt: string; changeTicketId: string; rollbackPlanId: string };
  rejectedReason?: string;
}

export interface ListRunsOptions {
  status?: RunStatus;
  toolId?: string;
  deviceId?: string;
  sweepId?: string;
  sinceDays?: number;
  limit?: number;
}

const RESULT_JSON_MAX_CHARS = 500_000;
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function capResultJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    if (JSON.stringify(value).length > RESULT_JSON_MAX_CHARS) {
      return { truncated: true, note: 'result exceeded 500KB' };
    }
  } catch {
    return { truncated: true, note: 'result not serializable' };
  }
  return value;
}

// Append-only snapshot JSONL. One line = a full RunRecord snapshot; the last
// line per runId wins. Every snapshot of a run appends to the SAME date file
// (keyed by requestedAt), so a run lives in exactly one file. Never rewrite
// files — prior snapshots remain for auditability.
export class RunStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT');
  }

  createRun(input: {
    toolId: string;
    toolSafety: RunSafety;
    args: Record<string, unknown>;
    deviceId?: string;
    sweepId?: string;
    initialStatus: RunStatus;
  }): RunRecord {
    const record: RunRecord = {
      schemaVersion: 1,
      runId: nowId('run'),
      toolId: input.toolId,
      toolSafety: input.toolSafety,
      args: maskSecrets(input.args),
      status: input.initialStatus,
      requestedAt: new Date().toISOString(),
    };
    if (input.deviceId) record.deviceId = input.deviceId;
    if (input.sweepId) record.sweepId = input.sweepId;
    this.append(record);
    return record;
  }

  // Persistence-layer masking covers only `args` and `resultJson` (keyed
  // maskSecrets). The store CANNOT scrub `error`/`resultSummary`: it holds only
  // already-masked args ('***'), so it cannot re-derive the real secret values.
  // Callers that set `error` or `resultSummary` MUST value-scrub them first with
  // scrubSecretValues(text, originalArgs) — see apps/control-tower/src/api.ts execute().
  transition(runId: string, patch: Partial<RunRecord> & { status: RunStatus }): RunRecord {
    const current = this.getRun(runId);
    if (!current) throw new Error(`unknown runId: ${runId}`);
    const next: RunRecord = {
      ...current,
      ...patch,
      schemaVersion: 1,
      runId: current.runId,
      toolId: current.toolId,
      toolSafety: current.toolSafety,
      requestedAt: current.requestedAt,
    };
    next.args = maskSecrets(patch.args ?? current.args);
    if ('resultJson' in patch) next.resultJson = capResultJson(maskSecrets(patch.resultJson));
    this.append(next);
    return next;
  }

  getRun(runId: string): RunRecord | undefined {
    for (const file of this.listFiles().slice().reverse()) {
      const hit = this.foldFile(join(this.dir, file)).get(runId);
      if (hit) return hit;
    }
    return undefined;
  }

  listRuns(opts: ListRunsOptions = {}): RunRecord[] {
    const sinceDays = opts.sinceDays ?? 14;
    const limit = opts.limit ?? 100;
    // sinceDays가 유한할 때만 날짜 컷오프. Infinity면 전체 파일 스캔(오버플로우 방지).
    const cutoff = Number.isFinite(sinceDays)
      ? new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)
      : null;
    const records: RunRecord[] = [];
    for (const file of this.listFiles()) {
      if (cutoff !== null && file.slice(0, 10) < cutoff) continue;
      for (const record of this.foldFile(join(this.dir, file)).values()) records.push(record);
    }
    const filtered = records.filter((r) =>
      (!opts.status || r.status === opts.status) &&
      (!opts.toolId || r.toolId === opts.toolId) &&
      (!opts.deviceId || r.deviceId === opts.deviceId) &&
      (!opts.sweepId || r.sweepId === opts.sweepId));
    filtered.sort((a, b) =>
      a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : a.runId < b.runId ? 1 : -1);
    return filtered.slice(0, limit);
  }

  pendingApprovals(): RunRecord[] {
    // A human-approval safety gate must show EVERY pending run, so scan all
    // history with no window and no limit (pending count is normally small).
    return this.listRuns({ status: 'pending_approval', sinceDays: Infinity, limit: Infinity });
  }

  private listFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private foldFile(path: string): Map<string, RunRecord> {
    const out = new Map<string, RunRecord>();
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw error;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as RunRecord;
        if (record && typeof record.runId === 'string') out.set(record.runId, record);
      } catch {
        process.stderr.write(`[runs] skipping unparseable line in ${path}\n`);
      }
    }
    return out;
  }

  private append(record: RunRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${record.requestedAt.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
  }
}
