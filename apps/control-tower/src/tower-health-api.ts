import type { BridgeClient } from './bridge-client.js';
import { stripResultJson, type DeviceSummary, type HealthEntry, type HealthReport, type Overview } from './tower-contract.js';
import type { TowerStores } from './tower-stores.js';

export interface HealthApiDeps {
  readonly stores: TowerStores;
  readonly client: BridgeClient;
  readonly mockConsoleUrl: string;
}

// 대시보드 첫 화면이 읽는 두 응답 — 어느 항목이 죽어도 렌더돼야 한다.
export function createHealthApi(deps: HealthApiDeps) {
  const { stores: { store, registry }, client, mockConsoleUrl } = deps;

  // 모든 항목 best-effort(개별 3초 타임아웃) — 실패도 값으로, 절대 throw하지 않는다.
  async function health(): Promise<HealthReport> {
    const bridgeHealth = await client.health();
    const toEntry = async (name: string): Promise<HealthEntry> => {
      const call = await client.callTool(name, {}, undefined, 3_000);
      return call.ok
        ? { ok: true, detail: JSON.stringify(call.data)?.slice(0, 120) ?? 'ok' }
        : { ok: false, detail: call.errorText ?? 'error' };
    };
    const [mockConsole, storeEntry, ragEntry] = await Promise.all([
      fetch(`${mockConsoleUrl}/state`, { signal: AbortSignal.timeout(3_000) })
        .then((r) => ({ ok: r.ok, detail: `HTTP ${r.status}` }))
        .catch((error) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) })),
      toEntry('sangfor_store_health'),
      toEntry('sangfor_rag_index_summary'),
    ]);
    return {
      bridge: { ok: bridgeHealth.status === 'ok', detail: `status=${bridgeHealth.status}` },
      mcp: { ok: bridgeHealth.mcp === 'connected', detail: `mcp=${bridgeHealth.mcp}` },
      mockConsole,
      store: storeEntry,
      rag: ragEntry,
    };
  }

  // 스펙 §5.3 대시보드 첫 화면 4위젯 단일 호출.
  async function overview(): Promise<Overview> {
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
      health: await health(),
    };
  }

  return { health, overview };
}
