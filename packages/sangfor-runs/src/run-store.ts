import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  expectedLocalWriteScope,
  nowId,
  requireLocalWriteAuthority,
  resolveEngagementScopedData,
  type LocalWriteAuthority,
} from '@sangfor/shared';
import { maskSecrets } from './mask.js';
import { parseBoundaryRunRecordLineV1 } from './runtime-boundaries.js';

export type RunStatus = 'pending_approval' | 'rejected' | 'running' | 'succeeded' | 'failed';
export type RunSafety = 'read_only' | 'write' | 'destructive';

export interface RunApproval {
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly changeTicketId: string;
  readonly rollbackPlanId: string;
  readonly authorityEpoch?: number;
}

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
  approval?: RunApproval;
  rejectedReason?: string;
  playbookId?: string;
  playbookRunId?: string;
  playbookRev?: number;
  blockId?: string;
}

export interface CreateRunInput {
  readonly toolId: string;
  readonly toolSafety: RunSafety;
  readonly args: Record<string, unknown>;
  readonly deviceId?: string;
  readonly sweepId?: string;
  readonly playbookId?: string;
  readonly playbookRunId?: string;
  readonly playbookRev?: number;
  readonly blockId?: string;
  readonly initialStatus: RunStatus;
}

export type RunTransitionPatch = Partial<RunRecord> & { readonly status: RunStatus };
export type AuthorityRunTransitionPatch = Omit<RunTransitionPatch, 'approval'> & {
  readonly approval?: RunApproval & { readonly authorityEpoch: number };
};

export interface ListRunsOptions {
  readonly status?: RunStatus;
  readonly toolId?: string;
  readonly deviceId?: string;
  readonly sweepId?: string;
  readonly playbookRunId?: string;
  readonly sinceDays?: number;
  readonly limit?: number;
}

export interface RunStoreClock {
  now(): Date;
}

const SYSTEM_CLOCK: RunStoreClock = { now: () => new Date() };
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

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((file) => FILE_RE.test(file)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function foldFile(path: string): Map<string, RunRecord> {
  const records = new Map<string, RunRecord>();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return records;
    throw error;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const record = parseBoundaryRunRecordLineV1(line);
    records.set(record.runId, record);
  }
  return records;
}

function getRun(dir: string, runId: string): RunRecord | undefined {
  for (const file of listFiles(dir).slice().reverse()) {
    const hit = foldFile(join(dir, file)).get(runId);
    if (hit) return hit;
  }
  return undefined;
}

function listRuns(dir: string, opts: ListRunsOptions): RunRecord[] {
  const sinceDays = opts.sinceDays ?? 14;
  const limit = opts.limit ?? 100;
  const cutoff = Number.isFinite(sinceDays)
    ? new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)
    : null;
  const records: RunRecord[] = [];
  for (const file of listFiles(dir)) {
    if (cutoff !== null && file.slice(0, 10) < cutoff) continue;
    for (const record of foldFile(join(dir, file)).values()) records.push(record);
  }
  const filtered = records.filter((record) =>
    (!opts.status || record.status === opts.status)
    && (!opts.toolId || record.toolId === opts.toolId)
    && (!opts.deviceId || record.deviceId === opts.deviceId)
    && (!opts.sweepId || record.sweepId === opts.sweepId)
    && (!opts.playbookRunId || record.playbookRunId === opts.playbookRunId));
  filtered.sort((a, b) =>
    a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : a.runId < b.runId ? 1 : -1);
  return filtered.slice(0, limit);
}

export class LegacyRunStoreWriteApiError extends Error {
  readonly name = 'LegacyRunStoreWriteApiError';

  constructor(readonly legacyApi: string) {
    super(`${legacyApi} requires explicit local write authority; use AuthorityRunStore.`);
  }
}

export class RunStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
  }

  createRun(_input: CreateRunInput): RunRecord {
    throw new LegacyRunStoreWriteApiError('RunStore.createRun');
  }

  transition(_runId: string, _patch: RunTransitionPatch): RunRecord {
    throw new LegacyRunStoreWriteApiError('RunStore.transition');
  }

  getRun(runId: string): RunRecord | undefined { return getRun(this.dir, runId); }
  listRuns(opts: ListRunsOptions = {}): RunRecord[] { return listRuns(this.dir, opts); }
  pendingApprovals(): RunRecord[] {
    return this.listRuns({ status: 'pending_approval', sinceDays: Infinity, limit: Infinity });
  }
}

export class AuthorityRunStore {
  private readonly dir: string;
  private readonly authority: LocalWriteAuthority;

  constructor(
    dir: string | undefined,
    authority: LocalWriteAuthority,
    private readonly clock: RunStoreClock = SYSTEM_CLOCK,
  ) {
    this.dir = dir ?? resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority.projectId, 'runs_steps', this.dir,
    ));
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const record: RunRecord = {
      schemaVersion: 1, runId: nowId('run'), toolId: input.toolId, toolSafety: input.toolSafety,
      args: maskSecrets(input.args), status: input.initialStatus, requestedAt: this.clock.now().toISOString(),
    };
    if (input.deviceId) record.deviceId = input.deviceId;
    if (input.sweepId) record.sweepId = input.sweepId;
    if (input.playbookId) record.playbookId = input.playbookId;
    if (input.playbookRunId) record.playbookRunId = input.playbookRunId;
    if (input.playbookRev !== undefined) record.playbookRev = input.playbookRev;
    if (input.blockId) record.blockId = input.blockId;
    await this.authority.fence.write(
      this.authority,
      { operation: 'runs.create', targetPaths: [this.pathFor(record)] },
      () => this.append(record),
    );
    return record;
  }

  async transition(runId: string, patch: AuthorityRunTransitionPatch): Promise<RunRecord> {
    const existing = this.getRun(runId);
    if (!existing) throw new Error(`unknown runId: ${runId}`);
    return this.authority.fence.write(
      this.authority,
      { operation: 'runs.transition', targetPaths: [this.pathFor(existing)] },
      () => {
        const current = this.getRun(runId);
        if (!current) throw new Error(`unknown runId: ${runId}`);
        const next: RunRecord = {
          ...current, ...patch, schemaVersion: 1, runId: current.runId,
          toolId: current.toolId, toolSafety: current.toolSafety, requestedAt: current.requestedAt,
        };
        next.args = maskSecrets(patch.args ?? current.args);
        if ('resultJson' in patch) next.resultJson = capResultJson(maskSecrets(patch.resultJson));
        this.append(next);
        return next;
      },
    );
  }

  getRun(runId: string): RunRecord | undefined { return getRun(this.dir, runId); }
  listRuns(opts: ListRunsOptions = {}): RunRecord[] { return listRuns(this.dir, opts); }
  pendingApprovals(): RunRecord[] {
    return this.listRuns({ status: 'pending_approval', sinceDays: Infinity, limit: Infinity });
  }

  private pathFor(record: Pick<RunRecord, 'requestedAt'>): string {
    return join(this.dir, `${record.requestedAt.slice(0, 10)}.jsonl`);
  }

  private append(record: RunRecord): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.pathFor(record), `${JSON.stringify(record)}\n`);
  }
}
