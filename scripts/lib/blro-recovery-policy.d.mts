export declare const RECOVERY_AUDIT_KIND: string;
export declare const UNCERTAIN_JOB_STATE: 'indeterminate';

export declare class BlroRecoveryPolicyError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface RecoveryPolicyOptions {
  readonly projectIds: readonly string[];
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly at: string;
  readonly backupId: string;
  readonly recoveryPointLsn: string;
  readonly auditSecret: string;
}

export interface RecoveryPolicyResult {
  readonly projectId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly spentApprovals: number;
  readonly spentNonces: number;
  readonly auditSeq: number;
  readonly auditHash: string;
  readonly preservedJobs: number;
}

export interface ReplayCandidate {
  readonly signedEpoch: number;
  readonly approvalId: string;
  readonly nonceId: string;
  readonly capabilityJti: string;
}

export declare function assertPrePolicyEquality(problems: readonly string[]): void;
export declare function applyRecoveryPolicy(
  sql: unknown,
  options: RecoveryPolicyOptions,
): Promise<readonly RecoveryPolicyResult[]>;
export declare function assertJobsPreserved(
  before: readonly Readonly<Record<string, unknown>>[],
  after: readonly Readonly<Record<string, unknown>>[],
): number;
export declare function proveReplayRefused(
  sql: unknown,
  projectId: string,
  replay: ReplayCandidate,
): Promise<readonly Readonly<Record<string, unknown>>[]>;
