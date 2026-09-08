export declare const SCRATCH_DATABASE_PREFIX: string;
export declare const BACKUP_VERIFICATION_DATABASE_PREFIX: string;
export declare const LOOPBACK_HOSTS: readonly string[];

export declare class BlroRuntimeError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface BlroConnection {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export declare function parseFlags(
  argv: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): { readonly values: Map<string, string>; readonly flags: Set<string> };

export declare function parseConnection(url: string, label: string): BlroConnection;
export declare function redactTarget(connection: BlroConnection): string;
export declare function connectionUrl(connection: BlroConnection, database?: string): string;
export declare function assertScratchTarget(target: BlroConnection, source: BlroConnection): BlroConnection;
export declare function assertBackupVerificationTarget(
  target: BlroConnection,
  source: BlroConnection,
  admin: BlroConnection,
): BlroConnection;
export declare function assertContainedPath(candidate: string, root: string, label: string): string;
export declare function runPgTool(
  tool: string,
  connection: BlroConnection,
  args: readonly string[],
  options?: Record<string, unknown>,
): string;
export declare function listDumpTables(dumpPath: string): Set<string>;
export declare function scrub(text: string): string;
export declare function monotonicNowMs(): number;
