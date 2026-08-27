import { createPublicKey } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  PostgresRemoteJobStore,
  createPostgresRemoteJobCompletionObserver,
} from '../../../packages/sangfor-authority/src/index.js';
import type { AuthorityConfig } from './authority-config.js';
import type { AuthorityMaterial } from './authority-material.js';

export function createAuthorityRemoteJobResources(input: {
  readonly config: AuthorityConfig;
  readonly material: AuthorityMaterial;
  readonly prisma: PrismaClient;
}): {
  readonly jobStore: PostgresRemoteJobStore;
  readonly closeCompletion: () => Promise<void>;
} {
  const completion = createPostgresRemoteJobCompletionObserver(input.config.databaseUrl);
  return {
    jobStore: new PostgresRemoteJobStore({
      database: input.prisma,
      scope: { tenantId: input.config.tenantId, projectId: input.config.projectId },
      capabilityPublicKey: createPublicKey(input.material.signingPrivateKey),
      trustedIssuerBundle: input.material.trustBundle,
      completionObserver: completion,
    }),
    closeCompletion: () => completion.close(),
  };
}
