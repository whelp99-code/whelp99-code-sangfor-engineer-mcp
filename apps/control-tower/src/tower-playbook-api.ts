import { nowId } from '../../../packages/shared/src/index.js';
import type { RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import { derivePlaybookRunStatus, type PlaybookRunStatus } from './playbook-engine.js';
import { planSeedPlaybooks } from './playbook-seed.js';
import type { Playbook, PlaybookBlock, PlaybookAnalysis, AnalysisVerdict } from './playbook-store.js';
import { ApiError, asApiError } from './tower-contract.js';
import type { TowerStores } from './tower-stores.js';
import { PB_LIMIT, type PlaybookRunEngine, type PlaybookRunView } from './playbook-run-engine.js';

export interface PlaybookApiDeps {
  readonly stores: TowerStores;
  readonly engine: PlaybookRunEngine;
}

// 플레이북 리비전 라이프사이클(작성·검토·시드)과 그 실행/분석 조회 표면.
export function createPlaybookApi(deps: PlaybookApiDeps) {
  const { stores: { store, registry, playbooks, analyses }, engine } = deps;

  function getPlaybookRun(playbookRunId: string): {
    playbookRunId: string; playbookId?: string; rev?: number; status: PlaybookRunStatus;
    blocks: Array<{ blockId: string; runId?: string; status?: RunStatus }>; analyses: PlaybookAnalysis[];
  } {
    const runs = engine.blockRunsOf(playbookRunId);
    const anchor = runs[0];
    if (!anchor?.playbookId || anchor.playbookRev === undefined) throw new ApiError(404, `unknown playbook run: ${playbookRunId}`);
    const pb = playbooks.get(anchor.playbookId);
    const rev = pb?.revisions.find((r) => r.rev === anchor.playbookRev);
    if (!pb || !rev) throw new ApiError(404, `playbook/revision missing for run: ${playbookRunId}`);
    const derived = derivePlaybookRunStatus(rev, runs);
    return { playbookRunId, playbookId: pb.id, rev: rev.rev, status: derived.status, blocks: derived.blocks, analyses: analyses.listByRun(playbookRunId) };
  }

  return {
    listPlaybooks(): { playbooks: Array<Playbook & { activeRev?: number; lastRun?: { playbookRunId: string; status: PlaybookRunStatus } }> } {
      const allRuns = store.listRuns({ ...PB_LIMIT });
      return {
        playbooks: playbooks.list().map((pb) => {
          const active = playbooks.activeRevision(pb);
          // 최근 실행: 이 플레이북 태그가 붙은 가장 최신 블록 run의 playbookRunId로 유도
          const latest = allRuns.find((r) => r.playbookId === pb.id && r.playbookRunId);
          let lastRun: { playbookRunId: string; status: PlaybookRunStatus } | undefined;
          if (latest?.playbookRunId && active) {
            const rev = pb.revisions.find((r) => r.rev === latest.playbookRev) ?? active;
            const blockRuns = allRuns.filter((r) => r.playbookRunId === latest.playbookRunId);
            lastRun = { playbookRunId: latest.playbookRunId, status: derivePlaybookRunStatus(rev, blockRuns).status };
          }
          return { ...pb, activeRev: active?.rev, lastRun };
        }),
      };
    },

    // 기본 제공 플레이북 시드. seedKey로 멱등 — 이미 있는 시드는 건너뛴다. 생성본은 rev 1이
    // draft이므로 사람이 승인해야 실행된다(리뷰 게이트 우회 금지).
    async seedPlaybooks(input: { authoredBy?: string } = {}): Promise<{ created: Playbook[]; skipped: number }> {
      const candidates = planSeedPlaybooks(registry.devices(), registry.vendors());
      const existing = new Set(playbooks.list().map((p) => p.seedKey).filter(Boolean));
      const fresh = candidates.filter((c) => !existing.has(c.seedKey));
      const created = await Promise.all(fresh.map((candidate) => playbooks.create({
        name: candidate.name, goal: candidate.goal, blocks: candidate.blocks, seedKey: candidate.seedKey,
        authoredBy: input.authoredBy?.trim() || 'tower-seed',
        note: '기본 제공 시드 — 블록을 검토한 뒤 승인하세요',
      })));
      return { created, skipped: candidates.length - created.length };
    },

    async createPlaybook(input: { name: string; goal: string; blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Promise<Playbook> {
      try { return await playbooks.create(input); }
      catch (error) { throw asApiError(error); }
    },

    getPlaybook(id: string): Playbook {
      const pb = playbooks.get(id);
      if (!pb) throw new ApiError(404, `unknown playbook: ${id}`);
      return pb;
    },

    async addPlaybookRevision(id: string, input: { blocks: PlaybookBlock[]; authoredBy: string; note?: string }): Promise<Playbook> {
      try { return await playbooks.addRevision(id, input); }
      catch (error) { throw asApiError(error); }
    },

    async reviewPlaybookRevision(id: string, rev: number, verdict: { approve: boolean; reviewedBy: string; rejectReason?: string }): Promise<Playbook> {
      try { return await playbooks.reviewRevision(id, rev, verdict); }
      catch (error) { throw asApiError(error); }
    },

    async submitAnalysis(playbookRunId: string, input: Omit<PlaybookAnalysis, 'id' | 'createdAt' | 'schemaVersion'>): Promise<PlaybookAnalysis> {
      // 존재하는 실행인지 확인 (정보 격리: 임의 playbookRunId로 분석 주입 방지)
      getPlaybookRun(playbookRunId);
      return await analyses.append({ ...input, playbookRunId, schemaVersion: 1 } as PlaybookAnalysis);
    },

    async setAnalysisVerdict(id: string, input: { part: 'improvements' | 'proposals'; index: number; verdict: AnalysisVerdict; reviewedBy: string; linkedPlaybookId?: string }): Promise<PlaybookAnalysis> {
      try { return await analyses.setVerdict(id, input.part, input.index, input.verdict, input.reviewedBy, input.linkedPlaybookId); }
      catch (error) { throw asApiError(error); }
    },

    async executePlaybook(playbookId: string): Promise<PlaybookRunView> {
      const pb = playbooks.get(playbookId);
      if (!pb) throw new ApiError(404, `unknown playbook: ${playbookId}`);
      const rev = playbooks.activeRevision(pb);
      if (!rev) throw new ApiError(403, '승인된 리비전이 없습니다');
      const playbookRunId = nowId('pbrun');
      await engine.runBlocksFrom({ playbook: pb, rev, playbookRunId, startIndex: 0 });
      return engine.runState(pb, rev, playbookRunId);
    },

    async continuePlaybookRun(playbookRunId: string): Promise<void> {
      return engine.continueFromApprove(playbookRunId);
    },

    getPlaybookRun,
  };
}
