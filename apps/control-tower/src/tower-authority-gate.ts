import { PostgresAuthorityWriteFence } from '../../../packages/sangfor-authority/src/index.js';
import { ApiError, TOWER_WRITE_AGGREGATES, type TowerOptions } from './tower-contract.js';

export type AuthorityStoreMode = 'local' | 'postgres';

export function assertLocalApprovalAuthorityAllowed(): void {
  if (process.env.SANGFOR_BLRO_AUTHORITY_STORE === 'postgres') {
    throw new ApiError(503, 'JM_LOCAL_APPROVAL_SUPERSEDED: use BlroAuthorityStore');
  }
}

// 어떤 로컬 라이터도 만들기 전에 통과해야 하는 관문. postgres 선택 시 세 애그리게이트
// 모두가 PostgresAuthorityWriteFence를 주입받았는지 확인하고, 아니면 거부한다.
export function assertAuthorityStoreSelection(opts: TowerOptions): AuthorityStoreMode {
  const selected = opts.authorityMode ?? process.env.SANGFOR_BLRO_AUTHORITY_STORE;
  if (selected !== 'local' && selected !== 'postgres') throw new ApiError(503, 'LOCAL_AUTHORITY_MODE_REQUIRED');
  if (selected === 'postgres' && TOWER_WRITE_AGGREGATES.some((aggregate) =>
    !(opts.localAuthorities?.[aggregate]?.fence instanceof PostgresAuthorityWriteFence))) {
    throw new ApiError(503, 'POSTGRES_AUTHORITY_FENCE_REQUIRED');
  }
  return selected;
}
