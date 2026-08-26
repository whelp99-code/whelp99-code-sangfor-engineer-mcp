import type { createApi } from './api.js';

type TowerApi = ReturnType<typeof createApi>;

export function seedLegacyApi(api: TowerApi | undefined, enabled: boolean | undefined): void {
  if (!enabled || !api) return;
  try {
    const { created, skipped } = api.seedPlaybooks();
    if (created.length) {
      console.log(`기본 플레이북 시드: ${created.length}건 생성, ${skipped}건 기존 유지 (승인 필요)`);
    }
  } catch (error) {
    console.error(`플레이북 시드 실패(무시하고 기동): ${error instanceof Error ? error.message : String(error)}`);
  }
}
