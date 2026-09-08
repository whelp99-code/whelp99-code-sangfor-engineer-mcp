import type { SqlExecutor } from '../authority-store-contracts.js';
import type { AuthorityAggregate } from '../migration-manifest.js';

export const CutoverState = {
  LOCAL_PRIMARY: 'LOCAL_PRIMARY',
  BACKFILLING: 'BACKFILLING',
  SHADOW_READING: 'SHADOW_READING',
  FROZEN: 'FROZEN',
  POSTGRES_PRIMARY: 'POSTGRES_PRIMARY',
} as const;
export type CutoverState = (typeof CutoverState)[keyof typeof CutoverState];

export type CutoverScope = {
  readonly projectId: string;
  readonly aggregate: AuthorityAggregate;
};

export type CutoverAggregateState = CutoverScope & {
  readonly state: CutoverState;
  readonly epoch: number;
  readonly revision: number;
  readonly sourceHighWaterMark: string | null;
  readonly sourceDigest: string | null;
  readonly targetDigest: string | null;
  readonly localWriteFencedAt: string | null;
};

export type CutoverRecord = {
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provenance: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly sourceRoot: string;
    readonly source: string;
    readonly ordinal: number;
    readonly sourceSha256: string;
  };
};

export type CutoverCommand =
  | { readonly kind: 'START_BACKFILL'; readonly highWaterMark: string; readonly expectedRevision?: number }
  | { readonly kind: 'VERIFY_BACKFILL'; readonly sourceDigest: string; readonly targetDigest: string; readonly expectedRevision?: number }
  | { readonly kind: 'FREEZE'; readonly at: string; readonly expectedRevision?: number }
  | { readonly kind: 'PROMOTE'; readonly expectedRevision?: number }
  | { readonly kind: 'ROLLBACK'; readonly expectedRevision?: number };

export interface CutoverSourceAdapter {
  readonly aggregate: AuthorityAggregate;
  capture(projectId: string): Promise<{
    readonly highWaterMark: string;
    readonly records: readonly CutoverRecord[];
  }>;
}

export interface CutoverTargetAdapter {
  readonly aggregate: AuthorityAggregate;
  stage(input: {
    readonly projectId: string;
    readonly highWaterMark: string;
    readonly records: readonly CutoverRecord[];
  }): Promise<void>;
  canonicalRecords(projectId: string, highWaterMark: string, transaction?: SqlExecutor): Promise<readonly CutoverRecord[]>;
  cleanup(projectId: string): Promise<void>;
  shadowRead(projectId: string): Promise<readonly CutoverRecord[]>;
}
