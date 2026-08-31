import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { maskSecrets, scrubSecretValues, type AuthorityRunStore, type RunRecord } from '../../../packages/sangfor-runs/src/index.js';
import { BridgeClient, type BridgeTool } from './bridge-client.js';
import { summarize } from './run-summary.js';
import { ApiError } from './tower-contract.js';

export interface BridgeExecution {
  readonly runId: string;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly approval?: SignedApproval;
}

export interface BridgeRunner {
  readonly listTools: () => Promise<BridgeTool[]>;
  readonly execute: (execution: BridgeExecution) => Promise<RunRecord>;
  readonly toolGroups: () => Promise<{ groups: Record<string, BridgeTool[]> }>;
}

// 브리지를 향한 유일한 통로: 도구 목록·카테고리 그룹핑, 그리고 한 run의 호출→기록 단계.
export function createBridgeRunner(client: BridgeClient, store: AuthorityRunStore): BridgeRunner {
  const listTools = async (): Promise<BridgeTool[]> => {
    try {
      return await client.listTools();
    } catch (error) {
      throw new ApiError(502, `bridge unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const execute = async (execution: BridgeExecution): Promise<RunRecord> => {
    const started = Date.now();
    const call = await client.callTool(execution.toolId, execution.args, execution.approval);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    if (call.ok) {
      return await store.transition(execution.runId, {
        status: 'succeeded', resultJson: call.data, resultSummary: scrubSecretValues(summarize(maskSecrets(call.data)), execution.args), durationMs, finishedAt,
      });
    }
    return await store.transition(execution.runId, {
      status: 'failed', error: scrubSecretValues(call.errorText ?? 'unknown bridge error', execution.args), durationMs, finishedAt,
    });
  };

  const toolGroups = async (): Promise<{ groups: Record<string, BridgeTool[]> }> => {
    const tools = await listTools();
    const groups: Record<string, BridgeTool[]> = {};
    for (const tool of tools) {
      (groups[tool.category ?? 'etc'] ??= []).push(tool);
    }
    return { groups };
  };

  return { listTools, execute, toolGroups };
}
