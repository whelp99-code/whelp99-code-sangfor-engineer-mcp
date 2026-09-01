import {
  resolveProductionLocalWriteAuthority,
  resolveEngagementScopedData,
  resolveRepoData,
  type LocalWriteAuthority,
} from '../../../packages/shared/src/index.js';
import { AuthorityRunStore as RunStore } from '../../../packages/sangfor-runs/src/index.js';
import { Registry } from './registry.js';
import { PlaybookStore, AnalysisStore, AgentTaskStore } from './playbook-store.js';
import { ApiError, type TowerOptions, type TowerWriteAggregate } from './tower-contract.js';
import type { AuthorityStoreMode } from './tower-authority-gate.js';

export interface TowerStores {
  readonly store: RunStore;
  readonly registry: Registry;
  readonly playbooks: PlaybookStore;
  readonly analyses: AnalysisStore;
  readonly agentTasks: AgentTaskStore;
}

// 파일 기반 스토어 다섯 개를 애그리게이트별 로컬 쓰기 권한과 함께 세운다. 권한이 주입되지
// 않았고 모드가 local도 아니면 라이터를 만들지 않고 거부한다.
export function composeTowerStores(opts: TowerOptions, mode: AuthorityStoreMode): TowerStores {
  const projectId = process.env.SANGFOR_ENGAGEMENT_ID ?? 'local-primary';
  const tenantId = process.env.SANGFOR_TENANT_ID ?? 'local-primary';
  const actorId = process.env.SANGFOR_ACTOR_ID ?? 'local-primary';
  const runsRoot = opts.runsDir ?? resolveEngagementScopedData('data/runs', 'SANGFOR_RUNS_ROOT');
  const registryRoot = opts.registryDir ?? resolveRepoData('data/registry', 'SANGFOR_REGISTRY_ROOT');
  const local = (aggregate: TowerWriteAggregate, sourceRoot: string): LocalWriteAuthority => {
    const injected = opts.localAuthorities?.[aggregate];
    if (injected) return injected;
    if (mode !== 'local') throw new ApiError(503, 'POSTGRES_AUTHORITY_FENCE_REQUIRED');
    return resolveProductionLocalWriteAuthority({ tenantId, projectId, actorId, aggregate, sourceRoot }, undefined, mode);
  };
  return {
    store: new RunStore(runsRoot, local('runs_steps', runsRoot)),
    registry: new Registry(registryRoot, local('registry_services', registryRoot)),
    playbooks: new PlaybookStore(registryRoot, local('registry_services', registryRoot)),
    analyses: new AnalysisStore(runsRoot, local('runs_steps', runsRoot)),
    agentTasks: new AgentTaskStore(registryRoot, local('pm_tasks', registryRoot)),
  };
}
