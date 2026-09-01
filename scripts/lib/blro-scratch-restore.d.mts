import type { PrismaClient } from '@prisma/client';
import type { BlroConnection } from './blro-backup-runtime.mjs';

export interface ScratchRestoreOptions {
  readonly admin: BlroConnection;
  readonly target: BlroConnection;
  readonly dumpPath: string;
}

export declare function assertScratchTargetAbsent(admin: BlroConnection, database: string): void;
export declare function withScratchRestore<T>(
  options: ScratchRestoreOptions,
  operation: (scratch: PrismaClient) => Promise<T>,
): Promise<T>;
