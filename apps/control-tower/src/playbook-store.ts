import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, expectedLocalWriteScope, requireLocalWriteAuthority, resolveEngagementScopedData, resolveRepoData, withDirLock, writeFileAtomicSync, type LocalWriteAuthority } from '../../../packages/shared/src/index.js';
import { maskSecrets } from '../../../packages/sangfor-runs/src/index.js';
import {
  parseBoundaryControlTowerAgentTasksV1,
  parseBoundaryControlTowerAnalysisLineV1,
  parseBoundaryControlTowerPlaybooksV1,
} from './runtime-boundaries.js';
import { activeApprovedRevision, nextRevisionNumber, parseReviewVerdict, type ReviewVerdictInput } from './playbook-review.js';
import type { AgentTask, AgentTaskKind, AnalysisProposal, AnalysisVerdict, Playbook, PlaybookAnalysis, PlaybookBlock, PlaybookRevision } from './playbook-types.js';
import { maskBlocks, PlaybookValidationError, validateBlocks } from './playbook-validation.js';

export type { AgentTask, AgentTaskKind, AnalysisImprovement, AnalysisProposal, AnalysisVerdict, Playbook, PlaybookAnalysis, PlaybookBlock, PlaybookRevision } from './playbook-types.js';
export { PlaybookValidationError, validateBlocks } from './playbook-validation.js';

export class PlaybookStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly authority: LocalWriteAuthority;

  constructor(dir: string | undefined, authority: LocalWriteAuthority) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.path = join(this.dir, 'playbooks.json');
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'registry_services', this.dir,
    ));
  }

  private fenced<T>(operation: string, write: () => T): Promise<T> {
    return this.authority.fence.write(this.authority, { operation, targetPaths: [this.path] }, write);
  }

  list(): Playbook[] { return this.load(); }
  get(id: string): Playbook | undefined { return this.load().find((p) => p.id === id); }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  async create(input: { name: string; goal: string; blocks: PlaybookBlock[]; authoredBy: string; note?: string; seedKey?: string }): Promise<Playbook> {
    validateBlocks(input.blocks);
    return this.fenced('playbooks.create', () => withDirLock(this.lockPath, () => {
      const now = new Date().toISOString();
      const pb: Playbook = {
        id: nowId('pb'), name: input.name, goal: input.goal,
        revisions: [{ rev: 1, blocks: maskBlocks(input.blocks), authoredBy: input.authoredBy, note: input.note, status: 'draft', createdAt: now }],
        createdAt: now, updatedAt: now,
        ...(input.seedKey ? { seedKey: input.seedKey } : {}),
      };
      this.save([...this.load(), pb]);
      return pb;
    }));
  }

  async addRevision(id: string, input: { blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Promise<Playbook> {
    validateBlocks(input.blocks);
    return this.fenced('playbooks.add-revision', () => withDirLock(this.lockPath, () => {
      const pbs = this.load();
      const pb = pbs.find((p) => p.id === id);
      if (!pb) throw new PlaybookValidationError(`unknown playbook: ${id}`, 404);
      const nextRev = nextRevisionNumber(pb.revisions);
      pb.revisions.push({ rev: nextRev, blocks: maskBlocks(input.blocks), authoredBy: input.authoredBy, note: input.note, status: 'draft', createdAt: new Date().toISOString() });
      pb.updatedAt = new Date().toISOString();
      this.save(pbs);
      return pb;
    }));
  }

  async reviewRevision(id: string, rev: number, verdict: ReviewVerdictInput): Promise<Playbook> {
    return this.fenced('playbooks.review-revision', () => withDirLock(this.lockPath, () => {
      const pbs = this.load();
      const pb = pbs.find((p) => p.id === id);
      if (!pb) throw new PlaybookValidationError(`unknown playbook: ${id}`, 404);
      const r = pb.revisions.find((x) => x.rev === rev);
      if (!r) throw new PlaybookValidationError(`unknown revision: ${rev}`, 404);
      if (r.status !== 'draft') throw new PlaybookValidationError(`리비전이 draft가 아닙니다: ${r.status}`, 409);
      const decision = parseReviewVerdict(verdict);
      r.status = decision.approve ? 'approved' : 'rejected';
      r.reviewedBy = decision.reviewedBy;
      r.reviewedAt = new Date().toISOString();
      if (!decision.approve) r.rejectReason = decision.rejectReason;
      pb.updatedAt = new Date().toISOString();
      this.save(pbs);
      return pb;
    }));
  }

  activeRevision(pb: Playbook): PlaybookRevision | undefined {
    return activeApprovedRevision(pb.revisions);
  }

  private load(): Playbook[] {
    try {
      return parseBoundaryControlTowerPlaybooksV1(readFileSync(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error; // corrupt store must fail loud
    }
  }

  private save(pbs: Playbook[]): void {
    writeFileAtomicSync(this.path, JSON.stringify(pbs, null, 2));
  }
}

const ANALYSIS_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// RunStore와 같은 append-only 스냅샷 JSONL. id별 last-wins fold. verdict 갱신은
// createdAt를 보존한 새 스냅샷을 같은 날짜 파일에 append (RunStore.transition과 동형).
export class AnalysisStore {
  private readonly dir: string;
  private readonly authority: LocalWriteAuthority;

  constructor(dir: string | undefined, authority: LocalWriteAuthority) {
    // Engagement-scoped, matching RunStore: both write under data/runs, so an
    // unscoped root here would split one project's runs across two partitions.
    const root = dir ?? resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
    this.dir = join(root, 'analyses');
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'runs_steps', root,
    ));
  }

  async append(analysis: PlaybookAnalysis): Promise<PlaybookAnalysis> {
    const record: PlaybookAnalysis = maskSecrets({
      ...analysis,
      schemaVersion: 1,
      id: analysis.id ?? nowId('anl'),
      createdAt: analysis.createdAt ?? new Date().toISOString(),
    });
    const target = join(this.dir, `${record.createdAt.slice(0, 10)}.jsonl`);
    await this.authority.fence.write(this.authority, { operation: 'analyses.append', targetPaths: [target] }, () => {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(target, `${JSON.stringify(record)}\n`);
    });
    return record;
  }

  get(id: string): PlaybookAnalysis | undefined {
    return this.foldAll().get(id);
  }

  listByRun(playbookRunId: string): PlaybookAnalysis[] {
    return [...this.foldAll().values()]
      .filter((a) => a.playbookRunId === playbookRunId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async setVerdict(
    id: string, part: 'improvements' | 'proposals', index: number,
    verdict: AnalysisVerdict, reviewedBy: string, linkedPlaybookId?: string,
  ): Promise<PlaybookAnalysis> {
    const current = this.get(id);
    if (!current) throw new PlaybookValidationError(`unknown analysis: ${id}`, 404);
    const arr = current[part];
    if (!Number.isInteger(index) || index < 0 || index >= arr.length) throw new PlaybookValidationError(`${part}[${index}] 범위 밖`, 400);
    arr[index].verdict = verdict;
    arr[index].reviewedBy = reviewedBy;
    if (part === 'proposals' && linkedPlaybookId) (arr[index] as AnalysisProposal).linkedPlaybookId = linkedPlaybookId;
    return this.append(current); // createdAt 보존 → 같은 날짜 파일, last-wins
  }

  private foldAll(): Map<string, PlaybookAnalysis> {
    const out = new Map<string, PlaybookAnalysis>();
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => ANALYSIS_FILE_RE.test(f)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw error;
    }
    for (const file of files) {
      const raw = readFileSync(join(this.dir, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const record = parseBoundaryControlTowerAnalysisLineV1(line);
        out.set(record.id, record);
      }
    }
    return out;
  }
}

// registry 패턴: 전체 JSON, atomic write.
export class AgentTaskStore {
  private readonly dir: string;
  private readonly path: string;
  private readonly authority: LocalWriteAuthority;

  constructor(dir: string | undefined, authority: LocalWriteAuthority) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.path = join(this.dir, 'agent-tasks.json');
    this.authority = requireLocalWriteAuthority(authority, expectedLocalWriteScope(
      authority, authority?.projectId ?? '', 'pm_tasks', this.dir,
    ));
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  list(status?: AgentTask['status']): AgentTask[] {
    const all = this.load();
    return status ? all.filter((t) => t.status === status) : all;
  }

  async create(input: { kind: AgentTaskKind; payload: AgentTask['payload'] }): Promise<AgentTask> {
    return this.authority.fence.write(this.authority, { operation: 'agent-tasks.create', targetPaths: [this.path] }, () => withDirLock(this.lockPath, () => {
      const task: AgentTask = {
        id: nowId('atask'), kind: input.kind, payload: maskSecrets(input.payload ?? {}),
        status: 'open', createdAt: new Date().toISOString(),
      };
      this.save([...this.load(), task]);
      return task;
    }));
  }

  async close(id: string, result: AgentTask['result']): Promise<AgentTask> {
    return this.transition(id, (t) => {
      t.status = 'done';
      t.result = maskSecrets(result ?? {});
      t.closedAt = new Date().toISOString();
    });
  }

  async cancel(id: string): Promise<AgentTask> {
    return this.transition(id, (t) => {
      t.status = 'cancelled';
      t.closedAt = new Date().toISOString();
    });
  }

  private async transition(id: string, mutate: (t: AgentTask) => void): Promise<AgentTask> {
    return this.authority.fence.write(this.authority, { operation: 'agent-tasks.transition', targetPaths: [this.path] }, () => withDirLock(this.lockPath, () => {
      const tasks = this.load();
      const t = tasks.find((x) => x.id === id);
      if (!t) throw new PlaybookValidationError(`unknown agent-task: ${id}`, 404);
      if (t.status !== 'open') throw new PlaybookValidationError(`task가 open이 아닙니다: ${t.status}`, 409);
      mutate(t);
      this.save(tasks);
      return t;
    }));
  }

  private load(): AgentTask[] {
    try {
      return parseBoundaryControlTowerAgentTasksV1(readFileSync(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private save(tasks: AgentTask[]): void {
    writeFileAtomicSync(this.path, JSON.stringify(tasks, null, 2));
  }
}
