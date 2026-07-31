import type { Device, VendorDescriptor } from './registry.js';
import type { PlaybookBlock } from './playbook-store.js';

// 시드 후보 1건 = 플레이북 1개. seedKey가 멱등 키다 (같은 키는 두 번 만들지 않는다).
export interface SeedCandidate {
  seedKey: string;
  name: string;
  goal: string;
  blocks: PlaybookBlock[];
}

const REPORT_BLOCK: PlaybookBlock = { id: 'report', type: 'report', title: '종합 리포트' };

// 장비 없이도 도는 타워 자체 점검. 등록 장비가 0대일 때 "플레이북이 하나도 없다"를 없애는 최소 콘텐츠.
const TOWER_SELFCHECK: SeedCandidate = {
  seedKey: 'tower-selfcheck',
  name: '타워 자체 점검',
  goal: '영속 저장소·RAG 인덱스·자문 스펙 커버리지를 읽기전용으로 확인한다',
  blocks: [
    { id: 'store', type: 'tool', title: '영속 저장소 상태', toolId: 'sangfor_store_health', args: {} },
    { id: 'rag', type: 'tool', title: 'RAG 인덱스 요약', toolId: 'sangfor_rag_index_summary', args: {} },
    { id: 'spec', type: 'tool', title: '자문 스펙 커버리지', toolId: 'sangfor_list_spec_coverage', args: {} },
    REPORT_BLOCK,
  ],
};

// 장비별 정기 점검은 벤더 디스크립터의 advisorTools에서 유도한다 — product를 하드코딩하지
// 않으므로 vendors.json에 벤더가 추가되면 시드도 따라온다.
function deviceCheckup(device: Device, vendor: VendorDescriptor): SeedCandidate {
  return {
    seedKey: `device-checkup:${device.id}`,
    name: `장비 정기 점검 — ${device.name}`,
    goal: `${vendor.label} 장비 ${device.name}(${device.host})를 읽기전용 자문 도구로 점검하고 FAIL 항목을 리포트로 집계한다`,
    blocks: [
      ...vendor.advisorTools.map((toolId, i) => ({
        id: `advisor${i + 1}`,
        type: 'tool' as const,
        title: toolId.replace(/^sangfor_/, ''),
        toolId,
        args: {},
        deviceId: device.id,
      })),
      REPORT_BLOCK,
    ],
  };
}

// 현재 레지스트리 상태에서 만들 수 있는 시드 후보 전체. 멱등 필터는 호출자(api.seedPlaybooks)가
// 기존 seedKey 집합으로 수행한다 — 이 함수는 순수하다.
export function planSeedPlaybooks(devices: Device[], vendors: VendorDescriptor[]): SeedCandidate[] {
  const byProduct = new Map(vendors.map((v) => [v.product, v] as const));
  const out: SeedCandidate[] = [TOWER_SELFCHECK];
  for (const device of devices) {
    const vendor = byProduct.get(device.product);
    if (!vendor || vendor.advisorTools.length === 0) continue; // 자문 도구가 없으면 점검할 블록이 없다
    out.push(deviceCheckup(device, vendor));
  }
  return out;
}
