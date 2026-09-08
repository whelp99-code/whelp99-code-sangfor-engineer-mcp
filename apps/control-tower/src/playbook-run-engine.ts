import type { RunRecord, RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import { safetyOf, type BridgeTool } from './bridge-client.js';
import { mergeDeviceArgs, applyMockCredentialFallback } from './registry.js';
import { resolveTemplates, derivePlaybookRunStatus, TemplateError, type PlaybookRunStatus } from './playbook-engine.js';
import type { Playbook, PlaybookBlock, PlaybookRevision } from './playbook-store.js';
import { ApiError } from './tower-contract.js';
import type { TowerStores } from './tower-stores.js';
import type { BridgeRunner } from './tower-bridge-runner.js';

export const PB_LIMIT = { sinceDays: Infinity, limit: Infinity } as const;

/** 한 플레이북 실행 안의 단일 블록 — 태그 네 필드가 곧 블록 run의 신원이다. */
export interface PlaybookBlockExecution {
  readonly playbook: Playbook;
  readonly rev: number;
  readonly playbookRunId: string;
  readonly block: PlaybookBlock;
}

/** 실행이 이어질 지점. resume은 startIndex 이전 블록의 실패를 재유도한다. */
export interface PlaybookRunCursor {
  readonly playbook: Playbook;
  readonly rev: PlaybookRevision;
  readonly playbookRunId: string;
  readonly startIndex: number;
}

export interface PlaybookRunView {
  playbookRunId: string;
  playbookId: string;
  rev: number;
  status: PlaybookRunStatus;
  blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }>;
}

export interface PlaybookRunDeps {
  readonly stores: TowerStores;
  readonly bridge: BridgeRunner;
  readonly originalArgs: Map<string, Record<string, unknown>>;
  readonly runReport: (execution: PlaybookBlockExecution) => Promise<void>;
}

export interface PlaybookRunEngine {
  readonly blockRunsOf: (playbookRunId: string) => RunRecord[];
  readonly runBlocksFrom: (cursor: PlaybookRunCursor) => Promise<void>;
  readonly runState: (playbook: Playbook, rev: PlaybookRevision, playbookRunId: string) => PlaybookRunView;
  readonly continueFromApprove: (playbookRunId: string) => Promise<void>;
  readonly reinterpretBlockArgs: (record: RunRecord) => Promise<Record<string, unknown>>;
}

export function createPlaybookRunEngine(deps: PlaybookRunDeps): PlaybookRunEngine {
  const { stores: { store, registry, playbooks }, bridge, originalArgs, runReport } = deps;

  const blockRunsOf = (playbookRunId: string): RunRecord[] => store.listRuns({ playbookRunId, ...PB_LIMIT });
  const latestBlockRun = (playbookRunId: string, blockId: string): RunRecord | undefined =>
    blockRunsOf(playbookRunId).find((r) => r.blockId === blockId); // listRuns는 requestedAt 내림차순 → 최신

  // 블록 args 해석: 템플릿 → deviceId 병합 → mock 폴백. write 블록의 실행용 인자를 만든다.
  async function resolveBlockArgs(block: PlaybookBlock, playbookRunId: string, tool: BridgeTool): Promise<Record<string, unknown>> {
    let args = resolveTemplates(block.args ?? {}, (bid) => latestBlockRun(playbookRunId, bid));
    if (block.deviceId) {
      const device = registry.devices().find((d) => d.id === block.deviceId);
      if (!device) throw new ApiError(400, `unknown device: ${block.deviceId}`);
      const vendor = registry.vendorFor(device.product);
      if (!vendor) throw new ApiError(400, `no vendor descriptor for product: ${device.product}`);
      args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, args), vendor, tool.inputSchema);
    }
    return args;
  }

  function tagsOf(execution: PlaybookBlockExecution) {
    return {
      playbookId: execution.playbook.id,
      playbookRunId: execution.playbookRunId,
      playbookRev: execution.rev,
      blockId: execution.block.id,
    };
  }

  // 한 tool 블록 실행. 반환: 'succeeded' | 'failed' | 'paused'(write pending).
  async function runToolBlock(execution: PlaybookBlockExecution): Promise<'succeeded' | 'failed' | 'paused'> {
    const { block, playbookRunId } = execution;
    const tags = tagsOf(execution);
    const tools = await bridge.listTools();
    const tool = tools.find((t) => t.name === block.toolId);
    if (!tool) {
      const rec = await store.createRun({ toolId: block.toolId ?? 'unknown', toolSafety: 'read_only', args: block.args ?? {}, initialStatus: 'running', ...tags });
      await store.transition(rec.runId, { status: 'failed', error: `unknown tool: ${block.toolId}`, finishedAt: new Date().toISOString() });
      return 'failed';
    }
    let args: Record<string, unknown>;
    try {
      args = await resolveBlockArgs(block, playbookRunId, tool);
    } catch (error) {
      const rec = await store.createRun({ toolId: tool.name, toolSafety: safetyOf(tool), args: block.args ?? {}, initialStatus: 'running', ...tags });
      const msg = error instanceof TemplateError ? error.message : error instanceof ApiError ? error.message : String(error);
      await store.transition(rec.runId, { status: 'failed', error: msg, finishedAt: new Date().toISOString() });
      return 'failed';
    }
    const safety = safetyOf(tool);
    if (safety === 'read_only') {
      const rec = await store.createRun({ toolId: tool.name, toolSafety: 'read_only', args, deviceId: block.deviceId, initialStatus: 'running', ...tags });
      const final = await bridge.execute({ runId: rec.runId, toolId: tool.name, args });
      return final.status === 'succeeded' ? 'succeeded' : 'failed';
    }
    const rec = await store.createRun({ toolId: tool.name, toolSafety: safety, args, deviceId: block.deviceId, initialStatus: 'pending_approval', ...tags });
    originalArgs.set(rec.runId, args); // 승인 시 실행용 (v1과 동일 규약)
    return 'paused';
  }

  // startIndex부터 블록을 순차 실행. write pending 도달 시 반환(정지). stop-on-failure: 실패 후
  // tool은 건너뛰되 report는 항상 실행. resume을 위해 이전 블록들의 실패를 재유도한다.
  async function runBlocksFrom(cursor: PlaybookRunCursor): Promise<void> {
    const { playbook, rev, playbookRunId, startIndex } = cursor;
    const priorByBlock = new Map<string, RunRecord>();
    for (const r of blockRunsOf(playbookRunId)) if (r.blockId) priorByBlock.set(r.blockId, r);
    let failed = rev.blocks.slice(0, startIndex).some((b) => {
      const st = priorByBlock.get(b.id)?.status;
      return st === 'failed' || st === 'rejected';
    });
    for (let i = startIndex; i < rev.blocks.length; i++) {
      const block = rev.blocks[i];
      const execution = { playbook, rev: rev.rev, playbookRunId, block };
      if (block.type === 'report') { await runReport(execution); continue; }
      if (failed) continue; // 실패 후 tool 블록 건너뜀
      const outcome = await runToolBlock(execution);
      if (outcome === 'paused') return; // write pending → 정지 (report는 승인 후 continueFromApprove에서)
      if (outcome === 'failed') failed = true;
    }
  }

  function runState(playbook: Playbook, rev: PlaybookRevision, playbookRunId: string): PlaybookRunView {
    const derived = derivePlaybookRunStatus(rev, blockRunsOf(playbookRunId));
    return { playbookRunId, playbookId: playbook.id, rev: rev.rev, status: derived.status, blocks: derived.blocks };
  }

  async function continueFromApprove(playbookRunId: string): Promise<void> {
    const runs = blockRunsOf(playbookRunId);
    const anchor = runs[0];
    if (!anchor?.playbookId || anchor.playbookRev === undefined) throw new ApiError(409, `재개 불가: ${playbookRunId} 태그 소실`);
    const playbook = playbooks.get(anchor.playbookId);
    if (!playbook) throw new ApiError(409, '재개 불가: 플레이북 없음');
    const rev = playbook.revisions.find((r) => r.rev === anchor.playbookRev);
    if (!rev) throw new ApiError(409, '재개 불가: 리비전 없음');
    const done = new Map<string, RunStatus>();
    for (const r of runs) if (r.blockId) done.set(r.blockId, r.status);
    let startIndex = rev.blocks.length;
    for (let i = 0; i < rev.blocks.length; i++) {
      const st = done.get(rev.blocks[i].id);
      if (st === undefined || st === 'pending_approval' || st === 'running') { startIndex = i; break; }
    }
    if (startIndex < rev.blocks.length) await runBlocksFrom({ playbook, rev, playbookRunId, startIndex });
  }

  // 접점 #1: 타워 재시작으로 originalArgs가 소실된 playbook write run의 args를
  // 리비전 블록 + 영속 결과에서 결정적으로 복원. 영속본이 불변이라 승인자가 본 것과 동일.
  async function reinterpretBlockArgs(record: RunRecord): Promise<Record<string, unknown>> {
    if (!record.playbookRunId || !record.playbookId || record.playbookRev === undefined || !record.blockId) {
      throw new ApiError(400, '원본 인자 소실 — 재요청 필요');
    }
    const playbook = playbooks.get(record.playbookId);
    const rev = playbook?.revisions.find((r) => r.rev === record.playbookRev);
    const block = rev?.blocks.find((b) => b.id === record.blockId);
    if (!playbook || !rev || !block) throw new ApiError(409, '재해석 실패: 플레이북/리비전/블록 소실');
    const tools = await bridge.listTools();
    const tool = tools.find((t) => t.name === record.toolId);
    if (!tool) throw new ApiError(409, `재해석 실패: unknown tool ${record.toolId}`);
    return resolveBlockArgs(block, record.playbookRunId, tool);
  }

  return { blockRunsOf, runBlocksFrom, runState, continueFromApprove, reinterpretBlockArgs };
}
