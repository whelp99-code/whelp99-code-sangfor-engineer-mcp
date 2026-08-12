/**
 * BLRO scope identity — tenant, project, actor.
 *
 * Scope is deliberately small. The product north star is that AI and MCP do the
 * engineering and write the documents, and that a human PM eventually operates
 * and manages AI engineers. This module exists for exactly two reasons:
 *
 *   1. **attribute** work to an actor, including an AI engineer actor, so a PM
 *      can supervise it;
 *   2. **isolate** that work to one project.
 *
 * It is not a general IAM system: roles exist only to bind project membership
 * to the narrow permissions BLRO services consume. Org charts and billing
 * belong elsewhere.
 *
 * Fail-closed by construction. The legacy `SANGFOR_ENGAGEMENT_ID` path helper is
 * fail-OPEN (unset means the shared root); this resolver is the opposite — an
 * absent or malformed scope REFUSES and never falls back to a shared scope.
 * Per D1, `engagementId` is the seed of `projectId`.
 *
 * L0 leaf: no filesystem, no network, no process access beyond the injected env.
 */

/** Actor kinds the PM-over-AI-engineers workflow must tell apart. */
export const ACTOR_TYPES = ['human_pm', 'ai_engineer', 'service'] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export interface TenantIdentity { readonly id: string; readonly active: boolean }
export interface ProjectIdentity { readonly id: string; readonly tenantId: string; readonly active: boolean }
export interface ActorIdentity { readonly id: string; readonly tenantId: string; readonly actorType: ActorType; readonly active: boolean }
export interface RoleIdentity { readonly id: string; readonly tenantId: string; readonly permissions: readonly string[] }
export interface ProjectMembership { readonly actorId: string; readonly projectId: string; readonly roleId: string; readonly active: boolean }

/** Read model supplied by the BLRO identity database writer. */
export interface IdentityDirectory {
  readonly tenants: readonly TenantIdentity[];
  readonly projects: readonly ProjectIdentity[];
  readonly actors: readonly ActorIdentity[];
  readonly roles: readonly RoleIdentity[];
  readonly memberships: readonly ProjectMembership[];
}

export interface AuthorizationRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly permission: string;
}

export type AuthorizationResult =
  | { readonly ok: true; readonly scope: AuthorizationRequest; readonly roleId: string; readonly actorType: ActorType }
  | { readonly ok: false; readonly reason: 'SCOPE_INVALID' | 'TENANT_NOT_AUTHORIZED' | 'PROJECT_NOT_AUTHORIZED' | 'ACTOR_NOT_AUTHORIZED' | 'MEMBERSHIP_NOT_AUTHORIZED' | 'ROLE_NOT_AUTHORIZED' };

export interface AuthorizationDirectoryRow {
  readonly tenantActive?: boolean;
  readonly projectActive?: boolean;
  readonly actorType?: ActorType;
  readonly actorActive?: boolean;
  readonly roleId?: string;
  readonly roleActive?: boolean;
  readonly permissions?: readonly string[];
  readonly membershipActive?: boolean;
}

export function decideAuthorization(
  request: AuthorizationRequest,
  row: AuthorizationDirectoryRow,
): AuthorizationResult {
  if (!row.tenantActive) return { ok: false, reason: 'TENANT_NOT_AUTHORIZED' };
  if (!row.projectActive) return { ok: false, reason: 'PROJECT_NOT_AUTHORIZED' };
  if (!row.actorActive || !row.actorType) return { ok: false, reason: 'ACTOR_NOT_AUTHORIZED' };
  if (!row.membershipActive) return { ok: false, reason: 'MEMBERSHIP_NOT_AUTHORIZED' };
  if (!row.roleActive || !row.roleId || !row.permissions?.includes(request.permission)) {
    return { ok: false, reason: 'ROLE_NOT_AUTHORIZED' };
  }
  return { ok: true, scope: request, roleId: row.roleId, actorType: row.actorType };
}

/**
 * Tenant/project authorization choke point. It never infers a tenant, project,
 * role, or membership and never treats actor existence as project membership.
 */
export class IdentityScopeService {
  constructor(private readonly directory: IdentityDirectory) {}

  authorize(request: AuthorizationRequest): AuthorizationResult {
    const ids = [request.tenantId, request.projectId, request.actorId];
    if (ids.some((value) => !value.trim() || !ID_PATTERN.test(value) || value === '.' || value === '..' || value.includes('..'))
      || !/^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/u.test(request.permission)) {
      return { ok: false, reason: 'SCOPE_INVALID' };
    }
    const tenant = this.directory.tenants.find((item) => item.id === request.tenantId);
    const project = this.directory.projects.find((item) => item.id === request.projectId && item.tenantId === request.tenantId);
    const actor = this.directory.actors.find((item) => item.id === request.actorId && item.tenantId === request.tenantId);
    const membership = this.directory.memberships.find((item) => item.actorId === request.actorId && item.projectId === request.projectId);
    const role = this.directory.roles.find((item) =>
      item.id === membership?.roleId && item.tenantId === request.tenantId
    );
    return decideAuthorization(request, {
      tenantActive: tenant?.active,
      projectActive: project?.active,
      actorType: actor?.actorType,
      actorActive: actor?.active,
      roleId: role?.id,
      roleActive: Boolean(role),
      permissions: role?.permissions,
      membershipActive: membership?.active,
    });
  }
}

/** Where the project id came from, so a migration can be audited. */
export type ProjectIdSource = 'project_id' | 'engagement_id';

export interface BlroScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly actorType: ActorType;
  readonly projectIdSource: ProjectIdSource;
  /**
   * True when the actor's output must be reviewable by a human before it is
   * treated as final. An AI engineer proposes; a human PM disposes.
   */
  readonly requiresHumanSupervision: boolean;
}

export type ScopeResolution =
  | { readonly ok: true; readonly value: BlroScope }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Just the project half of the scope, for callers that isolate data but do not
 * attribute it — the RLS row scope is `project_id` alone. Kept here so the D1
 * precedence rule (explicit project id wins, engagement id is its seed) and the
 * id validation have exactly one definition.
 */
export type ProjectIdResolution =
  | { readonly ok: true; readonly projectId: string; readonly source: ProjectIdSource }
  | { readonly ok: false; readonly reason: string };

export interface ResolveScopeInput {
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * One safe path/identifier segment. Deliberately the same shape the legacy
 * engagement id already enforces, so promotion needs no data rewrite.
 */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

function validateId(
  raw: string | undefined,
  missing: string,
  invalid: string,
  reasons: string[],
): string | undefined {
  const value = raw?.trim();
  if (!value) {
    reasons.push(missing);
    return undefined;
  }
  // '.' and '..' would collapse a scope back onto its parent when a scope value
  // is ever used as a path segment, which is an isolation break, not a typo.
  if (value === '.' || value === '..' || value.includes('..') || !ID_PATTERN.test(value)) {
    reasons.push(invalid);
    return undefined;
  }
  return value;
}

/**
 * Resolve the caller's scope from injected environment values.
 *
 * Never reads `process.env` itself and never copies a credential into the
 * result: an API key or approval secret authenticates the actor elsewhere and
 * must not travel inside an attribution record.
 */
/**
 * Resolve only the project id. Fail-closed: an absent or malformed value
 * REFUSES and never falls back to a shared scope.
 */
export function resolveProjectId(
  env: Readonly<Record<string, string | undefined>>,
): ProjectIdResolution {
  // D1: an explicit project id wins; the legacy engagement id is its seed.
  const explicitProject = env.SANGFOR_PROJECT_ID?.trim();
  const legacyEngagement = env.SANGFOR_ENGAGEMENT_ID?.trim();
  const source: ProjectIdSource = explicitProject ? 'project_id' : 'engagement_id';
  const reasons: string[] = [];
  const projectId = validateId(
    explicitProject || legacyEngagement,
    'PROJECT_ID_MISSING',
    'PROJECT_ID_INVALID',
    reasons,
  );
  if (!projectId) return { ok: false, reason: reasons[0] ?? 'PROJECT_ID_MISSING' };
  return { ok: true, projectId, source };
}

export function resolveBlroScope(input: ResolveScopeInput): ScopeResolution {
  const env = input.env;
  const reasons: string[] = [];

  const tenantId = validateId(env.SANGFOR_TENANT_ID, 'TENANT_ID_MISSING', 'TENANT_ID_INVALID', reasons);

  const project = resolveProjectId(env);
  if (!project.ok) reasons.push(project.reason);
  const projectIdSource: ProjectIdSource = project.ok ? project.source : 'engagement_id';
  const projectId = project.ok ? project.projectId : undefined;

  const actorId = validateId(env.SANGFOR_ACTOR_ID, 'ACTOR_ID_MISSING', 'ACTOR_ID_INVALID', reasons);

  const actorTypeRaw = env.SANGFOR_ACTOR_TYPE?.trim();
  let actorType: ActorType | undefined;
  if (!actorTypeRaw) {
    reasons.push('ACTOR_TYPE_MISSING');
  } else if (!(ACTOR_TYPES as readonly string[]).includes(actorTypeRaw)) {
    // Never coerce an unknown actor type to a default: a mislabelled actor
    // silently breaks the supervision model.
    reasons.push('ACTOR_TYPE_INVALID');
  } else {
    actorType = actorTypeRaw as ActorType;
  }

  if (reasons.length > 0 || !tenantId || !projectId || !actorId || !actorType) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    value: {
      tenantId,
      projectId,
      actorId,
      actorType,
      projectIdSource,
      requiresHumanSupervision: actorType === 'ai_engineer',
    },
  };
}

/**
 * Stable one-line attribution for audit records and PM-facing surfaces.
 * Contains identifiers only — never a credential.
 */
export function describeAttribution(scope: BlroScope): string {
  return `${scope.actorId} (${scope.actorType}) on ${scope.tenantId}/${scope.projectId}`;
}
