import { resolveBlroScope } from '../../../packages/sangfor-identity/src/index.js';
import { unsavedEngineerCase } from '../../../packages/sangfor-authority/src/engineer-case-persistence.js';
import {
  indexEngineerCaseOriginals,
  loadPersistedEngineerCase,
  loadPersistedEngineerCaseArtifact,
  persistEngineerCase,
  writeEngineerCaseLocalFallback,
} from '../../../packages/sangfor-store/src/engineer-case-store.js';
import type {
  AuthorityActorScope,
  EngineerCaseArtifactResult,
  EngineerCaseLoadResult,
  EngineerCaseSaveRequest,
  EngineerCaseSaveResult,
  EngineerCaseUnsaved,
} from '../../../packages/sangfor-authority/src/authority-store-contracts.js';
import {
  persistEngineerCaseAndGuideApplyFile,
  type EngineerGuideApplyExportOmitted,
  type PersistEngineerCaseGuideApplyResult,
} from '../../../packages/sangfor-product-adapters/src/operator/engineer-guide-apply-persist.js';
import { buildEngineerGuide } from '../../../packages/sangfor-planner/src/engineer-guide.js';
import {
  ENGINEER_ID_RE,
  type EngineerCaseAuthContext,
  type EngineerCaseDocument,
} from '../../../packages/shared/src/engineer-case-contract.js';

export type EngineerCaseApiPort = {
  save(input: EngineerCaseSaveRequest): Promise<EngineerCaseSaveResult>;
  load(input: AuthorityActorScope & { readonly caseId: string }): Promise<EngineerCaseLoadResult>;
  loadArtifact(input: AuthorityActorScope & { readonly caseId: string; readonly artifactId: string }): Promise<EngineerCaseArtifactResult>;
};

export type OperatorServerOptions = {
  readonly engineerCase?: {
    readonly store?: EngineerCaseApiPort;
    readonly auth?: EngineerCaseAuthContext;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly guideApplyExportRoot?: string;
  };
};

export type EngineerCaseSaveOptions = {
  readonly guideApplyExportRoot?: string;
};

export type EngineerCaseSaveBody = {
  readonly requestId: string;
  readonly document: Record<string, unknown>;
  readonly expectedRevision?: string;
  readonly artifacts?: EngineerCaseSaveRequest['artifacts'];
};

export type EngineerCaseHttpSaveBody = EngineerCaseSaveResult & {
  readonly applyFileOmitted?: EngineerGuideApplyExportOmitted;
  readonly unresolved?: string;
};

/** Persist success or failure can omit the dry-run sidecar. Surface the existing reason. */
export function attachEngineerGuideApplyOmitReason(
  saved: PersistEngineerCaseGuideApplyResult,
): EngineerCaseHttpSaveBody {
  return {
    ...saved.persist,
    ...(saved.applyFileOmitted !== undefined
      ? { applyFileOmitted: saved.applyFileOmitted }
      : {}),
    ...(saved.unresolved !== undefined ? { unresolved: saved.unresolved } : {}),
  };
}

export type EngineerCaseIdBody = { readonly caseId: string };
export type EngineerCaseCompareBody = { readonly caseId: string; readonly revision: string };
export type EngineerCaseArtifactBody = { readonly caseId: string; readonly artifactId: string };

export function defaultEngineerCaseStore(): EngineerCaseApiPort {
  return {
    save: persistEngineerCase,
    load: loadPersistedEngineerCase,
    loadArtifact: loadPersistedEngineerCaseArtifact,
  };
}

export function resolveEngineerCaseApiAuth(
  env: Readonly<Record<string, string | undefined>>,
  injected?: EngineerCaseAuthContext,
): EngineerCaseAuthContext | undefined {
  if (injected) return injected;
  const scope = resolveBlroScope({ env });
  if (!scope.ok) return undefined;
  return { tenantId: scope.value.tenantId, projectId: scope.value.projectId, actorId: scope.value.actorId };
}

export function engineerCaseHttpStatus(result: { readonly ok: boolean; readonly code?: string }): number {
  if (result.ok) return 200;
  switch (result.code) {
    case 'VALIDATION_FAILED': return 400;
    case 'SCOPE_UNAUTHORIZED': return 403;
    case 'NOT_FOUND':
    case 'ARTIFACT_NOT_FOUND': return 404;
    case 'REVISION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT': return 409;
    default: return 503;
  }
}

export function readEngineerCaseId(value: string | null | undefined): string | undefined {
  if (!value || !ENGINEER_ID_RE.test(value) || value === '.' || value === '..' || value.includes('..')) return undefined;
  return value;
}

function missingAuth(): { status: 401; body: EngineerCaseUnsaved } {
  return { status: 401, body: unsavedEngineerCase('SCOPE_UNAUTHORIZED') };
}

function invalid(): { status: 400; body: EngineerCaseUnsaved } {
  return { status: 400, body: unsavedEngineerCase('VALIDATION_FAILED') };
}

function asAuth(auth: EngineerCaseAuthContext): AuthorityActorScope {
  return { tenantId: auth.tenantId, projectId: auth.projectId, actorId: auth.actorId };
}

async function withAuth<T extends { readonly ok: boolean; readonly code?: string }>(
  auth: EngineerCaseAuthContext | undefined,
  work: (scope: AuthorityActorScope) => Promise<T>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  if (!auth) return missingAuth();
  const result = await work(asAuth(auth));
  return { status: engineerCaseHttpStatus(result), body: result };
}

export function stripClaimedEngineerCaseGrants(document: Record<string, unknown>): Record<string, unknown> {
  const {
    guideReadyGranted: _claimedGuideReady,
    executionPassGranted: _claimedExecutionPass,
    approved: _claimedApproved,
    ...rest
  } = document;
  const execution = rest.execution && typeof rest.execution === 'object' && !Array.isArray(rest.execution)
    ? { ...(rest.execution as Record<string, unknown>) }
    : undefined;
  if (execution?.result === 'pass') {
    execution.result = 'indeterminate';
    if (typeof execution.reason !== 'string' || execution.reason.length === 0) {
      execution.reason = 'stored execution.pass is not an execution PASS grant';
    }
  }
  return {
    ...rest,
    ...(rest.progress === 'accepted' ? { progress: 'pm_review' } : {}),
    ...(execution ? { execution } : {}),
  };
}

function deriveEngineerGuideApplyViews(
  document: EngineerCaseDocument,
  auth: EngineerCaseAuthContext,
) {
  try {
    const built = buildEngineerGuide({
      document,
      auth,
      caseRevision: document.revision,
    });
    if (!built.ok || built.stepViews.length === 0) return undefined;
    return { guide: built.guide, stepViews: built.stepViews };
  } catch {
    return undefined;
  }
}

export function postSaveEngineerCase(
  body: EngineerCaseSaveBody,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
  options?: EngineerCaseSaveOptions,
) {
  return withAuth(auth, async (scope) => {
    const saved = await persistEngineerCaseAndGuideApplyFile({
      persist: (request) => store.save(request),
      save: {
        auth: scope,
        document: stripClaimedEngineerCaseGrants(body.document),
        requestId: body.requestId,
        expectedRevision: body.expectedRevision,
        artifacts: body.artifacts,
      },
      outputRoot: options?.guideApplyExportRoot,
      derive: ({ document, auth: deriveAuth }) => deriveEngineerGuideApplyViews(document, deriveAuth),
    });
    return attachEngineerGuideApplyOmitReason(saved);
  });
}

export function postResumeEngineerCase(
  body: EngineerCaseIdBody,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
) {
  return withAuth(auth, (scope) => store.load({ ...scope, caseId: body.caseId }));
}

export function getResumeEngineerCase(
  caseId: string | null,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
) {
  const id = readEngineerCaseId(caseId);
  if (!id) return Promise.resolve(invalid());
  return postResumeEngineerCase({ caseId: id }, store, auth);
}

export async function postCompareEngineerCase(
  body: EngineerCaseCompareBody,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
) {
  if (!auth) return missingAuth();
  const loaded = await store.load({ ...asAuth(auth), caseId: body.caseId });
  if (!loaded.ok) return { status: engineerCaseHttpStatus(loaded), body: loaded };
  return {
    status: 200,
    body: {
      ok: true,
      status: 'compared',
      caseId: loaded.caseId,
      storedRevision: loaded.revision,
      requestedRevision: body.revision,
      match: loaded.revision === body.revision,
      durable: 'saved' as const,
      approved: false as const,
      resumable: true as const,
      guideReadyGranted: false as const,
      executionPassGranted: false as const,
    },
  };
}

export function postEngineerCaseArtifact(
  body: EngineerCaseArtifactBody,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
) {
  return withAuth(auth, (scope) => store.loadArtifact({ ...scope, caseId: body.caseId, artifactId: body.artifactId }));
}

export function getEngineerCaseArtifact(
  caseId: string | null,
  artifactId: string | null,
  store: EngineerCaseApiPort,
  auth: EngineerCaseAuthContext | undefined,
) {
  const id = readEngineerCaseId(caseId);
  const artifact = readEngineerCaseId(artifactId);
  if (!id || !artifact) return Promise.resolve(invalid());
  return postEngineerCaseArtifact({ caseId: id, artifactId: artifact }, store, auth);
}

export function refuseEngineerCaseFileFallback(): EngineerCaseSaveResult {
  return writeEngineerCaseLocalFallback();
}

export function refuseEngineerCasePublicIndex(): EngineerCaseSaveResult {
  return indexEngineerCaseOriginals();
}
