import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '../../../packages/shared/src/index.js';
import { BridgeClient } from './bridge-client.js';
import { renderReport } from './playbook-engine.js';
import { assertAuthorityStoreSelection } from './tower-authority-gate.js';
import { composeTowerStores } from './tower-stores.js';
import { createBridgeRunner } from './tower-bridge-runner.js';
import { createPlaybookRunEngine, PB_LIMIT, type PlaybookBlockExecution } from './playbook-run-engine.js';
import { createRunApi } from './tower-run-api.js';
import { createApprovalApi } from './tower-approval-api.js';
import { createDeviceApi } from './tower-device-api.js';
import { createHealthApi } from './tower-health-api.js';
import { createPlaybookApi } from './tower-playbook-api.js';
import { createAgentTaskApi } from './tower-agent-task-api.js';
import type { TowerOptions } from './tower-contract.js';

export { ApiError } from './tower-contract.js';
export type { TowerOptions, HealthEntry, HealthReport, DeviceSummary, Overview } from './tower-contract.js';
export { assertLocalApprovalAuthorityAllowed } from './tower-authority-gate.js';
export { summarize } from './run-summary.js';

export function createApi(opts: TowerOptions = {}) {
  const mode = assertAuthorityStoreSelection(opts);
  const client = new BridgeClient(opts.bridgeUrl, opts.token);
  const stores = composeTowerStores(opts, mode);
  const approvalSecret = opts.approvalSecret ?? process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  const mockConsoleUrl = opts.mockConsoleUrl ?? process.env.MOCK_CONSOLE_URL ?? 'http://127.0.0.1:3400';
  const playbookOutputDir = opts.playbookOutputDir ?? resolveRepoData('outputs/playbooks');
  // 승인 대기 run의 실행용 원본(무마스킹) args. 저장소에는 마스킹본만 있으므로 타워
  // 재시작으로 소실되면 해당 pending은 승인 시 400 — 마스킹본('***')을 실제 장비에
  // 보내는 사고를 막는다 (스펙 §6.2).
  const originalArgs = new Map<string, Record<string, unknown>>();
  const bridge = createBridgeRunner(client, stores.store);

  // 타워가 직접 파일을 쓰는 유일한 지점 — 권한 인벤토리가 이 심볼에 runs_steps 쓰기를 고정한다.
  async function runReportBlock(execution: PlaybookBlockExecution): Promise<void> {
    const { store } = stores;
    const { playbook, rev, playbookRunId, block } = execution;
    const priorRuns = store.listRuns({ playbookRunId, ...PB_LIMIT }); // report run 생성 전에 조회 → 자기 자신 제외
    const tags = { playbookId: playbook.id, playbookRunId, playbookRev: rev, blockId: block.id };
    const rec = await store.createRun({ toolId: 'tower.report', toolSafety: 'read_only', args: {}, initialStatus: 'running', ...tags });
    try {
      const markdown = renderReport(playbook, rev, playbookRunId, priorRuns);
      mkdirSync(playbookOutputDir, { recursive: true });
      const path = join(playbookOutputDir, `${playbookRunId}.md`);
      writeFileSync(path, markdown);
      await store.transition(rec.runId, { status: 'succeeded', resultJson: { markdown, path }, resultSummary: markdown.split('\n')[0].slice(0, 200), finishedAt: new Date().toISOString() });
    } catch (error) {
      await store.transition(rec.runId, { status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
    }
  }

  const engine = createPlaybookRunEngine({ stores, bridge, originalArgs, runReport: runReportBlock });

  return {
    ...createRunApi({ stores, bridge, originalArgs }),
    ...createApprovalApi({ stores, bridge, engine, originalArgs, approvalSecret }),
    ...createDeviceApi({ stores, bridge }),
    ...createHealthApi({ stores, client, mockConsoleUrl }),
    ...createPlaybookApi({ stores, engine }),
    ...createAgentTaskApi(stores.agentTasks),
    toolGroups: bridge.toolGroups,
  };
}

export type TowerApi = ReturnType<typeof createApi>;
