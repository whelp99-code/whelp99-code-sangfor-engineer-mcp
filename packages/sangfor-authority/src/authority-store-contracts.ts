export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>;
}

export interface AuthorityDatabase extends SqlExecutor {
  $transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
    options?: { readonly isolationLevel?: 'Serializable' | 'ReadCommitted' },
  ): Promise<T>;
}

export interface AuthorityActorScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
}

export const ENGINEER_CASE_WRITE_PERMISSION = 'case:write';
export const ENGINEER_CASE_READ_PERMISSION = 'case:read';

export type EngineerCaseDurableStatus = 'unsaved' | 'saved';

export type EngineerCasePersistenceCode =
  | 'STORE_UNAVAILABLE'
  | 'INDETERMINATE'
  | 'REVISION_CONFLICT'
  | 'SCOPE_UNAUTHORIZED'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'LOCAL_FALLBACK_REFUSED'
  | 'PUBLIC_INDEX_REFUSED'
  | 'NOT_FOUND'
  | 'ARTIFACT_NOT_FOUND';

export type EngineerCaseArtifactWrite = {
  readonly id: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly payload: string;
  readonly sanitized: boolean;
  readonly retention: string;
};

export type EngineerCaseSaveRequest = {
  readonly auth: AuthorityActorScope;
  readonly document: unknown;
  readonly requestId: string;
  readonly expectedRevision?: string;
  readonly artifacts?: readonly EngineerCaseArtifactWrite[];
  readonly localFallback?: true;
};

export type EngineerCaseIssue = {
  readonly code: string;
  readonly path: string;
};

export type EngineerCaseSaveSuccess = {
  readonly ok: true;
  readonly status: 'saved';
  readonly caseId: string;
  readonly revision: string;
  readonly guideRevision: string;
  readonly guideDigest: string;
  readonly observationDigest: string;
  readonly requirementDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly requestId: string;
  readonly durable: 'saved';
  readonly approved: false;
  readonly resumable: true;
  readonly guideReadyGranted: false;
  readonly executionPassGranted: false;
};

export type EngineerCaseUnsaved = {
  readonly ok: false;
  readonly status: 'unsaved';
  readonly code: EngineerCasePersistenceCode;
  readonly issues?: readonly EngineerCaseIssue[];
  readonly durable: 'unsaved';
  readonly approved: false;
  readonly resumable: false;
};

export type EngineerCaseSaveResult = EngineerCaseSaveSuccess | EngineerCaseUnsaved;

export type EngineerCaseLoadSuccess = {
  readonly ok: true;
  readonly status: 'saved';
  readonly caseId: string;
  readonly revision: string;
  readonly guideDigest: string;
  readonly observationDigest: string;
  readonly requirementDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly document: unknown;
  readonly durable: 'saved';
  readonly approved: false;
  readonly resumable: true;
  readonly guideReadyGranted: false;
  readonly executionPassGranted: false;
};

export type EngineerCaseLoadResult = EngineerCaseLoadSuccess | EngineerCaseUnsaved;

export type EngineerCaseArtifactRead = {
  readonly ok: true;
  readonly id: string;
  readonly caseId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly payload: string;
  readonly sanitized: boolean;
  readonly retention: string;
};

export type EngineerCaseArtifactResult = EngineerCaseArtifactRead | EngineerCaseUnsaved;
