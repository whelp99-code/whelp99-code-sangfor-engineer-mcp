export declare const BACKUP_MANIFEST_VERSION: 'blro.backup.manifest/1';

export declare class BlroBackupManifestError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string);
}

export interface BackupTableDigest {
  readonly table: string;
  readonly rowCount: number;
  readonly setDigest: string;
}

export interface BackupRecoveryPoint {
  readonly lsn: string;
  readonly inRecovery: boolean;
  readonly timelineId: number;
}

export interface BackupRpo {
  readonly contract: string;
  readonly claim: string;
  readonly syncDurabilityProven: boolean;
  readonly findings: readonly string[];
}

export interface BackupSignature {
  readonly algorithm: 'ed25519';
  readonly publicKeySpkiSha256: string;
  readonly payloadSha256: string;
  readonly value: string;
}

export interface BackupEvidenceObject {
  readonly id: string;
  readonly projectId: string;
  readonly contentHash: string;
  readonly objectPath: string;
  readonly objectHash: string;
  readonly objectBytes: number;
}

export interface BackupAuditHead {
  readonly projectId: string;
  readonly eventCount: number;
  readonly headSeq: number;
  readonly headHash: string;
  readonly keyedCount: number;
  readonly chainDigest: string;
}

export interface BackupEpoch {
  readonly projectId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly cutovers: readonly { readonly aggregate: string; readonly state: string; readonly epoch: number; readonly revision: number }[];
}

export interface BackupManifest {
  readonly version: string;
  readonly backupId: string;
  readonly mode: 'task' | 'production';
  readonly capturedAt: string;
  readonly dump: { readonly format: 'custom'; readonly fileName: string; readonly bytes: number; readonly sha256: string };
  readonly postgres: {
    readonly versionNum: number;
    readonly versionText: string;
    readonly databaseName: string;
    readonly schemaName: string;
    readonly systemIdentifier: string;
    readonly recoveryPoint: BackupRecoveryPoint;
    readonly durability: Readonly<Record<string, string | number>>;
  };
  readonly schema: {
    readonly migrations: readonly { readonly name: string; readonly checksum: string }[];
    readonly migrationDigest: string;
    readonly catalogDigest: string;
    readonly tableCount: number;
  };
  readonly tables: readonly BackupTableDigest[];
  readonly relationships: readonly Readonly<Record<string, unknown>>[];
  readonly epochs: readonly BackupEpoch[];
  readonly auditHeads: readonly BackupAuditHead[];
  readonly authority: {
    readonly outstandingApprovals: readonly { readonly id: string; readonly projectId: string; readonly actionHash: string; readonly status: string; readonly authorityEpoch: number }[];
    readonly outstandingNonces: readonly { readonly id: string; readonly projectId: string; readonly nonceDigest: string; readonly authorityEpoch: number }[];
    readonly remoteJobs: readonly { readonly id: string; readonly projectId: string; readonly jobId: string; readonly capabilityJti: string; readonly state: string; readonly resultDigest: string | null; readonly authorityEpoch: number }[];
    readonly indeterminateCount: number;
    readonly completedCount: number;
  };
  readonly evidenceObjects: readonly BackupEvidenceObject[];
  readonly rpo: BackupRpo;
  readonly signature: BackupSignature;
}

export declare function assertNoSecretMaterial(bytes: string | Buffer, where: string): void;
export declare function canonicalJson(value: unknown): string;
export declare function sha256OfString(text: string): string;
export declare function publicKeyDigest(privateKeyPath: string): string;
export declare function signManifest(body: Record<string, unknown>, privateKeyPath: string): BackupManifest;
export declare function parseManifest(text: string): BackupManifest;
export declare function verifyManifestSignature<T extends { readonly signature: BackupSignature }>(
  manifest: T,
  publicKeyPath: string,
): T;
