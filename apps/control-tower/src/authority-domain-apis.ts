import type { KeyObject } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { PostgresSingleUseNonceStore } from '../../../packages/sangfor-approval/src/index.js';
import type {
  BlroAuthorityStore,
  PostgresEnrollmentRegistry,
  PostgresJobIdempotencyStore,
} from '../../../packages/sangfor-authority/src/index.js';

export type AuthorityDomainDependencies = {
  readonly prisma: PrismaClient;
  readonly authorityStore: BlroAuthorityStore;
  readonly nonceStore: PostgresSingleUseNonceStore;
  readonly enrollmentStore: PostgresEnrollmentRegistry;
  readonly jobStore: PostgresJobIdempotencyStore;
  readonly signingPrivateKey: KeyObject;
  readonly trustBundle: Buffer;
};

export type AuthorityDomainApis = {
  readonly authority: BlroAuthorityStore;
  readonly approvalNonces: PostgresSingleUseNonceStore;
  readonly enrollments: PostgresEnrollmentRegistry;
  readonly jobs: PostgresJobIdempotencyStore;
};

export type AuthorityDomainApiFactory = (
  dependencies: AuthorityDomainDependencies,
) => unknown;

export function createDefaultAuthorityDomainApis(
  dependencies: AuthorityDomainDependencies,
): AuthorityDomainApis {
  return {
    authority: dependencies.authorityStore,
    approvalNonces: dependencies.nonceStore,
    enrollments: dependencies.enrollmentStore,
    jobs: dependencies.jobStore,
  };
}

export function parseAuthorityDomainApis(
  candidate: unknown,
  dependencies: AuthorityDomainDependencies,
): AuthorityDomainApis | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  if (Object.keys(candidate).length !== 4) return undefined;
  if (!('authority' in candidate) || candidate.authority !== dependencies.authorityStore) return undefined;
  if (!('approvalNonces' in candidate) || candidate.approvalNonces !== dependencies.nonceStore) return undefined;
  if (!('enrollments' in candidate) || candidate.enrollments !== dependencies.enrollmentStore) return undefined;
  if (!('jobs' in candidate) || candidate.jobs !== dependencies.jobStore) return undefined;
  return {
    authority: dependencies.authorityStore,
    approvalNonces: dependencies.nonceStore,
    enrollments: dependencies.enrollmentStore,
    jobs: dependencies.jobStore,
  };
}
