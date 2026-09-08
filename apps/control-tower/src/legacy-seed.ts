import type { createApi } from './api.js';

type TowerApi = ReturnType<typeof createApi>;

export async function seedLegacyApi(api: TowerApi | undefined, enabled: boolean | undefined): Promise<void> {
  if (!enabled || !api) return;
  const { created, skipped } = await api.seedPlaybooks();
  if (created.length) {
    console.log(`기본 플레이북 시드: ${created.length}건 생성, ${skipped}건 기존 유지 (승인 필요)`);
  }
}
