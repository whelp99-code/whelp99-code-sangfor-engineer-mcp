import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowId, resolveRepoData } from '../../../packages/shared/src/index.js';
import { maskSecrets } from '../../../packages/sangfor-runs/src/index.js';

// ── 플레이북 정의 ────────────────────────────────────────────────────────────
export interface PlaybookBlock {
  id: string;                  // 리비전 내 유일, 템플릿 참조 앵커
  type: 'tool' | 'report';
  title?: string;
  toolId?: string;             // type==='tool' 필수
  args?: Record<string, unknown>;  // 값에 템플릿 문자열 허용 (Task 4)
  deviceId?: string;           // 지정 시 v1 인자 병합 규칙 재사용
}

export interface PlaybookRevision {
  rev: number;
  blocks: PlaybookBlock[];
  authoredBy: string;
  note?: string;
  status: 'draft' | 'approved' | 'rejected';
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectReason?: string;
}

export interface Playbook {
  id: string;
  name: string;
  goal: string;
  revisions: PlaybookRevision[];  // rev 오름차순
  createdAt: string;
  updatedAt: string;
}

// ── AI 분석 아티팩트 ─────────────────────────────────────────────────────────
export type AnalysisVerdict = 'accepted' | 'dismissed';

export interface AnalysisImprovement {
  observation: string;
  evidenceRunId?: string;
  recommendation: string;
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface AnalysisProposal {
  action: string;
  rationale: string;
  linkedPlaybookId?: string;
  verdict?: AnalysisVerdict;
  reviewedBy?: string;
}

export interface PlaybookAnalysis {
  schemaVersion: 1;
  id: string;
  playbookId: string;
  playbookRunId: string;
  summary: string;
  improvements: AnalysisImprovement[];
  proposals: AnalysisProposal[];
  authoredBy: string;
  createdAt: string;
}

// ── 에이전트 작업 큐 ─────────────────────────────────────────────────────────
export type AgentTaskKind = 'assemble' | 'revise' | 'analyze';

export interface AgentTask {
  id: string;
  kind: AgentTaskKind;
  payload: { goal?: string; playbookId?: string; playbookRunId?: string; feedback?: string };
  status: 'open' | 'done' | 'cancelled';
  result?: { playbookId?: string; rev?: number; analysisId?: string; note?: string };
  createdAt: string;
  closedAt?: string;
}

// status를 실어 api 계층이 400/404/409로 매핑 (RegistryValidationError는 항상 400이었지만
// 플레이북은 상태기계 위반=409, 미존재=404를 구분해야 한다).
export class PlaybookValidationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

// create/addRevision 시 fail-closed 검증.
export function validateBlocks(blocks: PlaybookBlock[]): void {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new PlaybookValidationError('blocks는 비어있을 수 없습니다');
  }
  const seen = new Set<string>();
  let reportCount = 0;
  for (const b of blocks) {
    if (!b.id?.trim()) throw new PlaybookValidationError('block.id는 필수입니다');
    if (seen.has(b.id)) throw new PlaybookValidationError(`중복 block.id: ${b.id}`);
    seen.add(b.id);
    if (b.type === 'tool') {
      if (!b.toolId?.trim()) throw new PlaybookValidationError(`tool 블록 '${b.id}'에 toolId가 없습니다`);
    } else if (b.type === 'report') {
      if (b.toolId !== undefined || b.args !== undefined) {
        throw new PlaybookValidationError(`report 블록 '${b.id}'에는 toolId/args를 둘 수 없습니다`);
      }
      reportCount += 1;
    } else {
      throw new PlaybookValidationError(`알 수 없는 block.type: ${String((b as PlaybookBlock).type)}`);
    }
  }
  if (reportCount > 1) throw new PlaybookValidationError('report 블록은 최대 1개입니다');
}

function maskBlocks(blocks: PlaybookBlock[]): PlaybookBlock[] {
  return blocks.map((b) => (b.args ? { ...b, args: maskSecrets(b.args) } : b));
}

export class PlaybookStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.path = join(this.dir, 'playbooks.json');
  }

  list(): Playbook[] { return this.load(); }
  get(id: string): Playbook | undefined { return this.load().find((p) => p.id === id); }

  create(input: { name: string; goal: string; blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook {
    validateBlocks(input.blocks);
    const now = new Date().toISOString();
    const pb: Playbook = {
      id: nowId('pb'), name: input.name, goal: input.goal,
      revisions: [{ rev: 1, blocks: maskBlocks(input.blocks), authoredBy: input.authoredBy, note: input.note, status: 'draft', createdAt: now }],
      createdAt: now, updatedAt: now,
    };
    this.save([...this.load(), pb]);
    return pb;
  }

  addRevision(id: string, input: { blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Playbook {
    validateBlocks(input.blocks);
    const pbs = this.load();
    const pb = pbs.find((p) => p.id === id);
    if (!pb) throw new PlaybookValidationError(`unknown playbook: ${id}`, 404);
    const nextRev = Math.max(...pb.revisions.map((r) => r.rev)) + 1;
    pb.revisions.push({ rev: nextRev, blocks: maskBlocks(input.blocks), authoredBy: input.authoredBy, note: input.note, status: 'draft', createdAt: new Date().toISOString() });
    pb.updatedAt = new Date().toISOString();
    this.save(pbs);
    return pb;
  }

  reviewRevision(id: string, rev: number, verdict: { approve: boolean; reviewedBy: string; rejectReason?: string }): Playbook {
    const pbs = this.load();
    const pb = pbs.find((p) => p.id === id);
    if (!pb) throw new PlaybookValidationError(`unknown playbook: ${id}`, 404);
    const r = pb.revisions.find((x) => x.rev === rev);
    if (!r) throw new PlaybookValidationError(`unknown revision: ${rev}`, 404);
    if (r.status !== 'draft') throw new PlaybookValidationError(`리비전이 draft가 아닙니다: ${r.status}`, 409);
    if (!verdict.reviewedBy?.trim()) throw new PlaybookValidationError('reviewedBy는 필수입니다');
    if (!verdict.approve && !verdict.rejectReason?.trim()) throw new PlaybookValidationError('반려 사유(rejectReason)는 필수입니다');
    r.status = verdict.approve ? 'approved' : 'rejected';
    r.reviewedBy = verdict.reviewedBy;
    r.reviewedAt = new Date().toISOString();
    if (!verdict.approve) r.rejectReason = verdict.rejectReason!.trim();
    pb.updatedAt = new Date().toISOString();
    this.save(pbs);
    return pb;
  }

  activeRevision(pb: Playbook): PlaybookRevision | undefined {
    return pb.revisions.filter((r) => r.status === 'approved').sort((a, b) => b.rev - a.rev)[0];
  }

  private load(): Playbook[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Playbook[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error; // corrupt store must fail loud
    }
  }

  private save(pbs: Playbook[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pbs, null, 2));
    renameSync(tmp, this.path);
  }
}

const ANALYSIS_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// RunStore와 같은 append-only 스냅샷 JSONL. id별 last-wins fold. verdict 갱신은
// createdAt를 보존한 새 스냅샷을 같은 날짜 파일에 append (RunStore.transition과 동형).
export class AnalysisStore {
  private readonly dir: string;

  constructor(dir?: string) {
    const root = dir ?? resolveRepoData('data/runs', 'SANGFOR_RUNS_ROOT');
    this.dir = join(root, 'analyses');
  }

  append(analysis: PlaybookAnalysis): PlaybookAnalysis {
    const record: PlaybookAnalysis = maskSecrets({
      ...analysis,
      schemaVersion: 1,
      id: analysis.id ?? nowId('anl'),
      createdAt: analysis.createdAt ?? new Date().toISOString(),
    });
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${record.createdAt.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`);
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

  setVerdict(
    id: string, part: 'improvements' | 'proposals', index: number,
    verdict: AnalysisVerdict, reviewedBy: string, linkedPlaybookId?: string,
  ): PlaybookAnalysis {
    const current = this.get(id);
    if (!current) throw new PlaybookValidationError(`unknown analysis: ${id}`, 404);
    const arr = current[part];
    if (index < 0 || index >= arr.length) throw new PlaybookValidationError(`${part}[${index}] 범위 밖`, 400);
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
        try {
          const rec = JSON.parse(line) as PlaybookAnalysis;
          if (rec && typeof rec.id === 'string') out.set(rec.id, rec);
        } catch {
          process.stderr.write(`[analyses] skipping unparseable line in ${file}\n`);
        }
      }
    }
    return out;
  }
}

// registry 패턴: 전체 JSON, atomic write.
export class AgentTaskStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(dir?: string) {
    this.dir = dir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
    this.path = join(this.dir, 'agent-tasks.json');
  }

  list(status?: AgentTask['status']): AgentTask[] {
    const all = this.load();
    return status ? all.filter((t) => t.status === status) : all;
  }

  create(input: { kind: AgentTaskKind; payload: AgentTask['payload'] }): AgentTask {
    const task: AgentTask = {
      id: nowId('atask'), kind: input.kind, payload: maskSecrets(input.payload ?? {}),
      status: 'open', createdAt: new Date().toISOString(),
    };
    this.save([...this.load(), task]);
    return task;
  }

  close(id: string, result: AgentTask['result']): AgentTask {
    return this.transition(id, (t) => {
      t.status = 'done';
      t.result = maskSecrets(result ?? {});
      t.closedAt = new Date().toISOString();
    });
  }

  cancel(id: string): AgentTask {
    return this.transition(id, (t) => {
      t.status = 'cancelled';
      t.closedAt = new Date().toISOString();
    });
  }

  private transition(id: string, mutate: (t: AgentTask) => void): AgentTask {
    const tasks = this.load();
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new PlaybookValidationError(`unknown agent-task: ${id}`, 404);
    if (t.status !== 'open') throw new PlaybookValidationError(`task가 open이 아닙니다: ${t.status}`, 409);
    mutate(t);
    this.save(tasks);
    return t;
  }

  private load(): AgentTask[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as AgentTask[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private save(tasks: AgentTask[]): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2));
    renameSync(tmp, this.path);
  }
}
