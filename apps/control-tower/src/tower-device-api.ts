import { nowId } from '../../../packages/shared/src/index.js';
import type { RunRecord } from '../../../packages/sangfor-runs/src/index.js';
import { safetyOf } from './bridge-client.js';
import { mergeDeviceArgs, applyMockCredentialFallback, RegistryValidationError, type Device, type VendorDescriptor } from './registry.js';
import { ApiError } from './tower-contract.js';
import type { TowerStores } from './tower-stores.js';
import type { BridgeRunner } from './tower-bridge-runner.js';

export interface DeviceApiDeps {
  readonly stores: TowerStores;
  readonly bridge: BridgeRunner;
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

// 장비 등록부 CRUD와 장비 전체를 훑는 자문 sweep.
export function createDeviceApi(deps: DeviceApiDeps) {
  const { stores: { store, registry }, bridge } = deps;

  return {
    listDevices(): { devices: Device[]; vendors: VendorDescriptor[] } {
      return { devices: registry.devices(), vendors: registry.vendors() };
    },

    async createDevice(input: { name: string; product: string; host: string; tags?: string[]; credentialEnv?: Record<string, string> }): Promise<Device> {
      try {
        return await registry.createDevice(input);
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    async updateDevice(id: string, patch: Partial<Omit<Device, 'id' | 'createdAt' | 'updatedAt'>>): Promise<Device> {
      try {
        return await registry.updateDevice(id, patch);
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
    },

    async deleteDevice(id: string): Promise<{ ok: true }> {
      try {
        await registry.deleteDevice(id);
        return { ok: true };
      } catch (error) {
        if (error instanceof RegistryValidationError) throw new ApiError(400, error.message);
        throw error;
      }
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
      const tools = await bridge.listTools();
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
          const record = await store.createRun({
            toolId, toolSafety: tool ? safetyOf(tool) : 'write', args: {},
            deviceId: device.id, sweepId, initialStatus: 'running',
          });
          return await store.transition(record.runId, {
            status: 'failed',
            error: tool ? 'sweep은 읽기전용 도구만 실행' : `unknown tool: ${toolId}`,
            finishedAt: new Date().toISOString(),
          });
        }
        const args = applyMockCredentialFallback(mergeDeviceArgs(vendor, device, {}), vendor, tool.inputSchema);
        const record = await store.createRun({
          toolId, toolSafety: 'read_only', args, deviceId: device.id, sweepId, initialStatus: 'running',
        });
        return bridge.execute({ runId: record.runId, toolId, args });
      });
      return { sweepId, runs };
    },
  };
}
