import type { BackupRpo } from './blro-backup-manifest.mjs';

export declare const RPO_CONTRACT_ID: string;

export declare class BlroDurabilityError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface SyncDurabilityRequirement {
  readonly setting: string;
  readonly accepted: readonly string[];
  readonly reason: string;
}

export declare const REQUIRED_SYNC_DURABILITY: readonly SyncDurabilityRequirement[];

export declare const BACKUP_POINT_SEMANTICS: {
  readonly backupPoint: string;
  readonly dumpAloneClaim: string;
  readonly rpoZeroClaim: string;
  readonly neverClaimed: string;
};

export declare const RETENTION_POLICY: {
  readonly owner: string;
  readonly schedule: Readonly<Record<string, string>>;
  readonly storageClass: string;
  readonly worm: string;
  readonly hashAudits: string;
  readonly retention: Readonly<Record<string, string>>;
  readonly excluded: readonly string[];
};

export declare function evaluateSyncDurability(
  settings: readonly { readonly name: string; readonly setting: string }[],
  syncReplicaCount: number,
): BackupRpo;

export declare function assertProductionRpoContract(evaluation: BackupRpo, mode: string): BackupRpo;
