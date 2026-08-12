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
 * It is not an IAM system: no roles, no permissions matrix, no org chart, no
 * billing. Anything beyond attribution and isolation belongs elsewhere.
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
export function resolveBlroScope(input: ResolveScopeInput): ScopeResolution {
  const env = input.env;
  const reasons: string[] = [];

  const tenantId = validateId(env.SANGFOR_TENANT_ID, 'TENANT_ID_MISSING', 'TENANT_ID_INVALID', reasons);

  // D1: an explicit project id wins; the legacy engagement id is its seed.
  const explicitProject = env.SANGFOR_PROJECT_ID?.trim();
  const legacyEngagement = env.SANGFOR_ENGAGEMENT_ID?.trim();
  const projectIdSource: ProjectIdSource = explicitProject ? 'project_id' : 'engagement_id';
  const projectRaw = explicitProject || legacyEngagement;
  const projectId = validateId(projectRaw, 'PROJECT_ID_MISSING', 'PROJECT_ID_INVALID', reasons);

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
