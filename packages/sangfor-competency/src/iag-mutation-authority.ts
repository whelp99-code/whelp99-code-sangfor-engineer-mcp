import { z } from 'zod';
import {
  CanonicalOriginError,
  canonicalizeUrlOrigin,
  digestCanonicalOrigin,
} from '../../shared/src/index.js';
import {
  resolveConfiguredWriteAuthority,
  type WriteAuthorityReferences,
} from './write-authority.js';

const authorities = new WeakSet<object>();
const expectedTarget = {
  product: 'IAG',
  capabilityId: 'internet_policy',
  toolId: 'iag_o1_evidence_campaign',
} as const;

const requestSchema = z.object({
  references: z.object({
    manifestPath: z.string().min(1).max(4096),
    validationContextPath: z.string().min(1).max(4096),
    evidenceRoot: z.string().min(1).max(4096),
    ledgerPath: z.string().min(1).max(4096),
  }).strict(),
  origin: z.string().min(1).max(2048),
  allowedUrlDomains: z.array(z.string().min(1).max(253)).max(100),
  allowedApplicationIds: z.array(z.string().min(1).max(128)).max(100),
  now: z.date(),
  firmwareFreshness: z.object({
    maxAgeMs: z.number().int().positive().safe(),
    maxFutureSkewMs: z.number().int().nonnegative().safe(),
  }).strict(),
}).strict().readonly();

export type ResolveIagMutationActionAuthorityInput = {
  readonly references: WriteAuthorityReferences;
  readonly origin: string;
  readonly allowedUrlDomains: readonly string[];
  readonly allowedApplicationIds: readonly string[];
  readonly now: Date;
  readonly firmwareFreshness: {
    readonly maxAgeMs: number;
    readonly maxFutureSkewMs: number;
  };
};

export type IagMutationActionAuthority = {
  readonly product: 'IAG';
  readonly capabilityId: 'internet_policy';
  readonly toolId: 'iag_o1_evidence_campaign';
  readonly authorizationClass: 'ordinary_active' | 'bootstrap_candidate';
  readonly deviceIdentityDigest: string;
  readonly origin: string;
  readonly originDigest: string;
  readonly campaignId: string;
  readonly sessionId: string;
  readonly windowId: string;
  readonly firmwareTruth: Exclude<Awaited<ReturnType<typeof resolveConfiguredWriteAuthority>>, { status: 'refused' }>['scope']['firmwareTruth'];
  readonly implementation: Exclude<Awaited<ReturnType<typeof resolveConfiguredWriteAuthority>>, { status: 'refused' }>['scope']['implementation'];
  readonly allowedIntents: {
    readonly urlDomains: readonly string[];
    readonly applicationIds: readonly string[];
  };
  readonly now: string;
  readonly firmwareFreshness: {
    readonly maxAgeMs: number;
    readonly maxFutureSkewMs: number;
  };
};

export type IagMutationActionAuthorityResult =
  | { readonly ok: true; readonly authority: IagMutationActionAuthority }
  | { readonly ok: false; readonly code: 'IAG_MUTATION_AUTHORITY_REFUSED' };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

export async function resolveIagMutationActionAuthority(
  input: ResolveIagMutationActionAuthorityInput,
  options: { readonly persistStaleness?: boolean } = {},
): Promise<IagMutationActionAuthorityResult> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'IAG_MUTATION_AUTHORITY_REFUSED' };
  if (new Set(parsed.data.allowedUrlDomains).size !== parsed.data.allowedUrlDomains.length
    || new Set(parsed.data.allowedApplicationIds).size !== parsed.data.allowedApplicationIds.length
    || parsed.data.allowedUrlDomains.length + parsed.data.allowedApplicationIds.length === 0) {
    return { ok: false, code: 'IAG_MUTATION_AUTHORITY_REFUSED' };
  }

  let origin: string;
  try {
    origin = canonicalizeUrlOrigin(parsed.data.origin, 'origin');
  } catch (error) {
    if (error instanceof CanonicalOriginError) return { ok: false, code: 'IAG_MUTATION_AUTHORITY_REFUSED' };
    throw error;
  }
  if (origin !== parsed.data.origin) return { ok: false, code: 'IAG_MUTATION_AUTHORITY_REFUSED' };

  const persistence: 'read_only' | 'persist_staleness' = options.persistStaleness === false
    ? 'read_only'
    : 'persist_staleness';
  const ordinary = await resolveConfiguredWriteAuthority({
    references: parsed.data.references, persistence,
    expected: { ...expectedTarget, mode: 'ordinary_field' },
  });
  const resolved = ordinary.status === 'ordinary_active' ? ordinary : await resolveConfiguredWriteAuthority({
    references: parsed.data.references, persistence,
    expected: { ...expectedTarget, mode: 'bootstrap_mock' },
  });
  if ((resolved.status !== 'ordinary_active' && resolved.status !== 'bootstrap_candidate')
    || resolved.scope.originDigest !== digestCanonicalOrigin(origin, 'origin')) {
    return { ok: false, code: 'IAG_MUTATION_AUTHORITY_REFUSED' };
  }

  const authority: IagMutationActionAuthority = deepFreeze({
    product: 'IAG', capabilityId: 'internet_policy', toolId: 'iag_o1_evidence_campaign',
    authorizationClass: resolved.status,
    deviceIdentityDigest: resolved.scope.deviceId,
    origin,
    originDigest: resolved.scope.originDigest,
    campaignId: resolved.scope.campaignId,
    sessionId: resolved.scope.sessionId,
    windowId: resolved.scope.windowId,
    firmwareTruth: resolved.scope.firmwareTruth,
    implementation: resolved.scope.implementation,
    allowedIntents: {
      urlDomains: [...parsed.data.allowedUrlDomains],
      applicationIds: [...parsed.data.allowedApplicationIds],
    },
    now: parsed.data.now.toISOString(),
    firmwareFreshness: parsed.data.firmwareFreshness,
  });
  authorities.add(authority);
  return { ok: true, authority };
}

export function isIagMutationActionAuthority(value: unknown): value is IagMutationActionAuthority {
  return typeof value === 'object' && value !== null && authorities.has(value);
}
