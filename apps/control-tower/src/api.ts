import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { RunStore, maskSecrets, scrubSecretValues, type ListRunsOptions, type RunRecord } from '../../../packages/sangfor-runs/src/index.js';
import { BridgeClient, safetyOf, type BridgeTool } from './bridge-client.js';
import { Registry, mergeDeviceArgs, applyMockCredentialFallback } from './registry.js';
import { mintBridgeApproval } from './approval-mint.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface TowerOptions {
  bridgeUrl?: string;
  token?: string;
  runsDir?: string;
  registryDir?: string;
  approvalSecret?: string;
  mockConsoleUrl?: string;
}

interface EvalLike { ok: boolean; summary: { pass: number; fail: number } }

function asEval(value: unknown): EvalLike | null {
  const e = value as { ok?: unknown; summary?: { pass?: unknown; fail?: unknown } } | null;
  return e && typeof e === 'object' && typeof e.ok === 'boolean'
    && typeof e.summary?.pass === 'number' && typeof e.summary?.fail === 'number'
    ? (e as EvalLike)
    : null;
}

// 스펙 §6.1: EvaluationResult(직접 | .evaluation | .evaluations[] 래핑)면 ok/pass/fail
// 요약, advisor 오류 결과({error})면 error 첫줄, 그 외 JSON 첫 150자. 최대 200자.
export function summarize(result: unknown): string {
  const cap = (s: string) => s.slice(0, 200);
  const fmt = (ok: boolean, pass: number, fail: number) => `ok=${ok} pass=${pass} fail=${fail}`;
  if (result && typeof result === 'object') {
    const r = result as { evaluation?: unknown; evaluations?: unknown[]; error?: unknown };
    const direct = asEval(result);
    if (direct) return fmt(direct.ok, direct.summary.pass, direct.summary.fail);
    const single = asEval(r.evaluation);
    if (single) return fmt(single.ok, single.summary.pass, single.summary.fail);
    if (Array.isArray(r.evaluations)) {
      const parts = r.evaluations.map(asEval).filter((p): p is EvalLike => p !== null);
      if (parts.length) {
        return fmt(
          parts.every((p) => p.ok),
          parts.reduce((n, p) => n + p.summary.pass, 0),
          parts.reduce((n, p) => n + p.summary.fail, 0),
        );
      }
    }
    if (typeof r.error === 'string') return cap(`error: ${r.error.slice(0, 150)}`);
  }
  try {
    return cap(JSON.stringify(result)?.slice(0, 150) ?? 'null');
  } catch {
    return cap(String(result).slice(0, 150));
  }
}

export function createApi(opts: TowerOptions = {}) {
  const bridge = new BridgeClient(opts.bridgeUrl, opts.token);
  const store = new RunStore(opts.runsDir);
  const registry = new Registry(opts.registryDir);
  const approvalSecret = opts.approvalSecret ?? process.env.SANGFOR_OPERATOR_APPROVAL_SECRET;
  const mockConsoleUrl = opts.mockConsoleUrl ?? process.env.MOCK_CONSOLE_URL ?? 'http://127.0.0.1:3400';
  // 승인 대기 run의 실행용 원본(무마스킹) args. 저장소에는 마스킹본만 있으므로 타워
  // 재시작으로 소실되면 해당 pending은 승인 시 400 — 마스킹본('***')을 실제 장비에
  // 보내는 사고를 막는다 (스펙 §6.2).
  const originalArgs = new Map<string, Record<string, unknown>>();

  async function listBridgeTools(): Promise<BridgeTool[]> {
    try {
      return await bridge.listTools();
    } catch (error) {
      throw new ApiError(502, `bridge unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function execute(
    runId: string,
    toolId: string,
    args: Record<string, unknown>,
    approval?: SignedApproval,
  ): Promise<RunRecord> {
    const started = Date.now();
    const call = await bridge.callTool(toolId, args, approval);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - started;
    if (call.ok) {
      return store.transition(runId, {
        status: 'succeeded', resultJson: call.data, resultSummary: scrubSecretValues(summarize(maskSecrets(call.data)), args), durationMs, finishedAt,
      });
    }
    return store.transition(runId, {
      status: 'failed', error: scrubSecretValues(call.errorText ?? 'unknown bridge error', args), durationMs, finishedAt,
    });
  }

  function stripResultJson(record: RunRecord): RunRecord {
    const { resultJson: _resultJson, ...rest } = record;
    return rest as RunRecord;
  }

  return {
    async createRun(input: { toolId: string; args?: Record<string, unknown>; deviceId?: string }): Promise<RunRecord> {
      if (!input.toolId) throw new ApiError(400, 'toolId is required');
      const tools = await listBridgeTools();
      const tool = tools.find((t) => t.name === input.toolId);
      if (!tool) throw new ApiError(400, `unknown tool: ${input.toolId}`);
      let args = input.args ?? {};
      if (input.deviceId) {
        const device = registry.devices().find((d) => d.id === input.deviceId);
        if (!device) throw new ApiError(400, `unknown device: ${input.deviceId}`);
        const vendor = registry.vendorFor(device.product);
        if (!vendor) throw new ApiError(400, `no vendor descriptor for product: ${device.product}`);
        args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, args), vendor, tool.inputSchema);
      }
      const toolSafety = safetyOf(tool);
      if (toolSafety === 'read_only') {
        const record = store.createRun({ toolId: tool.name, toolSafety, args, deviceId: input.deviceId, initialStatus: 'running' });
        return execute(record.runId, tool.name, args);
      }
      const record = store.createRun({ toolId: tool.name, toolSafety, args, deviceId: input.deviceId, initialStatus: 'pending_approval' });
      originalArgs.set(record.runId, args);
      return record;
    },

    listRuns(query: ListRunsOptions = {}): RunRecord[] {
      return store.listRuns(query).map(stripResultJson);
    },

    getRun(runId: string): RunRecord {
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      return record;
    },

    async approveRun(
      runId: string,
      input: { approvedBy: string; changeTicketId?: string; rollbackPlanId?: string },
    ): Promise<RunRecord> {
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      if (record.status !== 'pending_approval') throw new ApiError(409, `run is not pending_approval: ${record.status}`);
      if (!input.approvedBy?.trim()) throw new ApiError(400, 'approvedBy is required');
      if (!approvalSecret) throw new ApiError(500, 'approval secret not configured');
      const args = originalArgs.get(runId);
      if (!args) throw new ApiError(400, '원본 인자 소실 — 재요청 필요');
      const changeTicketId = input.changeTicketId?.trim() || `run:${runId}`;
      const rollbackPlanId = input.rollbackPlanId?.trim() || 'n/a-read-back-verify';
      const signed = mintBridgeApproval(record.toolId, {
        secret: approvalSecret, approvedBy: input.approvedBy, changeTicketId, rollbackPlanId, ttlSec: 120,
      });
      store.transition(runId, {
        status: 'running',
        approval: { approvedBy: input.approvedBy, approvedAt: new Date().toISOString(), changeTicketId, rollbackPlanId },
      });
      const final = await execute(runId, record.toolId, args, signed);
      originalArgs.delete(runId);
      return final;
    },

    rejectRun(runId: string, input: { reason?: string }): RunRecord {
      const record = store.getRun(runId);
      if (!record) throw new ApiError(404, `unknown run: ${runId}`);
      if (record.status !== 'pending_approval') throw new ApiError(409, `run is not pending_approval: ${record.status}`);
      if (!input.reason?.trim()) throw new ApiError(400, 'reason is required');
      originalArgs.delete(runId);
      return store.transition(runId, { status: 'rejected', rejectedReason: input.reason.trim() });
    },
  };
}

export type TowerApi = ReturnType<typeof createApi>;
