import type { BackupManifest, BackupRecoveryPoint } from './blro-backup-manifest.mjs';

export declare class BlroRestoreVerifyError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface BackupPaths {
  readonly manifestPath: string;
  readonly dumpPath: string;
  readonly publicKeyPath: string;
  readonly evidenceRoot: string;
}

export interface RecapturedState {
  readonly schema: {
    readonly migrations: readonly { readonly name: string; readonly checksum: string }[];
    readonly migrationDigest: string;
    readonly catalogDigest: string;
    readonly tableCount: number;
  };
  readonly tables: readonly { readonly table: string; readonly rowCount: number; readonly setDigest: string }[];
  readonly relationships: readonly Readonly<Record<string, unknown>>[];
  readonly epochs: readonly Readonly<Record<string, unknown>>[];
  readonly auditHeads: readonly Readonly<Record<string, unknown>>[];
  readonly authority: {
    readonly remoteJobs: readonly Readonly<Record<string, unknown>>[];
    readonly outstandingApprovals: readonly Readonly<Record<string, unknown>>[];
    readonly outstandingNonces: readonly Readonly<Record<string, unknown>>[];
    readonly indeterminateCount: number;
    readonly completedCount: number;
  };
  readonly evidenceObjects: readonly Readonly<Record<string, unknown>>[];
}

export declare function verifyBackupBeforeRestore(paths: BackupPaths): BackupManifest;
export declare function verifyEvidenceObjects(
  manifest: Pick<BackupManifest, 'evidenceObjects'>,
  evidenceRoot: string,
): number;
export declare function verifySchemaCompatibility(
  manifest: { readonly schema: { readonly migrations: readonly { readonly name: string }[] } },
  workingTreeMigrations: readonly string[],
): number;
export declare function recaptureState(sql: unknown, evidenceRoot: string): Promise<RecapturedState>;
export declare function diffAgainstManifest(
  manifest: Readonly<Record<string, unknown>>,
  recaptured: Readonly<Record<string, unknown>>,
): readonly string[];
export declare function assertRecoveryPointCommitsPresent(
  manifest: { readonly tables: readonly { readonly rowCount: number }[]; readonly postgres: { readonly recoveryPoint: BackupRecoveryPoint } },
  recaptured: { readonly tables: readonly { readonly rowCount: number }[] },
): { readonly recoveryPoint: BackupRecoveryPoint; readonly committedRows: number };
export declare function verifyPreRecoveryState(
  sql: unknown,
  manifest: BackupManifest,
  evidenceRoot: string,
): Promise<{
  readonly recaptured: RecapturedState;
  readonly recovery: { readonly recoveryPoint: BackupRecoveryPoint; readonly committedRows: number };
  readonly equalityProblems: 0;
}>;
