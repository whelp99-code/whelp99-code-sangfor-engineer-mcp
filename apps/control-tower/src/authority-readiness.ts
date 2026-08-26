import type { PrismaClient } from '@prisma/client';
import {
  CONTROL_TOWER_AUTHORITY_SCHEMA_COMPONENT,
  probeAuthorityDatabase,
  type AuthorityDatabaseProbeResult,
} from '../../../packages/sangfor-authority/src/index.js';
import type { AuthorityConfig, AuthorityConfigField } from './authority-config.js';

export const BLRO_RUNTIME_SCHEMA_VERSION = '20260826210000_blro_enrollment_lifecycle' as const;

export type AuthorityReadinessReasonCode =
  | 'CONFIG_INVALID'
  | 'DATABASE_UNAVAILABLE'
  | 'SCHEMA_INVALID'
  | 'SIGNING_INVALID'
  | 'TRUST_INVALID'
  | 'SCOPE_INVALID'
  | 'DOMAIN_APIS_INVALID'
  | 'DRAINING';
export type AuthorityReadinessReason = {
  readonly code: AuthorityReadinessReasonCode;
  readonly fields?: readonly AuthorityConfigField[];
};
export type AuthorityCheck = {
  readonly ok: boolean;
  readonly reason?: AuthorityReadinessReason;
};
export type AuthorityDependencyChecks = {
  readonly config: AuthorityCheck;
  readonly database: AuthorityCheck;
  readonly schema: AuthorityCheck;
  readonly signing: AuthorityCheck;
  readonly trust: AuthorityCheck;
  readonly scope: AuthorityCheck;
  readonly domainApis: AuthorityCheck;
  readonly drain: AuthorityCheck;
};
export type AuthorityReadiness = {
  readonly ok: boolean;
  readonly schemaVersion: string;
  readonly checks: AuthorityDependencyChecks;
};
export function firstReadinessFailure(readiness: AuthorityReadiness): AuthorityReadinessReasonCode {
  for (const check of Object.values(readiness.checks)) {
    if (!check.ok && check.reason) return check.reason.code;
  }
  return 'DATABASE_UNAVAILABLE';
}

export type AuthorityProbeResult = AuthorityDatabaseProbeResult;
export function probeAuthorityDependencies(
  prisma: PrismaClient,
  config: AuthorityConfig,
  probeOverride?: () => Promise<boolean>,
  expectedSchemaComponent: string = CONTROL_TOWER_AUTHORITY_SCHEMA_COMPONENT,
): Promise<AuthorityProbeResult> {
  return probeAuthorityDatabase({
    databaseClient: prisma,
    tenantId: config.tenantId,
    projectId: config.projectId,
    schemaVersion: BLRO_RUNTIME_SCHEMA_VERSION,
    expectedSchemaComponent,
    ...(probeOverride ? { probeOverride } : {}),
  });
}
