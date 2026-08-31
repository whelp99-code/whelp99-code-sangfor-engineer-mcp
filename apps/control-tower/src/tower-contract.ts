import type { LocalWriteAuthority } from '../../../packages/shared/src/index.js';
import type { RunRecord, RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import { PlaybookValidationError } from './playbook-store.js';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof PlaybookValidationError) return new ApiError(error.status, error.message);
  if (error instanceof ApiError) return error;
  return new ApiError(500, error instanceof Error ? error.message : String(error));
}

// 목록 응답은 resultJson을 싣지 않는다 — 상세 조회만 본문을 포함한다.
export function stripResultJson(record: RunRecord): RunRecord {
  const { resultJson: _resultJson, ...rest } = record;
  return rest as RunRecord;
}

// 타워가 로컬 쓰기 권한을 주입받을 수 있는 애그리게이트 전체.
export const TOWER_WRITE_AGGREGATES = ['registry_services', 'runs_steps', 'pm_tasks'] as const;
export type TowerWriteAggregate = (typeof TOWER_WRITE_AGGREGATES)[number];

export interface TowerOptions {
  bridgeUrl?: string;
  token?: string;
  runsDir?: string;
  registryDir?: string;
  approvalSecret?: string;
  mockConsoleUrl?: string;
  playbookOutputDir?: string;
  authorityMode?: 'local' | 'postgres';
  localAuthorities?: Partial<Record<TowerWriteAggregate, LocalWriteAuthority>>;   // 리포트 산출물 경로 (테스트 주입용, 기본 resolveRepoData('outputs/playbooks'))
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
