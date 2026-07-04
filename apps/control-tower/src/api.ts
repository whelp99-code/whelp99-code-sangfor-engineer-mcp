import type { SignedApproval } from '../../../packages/sangfor-operator/src/approval.js';
import { nowId } from '../../../packages/shared/src/index.js';
import { RunStore, maskSecrets, scrubSecretValues, type ListRunsOptions, type RunRecord, type RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import { BridgeClient, safetyOf, type BridgeTool } from './bridge-client.js';
import { Registry, mergeDeviceArgs, applyMockCredentialFallback, RegistryValidationError, type Device, type VendorDescriptor } from './registry.js';
import { mintBridgeApproval, mintApproval } from './approval-mint.js';

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

export interface HealthEntry { ok: boolean; detail: string }

export interface HealthReport {
  bridge: HealthEntry;
  mcp: HealthEntry;
  mockConsole: HealthEntry;
  store: HealthEntry;
  rag: HealthEntry;
}

export interface DeviceSummary {
  id: string;
  name: string;
  product: string;
  productLabel: string;
  host: string;
  tags: string[];
  lastAdvisory?: {
    runId: string; toolId: string; finishedAt?: string; status: RunStatus;
    ok?: boolean; pass?: number; fail?: number;
  };
}

export interface Overview {
  devices: DeviceSummary[];
  recentRuns: RunRecord[];
  pendingApprovals: RunRecord[];
  health: HealthReport;
}

interface EvalLike { ok: boolean; summary: { pass: number; fail: number } }

function asEval(value: unknown): EvalLike | null {
  const e = value as { ok?: unknown; summary?: { pass?: unknown; fail?: unknown } } | null;
  return e && typeof e === 'object' && typeof e.ok === 'boolean'
    && typeof e.summary?.pass === 'number' && typeof e.summary?.fail === 'number'
    ? (e as EvalLike)
    : null;
}

async function promisePool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
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

    listDevices(): { devices: Device[]; vendors: VendorDescriptor[] } {
      return { devices: registry.devices(), vendors: registry.vendors() };
    },

    createDevice(input: { name: string; product: string; host: string; tags?: string[]; credentialEnv?: Record<string, string> }): Device {
      try {
        return registry.createDevice(input);
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    updateDevice(id: string, patch: Partial<Omit<Device, 'id' | 'createdAt' | 'updatedAt'>>): Device {
      try {
        return registry.updateDevice(id, patch);
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    deleteDevice(id: string): { ok: true } {
      try {
        registry.deleteDevice(id);
        return { ok: true };
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    async toolGroups(): Promise<{ groups: Record<string, BridgeTool[]> }> {
      const tools = await listBridgeTools();
      const groups: Record<string, BridgeTool[]> = {};
      for (const tool of tools) {
        (groups[tool.category ?? 'etc'] ??= []).push(tool);
      }
      return { groups };
    },

    // 스펙 §6.3: 장비 × 벤더 advisorTools, 동시성 3, 개별 실패는 해당 run만 failed.
    // advisorTools에 read-only가 아닌 도구가 섞이면(디스크립터 오기) 실행하지 않고
    // failed로 기록 — 조용한 쓰기 실행 사고 방지.
    async sweep(input: { deviceIds?: string[] }): Promise<{ sweepId: string; runs: RunRecord[] }> {
      const all = registry.devices();
      const targets = input.deviceIds?.length
        ? input.deviceIds.map((id) => {
            const device = all.find((d) => d.id === id);
            if (!device) throw new ApiError(400, `unknown device: ${id}`);
            return device;
          })
        : all;
      const tools = await listBridgeTools();
      const sweepId = nowId('sweep');
      const jobs: Array<{ device: Device; vendor: VendorDescriptor; toolId: string }> = [];
      for (const device of targets) {
        const vendor = registry.vendorFor(device.product);
        if (!vendor) continue; // 등록 시 검증되므로 정상 경로에서는 없음
        for (const toolId of vendor.advisorTools) jobs.push({ device, vendor, toolId });
      }
      const runs = await promisePool(jobs, 3, async ({ device, vendor, toolId }) => {
        const tool = tools.find((t) => t.name === toolId);
        if (!tool || safetyOf(tool) !== 'read_only') {
          const record = store.createRun({
            toolId, toolSafety: tool ? safetyOf(tool) : 'write', args: {},
            deviceId: device.id, sweepId, initialStatus: 'running',
          });
          return store.transition(record.runId, {
            status: 'failed',
            error: tool ? 'sweep은 읽기전용 도구만 실행' : `unknown tool: ${toolId}`,
            finishedAt: new Date().toISOString(),
          });
        }
        const args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, {}), vendor, tool.inputSchema);
        const record = store.createRun({
          toolId, toolSafety: 'read_only', args, deviceId: device.id, sweepId, initialStatus: 'running',
        });
        return execute(record.runId, toolId, args);
      });
      return { sweepId, runs };
    },

    // 모든 항목 best-effort(개별 3초 타임아웃) — 실패도 값으로, 절대 throw하지 않는다.
    async health(): Promise<HealthReport> {
      const bridgeHealth = await bridge.health();
      const toEntry = async (name: string): Promise<HealthEntry> => {
        const call = await bridge.callTool(name, {}, undefined, 3_000);
        return call.ok
          ? { ok: true, detail: JSON.stringify(call.data)?.slice(0, 120) ?? 'ok' }
          : { ok: false, detail: call.errorText ?? 'error' };
      };
      const [mockConsole, storeEntry, ragEntry] = await Promise.all([
        fetch(`${mockConsoleUrl}/state`, { signal: AbortSignal.timeout(3_000) })
          .then((r) => ({ ok: r.ok, detail: `HTTP ${r.status}` }))
          .catch((error) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) })),
        toEntry('sangfor.store_health'),
        toEntry('sangfor.rag_index_summary'),
      ]);
      return {
        bridge: { ok: bridgeHealth.status === 'ok', detail: `status=${bridgeHealth.status}` },
        mcp: { ok: bridgeHealth.mcp === 'connected', detail: `mcp=${bridgeHealth.mcp}` },
        mockConsole,
        store: storeEntry,
        rag: ragEntry,
      };
    },

    // 스펙 §5.3 대시보드 첫 화면 4위젯 단일 호출.
    async overview(): Promise<Overview> {
      const vendors = new Map(registry.vendors().map((v) => [v.product, v] as const));
      const devices: DeviceSummary[] = registry.devices().map((d) => {
        const vendor = vendors.get(d.product);
        const advisorSet = new Set(vendor?.advisorTools ?? []);
        const latest = store.listRuns({ deviceId: d.id, limit: 100 })
          .find((r) => advisorSet.has(r.toolId) && (r.status === 'succeeded' || r.status === 'failed'));
        const summary: DeviceSummary = {
          id: d.id, name: d.name, product: d.product,
          productLabel: vendor?.label ?? d.product, host: d.host, tags: d.tags,
        };
        if (latest) {
          const m = latest.resultSummary?.match(/ok=(true|false) pass=(\d+) fail=(\d+)/);
          summary.lastAdvisory = {
            runId: latest.runId, toolId: latest.toolId, finishedAt: latest.finishedAt, status: latest.status,
            ...(m ? { ok: m[1] === 'true', pass: Number(m[2]), fail: Number(m[3]) } : {}),
          };
        }
        return summary;
      });
      return {
        devices,
        recentRuns: store.listRuns({ limit: 20 }).map(stripResultJson),
        pendingApprovals: store.pendingApprovals().map(stripResultJson),
        health: await this.health(),
      };
    },

    // 스펙 §6.4: tool-args용 승인 수동 민팅 (HCI 등). 저장하지 않는다.
    mint(input: {
      actionType?: string; actionTarget?: string; approvedBy?: string;
      changeTicketId?: string; rollbackPlanId?: string; ttlSec?: number;
    }): SignedApproval {
      if (!approvalSecret) throw new ApiError(500, 'approval secret not configured');
      for (const field of ['actionType', 'approvedBy', 'changeTicketId', 'rollbackPlanId'] as const) {
        if (!input[field] || !String(input[field]).trim()) throw new ApiError(400, `${field} is required`);
      }
      return mintApproval({
        secret: approvalSecret,
        actionType: String(input.actionType),
        actionTarget: input.actionTarget ? String(input.actionTarget) : undefined,
        approvedBy: String(input.approvedBy),
        changeTicketId: String(input.changeTicketId),
        rollbackPlanId: String(input.rollbackPlanId),
        ttlSec: typeof input.ttlSec === 'number' ? input.ttlSec : undefined,
      });
    },
  };
}

export type TowerApi = ReturnType<typeof createApi>;
