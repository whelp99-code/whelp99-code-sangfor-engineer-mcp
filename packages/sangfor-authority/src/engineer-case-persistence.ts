import { createHash } from 'node:crypto';
import { RuntimeSchemaError } from '../../shared/src/runtime-schema.js';
import {
  engineerCaseDocumentSchema,
  isEngineerCaseAuthContext,
  parseEngineerCaseDocument,
  type EngineerCase,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
  type EngineerValue,
} from '../../shared/src/engineer-case-contract.js';
import type {
  EngineerCaseArtifactWrite,
  EngineerCaseIssue,
  EngineerCaseLoadSuccess,
  EngineerCaseSaveSuccess,
  EngineerCaseUnsaved,
  SqlExecutor,
} from './authority-store-contracts.js';

export class EngineerCasePersistenceError extends Error {
  readonly name = 'EngineerCasePersistenceError';
  constructor(readonly code: EngineerCaseUnsaved['code'], readonly issues?: readonly EngineerCaseIssue[]) {
    super(code);
  }
}

export function unsavedEngineerCase(
  code: EngineerCaseUnsaved['code'],
  issues?: readonly EngineerCaseIssue[],
): EngineerCaseUnsaved {
  return { ok: false, status: 'unsaved', code, ...(issues ? { issues } : {}), durable: 'unsaved', approved: false, resumable: false };
}

export function refuseEngineerCaseLocalFallback(): EngineerCaseUnsaved {
  return unsavedEngineerCase('LOCAL_FALLBACK_REFUSED');
}

export function refuseEngineerCasePublicIndex(): EngineerCaseUnsaved {
  return unsavedEngineerCase('PUBLIC_INDEX_REFUSED');
}

export function isBlroAuthorityPostgres(
  selector: string | undefined = process.env.SANGFOR_BLRO_AUTHORITY_STORE,
): boolean {
  return selector === 'postgres';
}

function issue(code: string, path: string): EngineerCaseIssue {
  return { code, path };
}

function hasUnknownValue(value: EngineerValue | undefined): boolean {
  return value?.presence === 'unknown';
}

export function assemblePersistedReadiness(document: EngineerCaseDocument): 'draft' | 'blocked' {
  const unknownPresent = document.observations.some((item) => item.sourceKind === 'unknown' || hasUnknownValue(item.value))
    || document.calculations.some((item) => item.sourceKind === 'unknown' || hasUnknownValue(item.result))
    || document.guide.unresolved.length > 0
    || document.assessments.some((item) => item.status === 'unresolved');
  return unknownPresent ? 'blocked' : 'draft';
}

function claimedScopeIssues(document: EngineerCaseDocument, auth: EngineerCaseAuthContext): EngineerCaseIssue[] {
  const issues: EngineerCaseIssue[] = [];
  if (document.tenantId && document.tenantId !== auth.tenantId) issues.push(issue('UNTRUSTED_SCOPE_CLAIM', 'tenantId'));
  if (document.projectId && document.projectId !== auth.projectId) issues.push(issue('UNTRUSTED_SCOPE_CLAIM', 'projectId'));
  if (document.actorId && document.actorId !== auth.actorId) issues.push(issue('UNTRUSTED_SCOPE_CLAIM', 'actorId'));
  const collections = [
    ...document.observations.map((item, index) => ({ item, path: `observations.${index}` })),
    ...document.requirements.map((item, index) => ({ item, path: `requirements.${index}` })),
    ...document.calculations.map((item, index) => ({ item, path: `calculations.${index}` })),
    ...document.assessments.map((item, index) => ({ item, path: `assessments.${index}` })),
  ];
  for (const { item, path } of collections) {
    if (item.projectId && item.projectId !== auth.projectId) issues.push(issue('CROSS_PROJECT_REF', `${path}.projectId`));
  }
  document.evidence.forEach((item, index) => {
    if (item.owner && item.owner.projectId !== auth.projectId) {
      issues.push(issue('CROSS_PROJECT_REF', `evidence.${index}.owner.projectId`));
    }
    if (item.owner && item.owner.tenantId !== auth.tenantId) {
      issues.push(issue('CROSS_PROJECT_REF', `evidence.${index}.owner.tenantId`));
    }
  });
  return issues;
}

export function maskEngineerCaseSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskEngineerCaseSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      /password|secret|token|authorization|cookie/i.test(key) ? '***' : maskEngineerCaseSecrets(nested),
    ]));
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
}

export function digestEngineerCaseValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

export type PreparedEngineerCase = {
  readonly value: EngineerCase;
  readonly observationDigest: string;
  readonly requirementDigest: string;
  readonly requestDigest: string;
  readonly evidenceRefs: readonly string[];
};

export function prepareEngineerCaseForPersistence(
  input: unknown,
  auth: unknown,
  artifacts: readonly EngineerCaseArtifactWrite[] = [],
): { readonly ok: true; readonly value: PreparedEngineerCase } | { readonly ok: false; readonly issues: readonly EngineerCaseIssue[] } {
  if (auth == null) return { ok: false, issues: [issue('AUTH_CONTEXT_REQUIRED', 'auth')] };
  if (!isEngineerCaseAuthContext(auth)) return { ok: false, issues: [issue('AUTH_CONTEXT_INVALID', 'auth')] };
  let source: string;
  try {
    source = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return { ok: false, issues: [issue('MALFORMED_JSON', '$')] };
  }
  let document: EngineerCaseDocument;
  try {
    document = parseEngineerCaseDocument(source);
  } catch (error) {
    if (error instanceof RuntimeSchemaError) {
      const first = error.issues[0];
      if (first?.code === 'unknown_version') {
        return { ok: false, issues: [issue('UNSUPPORTED_SCHEMA_VERSION', (first.path ?? ['schemaVersion']).join('.'))] };
      }
      try {
        const parsed = JSON.parse(source) as unknown;
        const detailed = engineerCaseDocumentSchema.safeParse(parsed);
        if (!detailed.success) {
          return {
            ok: false,
            issues: detailed.error.issues.map((item) => issue(
              item.message.startsWith('FIXTURE_MARKED_OBSERVED') ? 'FIXTURE_MARKED_OBSERVED'
                : item.message.startsWith('MISSING_ORIGINAL_MARKED_OBSERVED') ? 'MISSING_ORIGINAL_MARKED_OBSERVED'
                  : item.message.startsWith('SYNTHETIC_MARKED_LIVE') ? 'SYNTHETIC_MARKED_LIVE'
                    : 'SCHEMA_MISMATCH',
              item.path.join('.') || '$',
            )),
          };
        }
      } catch {
        // Fall through to the generic schema mismatch.
      }
      return { ok: false, issues: [issue('SCHEMA_MISMATCH', first?.path.join('.') || 'schemaVersion')] };
    }
    throw error;
  }
  const scopeIssues = claimedScopeIssues(document, auth);
  if (scopeIssues.length > 0) return { ok: false, issues: scopeIssues };

  const value: EngineerCase = {
    ...document,
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorId: auth.actorId,
    guide: { ...document.guide, readiness: assemblePersistedReadiness(document) },
    evidence: document.evidence.map((item) => ({
      ...item,
      owner: item.owner ?? { tenantId: auth.tenantId, projectId: auth.projectId, caseId: document.caseId },
    })),
    execution: {
      ...document.execution,
      result: document.execution.result === 'pass' ? 'indeterminate' : document.execution.result,
      ...(document.execution.result === 'pass'
        ? { reason: document.execution.reason ?? 'stored execution.pass is not an execution PASS grant' }
        : {}),
    },
  };
  const masked = maskEngineerCaseSecrets(value) as EngineerCase;
  const observationDigest = digestEngineerCaseValue(masked.observations);
  const requirementDigest = digestEngineerCaseValue(masked.requirements.map((item) => ({ id: item.id, revision: item.revision })));
  const artifactDigests = artifacts.map((item) => item.digest);
  const requestDigest = digestEngineerCaseValue({
    document: masked,
    artifacts: artifactDigests,
  });
  return {
    ok: true,
    value: {
      value: masked,
      observationDigest,
      requirementDigest,
      requestDigest,
      evidenceRefs: masked.evidence.map((item) => item.id),
    },
  };
}

export function toSavedEngineerCase(
  prepared: PreparedEngineerCase,
  requestId: string,
): EngineerCaseSaveSuccess {
  return {
    ok: true,
    status: 'saved',
    caseId: prepared.value.caseId,
    revision: prepared.value.revision,
    guideRevision: prepared.value.guide.revision,
    guideDigest: prepared.value.guide.digest,
    observationDigest: prepared.observationDigest,
    requirementDigest: prepared.requirementDigest,
    evidenceRefs: prepared.evidenceRefs,
    requestId,
    durable: 'saved',
    approved: false,
    resumable: true,
    guideReadyGranted: false,
    executionPassGranted: false,
  };
}

export function toLoadedEngineerCase(
  prepared: PreparedEngineerCase,
): EngineerCaseLoadSuccess {
  const saved = toSavedEngineerCase(prepared, '');
  return {
    ok: true,
    status: 'saved',
    caseId: saved.caseId,
    revision: saved.revision,
    guideDigest: saved.guideDigest,
    observationDigest: saved.observationDigest,
    requirementDigest: saved.requirementDigest,
    evidenceRefs: saved.evidenceRefs,
    document: prepared.value,
    durable: 'saved',
    approved: false,
    resumable: true,
    guideReadyGranted: false,
    executionPassGranted: false,
  };
}

type CaseRow = {
  readonly id: string;
  readonly revision: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly document: unknown;
  readonly guideDigest: string;
  readonly observationDigest: string;
  readonly requirementDigest: string;
};

export async function loadEngineerCaseRow(
  tx: SqlExecutor,
  projectId: string,
  caseId: string,
): Promise<CaseRow | undefined> {
  const rows = await tx.$queryRawUnsafe<CaseRow[]>(
    `SELECT "id","revision","requestId","requestDigest","document","guideDigest","observationDigest","requirementDigest" FROM "BlroEngineerCase" WHERE "projectId"=$1 AND "id"=$2`,
    projectId,
    caseId,
  );
  return rows[0];
}

export async function loadEngineerCaseByRequest(
  tx: SqlExecutor,
  projectId: string,
  requestId: string,
): Promise<CaseRow | undefined> {
  const rows = await tx.$queryRawUnsafe<CaseRow[]>(
    `SELECT "id","revision","requestId","requestDigest","document","guideDigest","observationDigest","requirementDigest" FROM "BlroEngineerCase" WHERE "projectId"=$1 AND "requestId"=$2`,
    projectId,
    requestId,
  );
  return rows[0];
}

export async function persistEngineerCaseRow(
  tx: SqlExecutor,
  input: {
    readonly auth: EngineerCaseAuthContext;
    readonly prepared: PreparedEngineerCase;
    readonly requestId: string;
    readonly mode: 'insert' | 'update';
    readonly expectedRevision?: string;
  },
): Promise<number> {
  const { auth, prepared, requestId } = input;
  const document = JSON.stringify(prepared.value);
  if (input.mode === 'insert') {
    return tx.$executeRawUnsafe(
      `INSERT INTO "BlroEngineerCase" ("id","tenantId","projectId","actorId","revision","guideRevision","guideDigest","observationDigest","requirementDigest","requestId","requestDigest","environmentKind","originalPresent","document") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      prepared.value.caseId,
      auth.tenantId,
      auth.projectId,
      auth.actorId,
      prepared.value.revision,
      prepared.value.guide.revision,
      prepared.value.guide.digest,
      prepared.observationDigest,
      prepared.requirementDigest,
      requestId,
      prepared.requestDigest,
      prepared.value.environmentKind,
      prepared.value.originalPresent ?? null,
      document,
    );
  }
  return tx.$executeRawUnsafe(
    `UPDATE "BlroEngineerCase" SET "actorId"=$1,"revision"=$2,"guideRevision"=$3,"guideDigest"=$4,"observationDigest"=$5,"requirementDigest"=$6,"requestId"=$7,"requestDigest"=$8,"environmentKind"=$9,"originalPresent"=$10,"document"=$11::jsonb,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$12 AND "id"=$13 AND "revision"=$14`,
    auth.actorId,
    prepared.value.revision,
    prepared.value.guide.revision,
    prepared.value.guide.digest,
    prepared.observationDigest,
    prepared.requirementDigest,
    requestId,
    prepared.requestDigest,
    prepared.value.environmentKind,
    prepared.value.originalPresent ?? null,
    document,
    auth.projectId,
    prepared.value.caseId,
    input.expectedRevision,
  );
}

export async function persistEngineerCaseArtifactRow(
  tx: SqlExecutor,
  input: {
    readonly auth: EngineerCaseAuthContext;
    readonly caseId: string;
    readonly artifact: EngineerCaseArtifactWrite;
  },
): Promise<number> {
  const payload = typeof input.artifact.payload === 'string'
    ? JSON.stringify(maskEngineerCaseSecrets(safeJson(input.artifact.payload)))
    : input.artifact.payload;
  return tx.$executeRawUnsafe(
    `INSERT INTO "BlroEngineerCaseArtifact" ("id","tenantId","projectId","actorId","caseId","digest","mediaType","payload","sanitized","retention") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    input.artifact.id,
    input.auth.tenantId,
    input.auth.projectId,
    input.auth.actorId,
    input.caseId,
    input.artifact.digest,
    input.artifact.mediaType,
    payload,
    input.artifact.sanitized,
    input.artifact.retention,
  );
}

export async function replaceEngineerCaseArtifacts(
  tx: SqlExecutor,
  projectId: string,
  caseId: string,
): Promise<number> {
  return tx.$executeRawUnsafe(
    `DELETE FROM "BlroEngineerCaseArtifact" WHERE "projectId"=$1 AND "caseId"=$2`,
    projectId,
    caseId,
  );
}

export async function loadEngineerCaseArtifactRows(
  tx: SqlExecutor,
  projectId: string,
  caseId: string,
): Promise<Array<{ id: string; digest: string; mediaType: string; payload: string; sanitized: boolean; retention: string }>> {
  return tx.$queryRawUnsafe(
    `SELECT "id","digest","mediaType","payload","sanitized","retention" FROM "BlroEngineerCaseArtifact" WHERE "projectId"=$1 AND "caseId"=$2`,
    projectId,
    caseId,
  );
}

export async function loadEngineerCaseArtifactRow(
  tx: SqlExecutor,
  projectId: string,
  caseId: string,
  artifactId: string,
): Promise<{ id: string; digest: string; mediaType: string; payload: string; sanitized: boolean; retention: string } | undefined> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; digest: string; mediaType: string; payload: string; sanitized: boolean; retention: string }>>(
    `SELECT "id","digest","mediaType","payload","sanitized","retention" FROM "BlroEngineerCaseArtifact" WHERE "projectId"=$1 AND "caseId"=$2 AND "id"=$3`,
    projectId,
    caseId,
    artifactId,
  );
  return rows[0];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function persistEngineerCaseInTransaction(
  tx: SqlExecutor,
  input: {
    readonly auth: EngineerCaseAuthContext;
    readonly prepared: PreparedEngineerCase;
    readonly requestId: string;
    readonly expectedRevision?: string;
    readonly artifacts?: readonly EngineerCaseArtifactWrite[];
  },
): Promise<EngineerCaseSaveSuccess> {
  const existingRequest = await loadEngineerCaseByRequest(tx, input.auth.projectId, input.requestId);
  if (existingRequest) {
    if (existingRequest.requestDigest !== input.prepared.requestDigest) {
      throw new EngineerCasePersistenceError('IDEMPOTENCY_CONFLICT');
    }
    if (existingRequest.id !== input.prepared.value.caseId) {
      throw new EngineerCasePersistenceError('IDEMPOTENCY_CONFLICT');
    }
    return toSavedEngineerCase(input.prepared, input.requestId);
  }

  const existing = await loadEngineerCaseRow(tx, input.auth.projectId, input.prepared.value.caseId);
  if (!existing) {
    if (input.expectedRevision !== undefined) throw new EngineerCasePersistenceError('REVISION_CONFLICT');
    const inserted = await persistEngineerCaseRow(tx, { ...input, mode: 'insert' });
    if (inserted !== 1) throw new EngineerCasePersistenceError('INDETERMINATE');
  } else {
    if (input.expectedRevision === undefined || input.expectedRevision !== existing.revision) {
      throw new EngineerCasePersistenceError('REVISION_CONFLICT');
    }
    if (input.prepared.value.revision === existing.revision) {
      throw new EngineerCasePersistenceError('REVISION_CONFLICT');
    }
    const updated = await persistEngineerCaseRow(tx, { ...input, mode: 'update' });
    if (updated !== 1) throw new EngineerCasePersistenceError('REVISION_CONFLICT');
    await replaceEngineerCaseArtifacts(tx, input.auth.projectId, input.prepared.value.caseId);
  }

  for (const artifact of input.artifacts ?? []) {
    const written = await persistEngineerCaseArtifactRow(tx, {
      auth: input.auth,
      caseId: input.prepared.value.caseId,
      artifact,
    });
    if (written !== 1) throw new EngineerCasePersistenceError('INDETERMINATE');
  }
  return toSavedEngineerCase(input.prepared, input.requestId);
}
