export interface BackupCliOptions {
  readonly out: string;
  readonly signingKeyPath: string;
  readonly mode: 'task' | 'production';
  readonly evidenceRoot: string;
  readonly backupId: string;
  readonly verificationScratchTarget: string | undefined;
  readonly apply: boolean;
}

export declare function parseBackupCli(argv: readonly string[]): BackupCliOptions;
export declare function captureAuthoritativeState(
  sql: unknown,
  options: Pick<BackupCliOptions, 'mode' | 'evidenceRoot'>,
): Promise<Readonly<Record<string, unknown>>>;
export declare function verifyDumpReadback(dumpPath: string, expectedTables: readonly string[]): number;
export interface BackupObserver {
  readonly writeOutput?: (text: string) => void;
  readonly writeError?: (text: string) => void;
  readonly onSnapshotExported?: () => Promise<void>;
  readonly onDraftReady?: (draft: { readonly dumpPath: string }) => Promise<void>;
}

export declare function runBackup(options: BackupCliOptions, observer?: BackupObserver): Promise<void>;
export declare function captureSnapshotDraft(options: {
  readonly sql: { readonly $transaction: <T>(operation: (tx: unknown) => Promise<T>, options: Readonly<Record<string, number>>) => Promise<T> };
  readonly connection: import('./lib/blro-backup-runtime.mjs').BlroConnection;
  readonly dumpPath: string | undefined;
  readonly captureOptions: Pick<BackupCliOptions, 'mode' | 'evidenceRoot'>;
  readonly onSnapshotExported?: () => Promise<void>;
}): Promise<Readonly<Record<string, unknown>>>;
