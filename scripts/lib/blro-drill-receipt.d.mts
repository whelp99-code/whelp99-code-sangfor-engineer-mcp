import type { z } from 'zod';
import type { BackupRecoveryPoint, BackupRpo, BackupSignature } from './blro-backup-manifest.mjs';
import type { RecoveryPolicyResult } from './blro-recovery-policy.mjs';

export declare const DRILL_PASS_SENTINEL: 'BLRO_RESTORE_DRILL_PASS';
export declare const DRILL_RECEIPT_VERSION: string;
export declare const RTO_BUDGET_MS: number;

export declare class BlroDrillReceiptError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface DrillReceipt {
  readonly version: string;
  readonly backupId: string;
  readonly source: string;
  readonly target: string;
  readonly verifiedAt: string;
  readonly backup: {
    readonly manifestPayloadSha256: string;
    readonly dumpSha256: string;
    readonly recoveryPoint: BackupRecoveryPoint;
    readonly rpo: BackupRpo;
  };
  readonly verified: {
    readonly tables: number;
    readonly committedRows: number;
    readonly relationships: number;
    readonly auditChains: number;
    readonly evidenceObjects: number;
    readonly equalityProblems: 0;
  };
  readonly policy: readonly RecoveryPolicyResult[];
  readonly preserved: {
    readonly indeterminate: number;
    readonly completed: number;
    readonly remoteJobDigest: string;
  };
  readonly replayRefusals: readonly {
    readonly projectId: string;
    readonly refusals: readonly { readonly kind: string; readonly reason: string }[];
  }[];
  readonly drill: {
    readonly rtoMs: number;
    readonly rtoBudgetMs: number;
    readonly withinBudget: true;
    readonly sentinel: string;
  };
  readonly signature: BackupSignature;
}

export declare const drillReceiptSchema: z.ZodType<DrillReceipt>;

export declare function buildDrillReceipt(input: Readonly<Record<string, unknown>>): Omit<DrillReceipt, 'signature'>;
export declare function signDrillReceipt(
  body: Omit<DrillReceipt, 'signature'>,
  privateKeyPath: string,
): DrillReceipt;
