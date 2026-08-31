import { type ListRunsOptions, type RunRecord } from '../../../packages/sangfor-runs/src/index.js';
import { safetyOf } from './bridge-client.js';
import { mergeDeviceArgs, applyMockCredentialFallback } from './registry.js';
import { ApiError, stripResultJson } from './tower-contract.js';
import { assertLocalApprovalAuthorityAllowed } from './tower-authority-gate.js';
import type { TowerStores } from './tower-stores.js';
import type { BridgeRunner } from './tower-bridge-runner.js';

export interface RunApiDeps {
  readonly stores: TowerStores;
  readonly bridge: BridgeRunner;
  readonly originalArgs: Map<string, Record<string, unknown>>;
}

// 단일 도구 run의 생성과 조회. write/destructive는 실행하지 않고 pending_approval로 세운다.
export function createRunApi(deps: RunApiDeps) {
  const { stores: { store, registry }, bridge, originalArgs } = deps;

  return {
    async createRun(input: { toolId: string; args?: Record<string, unknown>; deviceId?: string }): Promise<RunRecord> {
      if (!input.toolId) throw new ApiError(400, 'toolId is required');
      const tools = await bridge.listTools();
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
        const record = await store.createRun({ toolId: tool.name, toolSafety, args, deviceId: input.deviceId, initialStatus: 'running' });
        return bridge.execute({ runId: record.runId, toolId: tool.name, args });
      }
      assertLocalApprovalAuthorityAllowed();
      const record = await store.createRun({ toolId: tool.name, toolSafety, args, deviceId: input.deviceId, initialStatus: 'pending_approval' });
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
  };
}
