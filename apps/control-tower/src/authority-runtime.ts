import { PrismaClient } from '@prisma/client';
import { PostgresSingleUseNonceStore } from '../../../packages/sangfor-approval/src/index.js';
import { BlroAuthorityStore } from '../../../packages/sangfor-authority/src/index.js';
import { PostgresEnrollmentRegistry } from '../../../packages/sangfor-browser-contracts/src/postgres-enrollment-registry.js';
import { PostgresJobIdempotencyStore } from '../../../packages/sangfor-browser-contracts/src/postgres-stores.js';
import {
  parseAuthorityConfig,
  type AuthorityConfig,
  type AuthorityRuntimeEnvironment,
} from './authority-config.js';
import {
  loadAuthorityMaterial,
  type AuthorityMaterial,
} from './authority-material.js';
import {
  createDefaultAuthorityDomainApis,
  parseAuthorityDomainApis,
  type AuthorityDomainApiFactory,
  type AuthorityDomainApis,
} from './authority-domain-apis.js';
import {
  BLRO_RUNTIME_SCHEMA_VERSION,
  firstReadinessFailure,
  probeAuthorityDependencies,
  type AuthorityDependencyChecks,
  type AuthorityProbeResult,
  type AuthorityReadiness,
  type AuthorityReadinessReasonCode,
} from './authority-readiness.js';

export { type AuthorityRuntimeEnvironment } from './authority-config.js';
export { BLRO_RUNTIME_SCHEMA_VERSION, type AuthorityReadiness } from './authority-readiness.js';
export type AuthorityLiveness = {
  readonly ok: boolean;
  readonly state: 'starting' | 'running' | 'draining' | 'closed';
};

export interface AuthorityRuntimePort {
  liveness(): AuthorityLiveness;
  readiness(): Promise<AuthorityReadiness>;
  assertReady(): Promise<void>;
  beginDrain(): void;
  close(): Promise<void>;
}

export class AuthorityUnavailableError extends Error {
  override readonly name = 'AuthorityUnavailableError';
  constructor(readonly reason: AuthorityReadinessReasonCode) {
    super('BLRO authority is not ready');
  }
}

export type AuthorityResources = {
  readonly prisma: PrismaClient;
  readonly authorityStore: BlroAuthorityStore;
  readonly nonceStore: PostgresSingleUseNonceStore;
  readonly enrollmentStore: PostgresEnrollmentRegistry;
  readonly jobStore: PostgresJobIdempotencyStore;
  readonly domainApis: AuthorityDomainApis;
  readonly close: () => Promise<void>;
};

type ResourceFactoryInput = {
  readonly config: AuthorityConfig;
  readonly material: AuthorityMaterial;
  readonly prisma: PrismaClient;
};
type RuntimeOptions = {
  readonly environment?: AuthorityRuntimeEnvironment;
  readonly createDomainApis?: AuthorityDomainApiFactory;
  readonly probeOverride?: () => Promise<boolean>;
};

export function createAuthorityRuntime(options: RuntimeOptions = {}) {
  const environment = options.environment ?? process.env;
  const parsed = parseAuthorityConfig(environment);
  let state: AuthorityLiveness['state'] = 'starting';
  let resources: AuthorityResources | undefined;
  let dependency: AuthorityProbeResult = { database: false, schema: false, scope: false };
  let signingReady = false;
  let trustReady = false;
  let domainApisReady = false;
  let degraded = false;
  let closed = false;

  function report(): AuthorityReadiness {
    const checks: AuthorityDependencyChecks = {
      config: parsed.success
        ? { ok: true }
        : { ok: false, reason: { code: 'CONFIG_INVALID', fields: parsed.issues.map((issue) => issue.field) } },
      database: dependency.database ? { ok: true } : { ok: false, reason: { code: 'DATABASE_UNAVAILABLE' } },
      schema: dependency.schema ? { ok: true } : { ok: false, reason: { code: 'SCHEMA_INVALID' } },
      signing: signingReady ? { ok: true } : { ok: false, reason: { code: 'SIGNING_INVALID' } },
      trust: trustReady ? { ok: true } : { ok: false, reason: { code: 'TRUST_INVALID' } },
      scope: dependency.scope ? { ok: true } : { ok: false, reason: { code: 'SCOPE_INVALID' } },
      domainApis: domainApisReady ? { ok: true } : { ok: false, reason: { code: 'DOMAIN_APIS_INVALID' } },
      drain: state === 'running' ? { ok: true } : { ok: false, reason: { code: 'DRAINING' } },
    };
    return {
      ok: Object.values(checks).every((check) => check.ok) && !degraded,
      schemaVersion: BLRO_RUNTIME_SCHEMA_VERSION,
      checks,
    };
  }

  function assemble(input: ResourceFactoryInput): AuthorityResources | undefined {
    const base = {
      prisma: input.prisma,
      authorityStore: new BlroAuthorityStore(input.prisma, input.config.auditSecret),
      nonceStore: new PostgresSingleUseNonceStore({ database: input.prisma }),
      enrollmentStore: new PostgresEnrollmentRegistry({
        database: input.prisma,
        scope: { tenantId: input.config.tenantId, projectId: input.config.projectId },
        trustedIssuerBundle: input.material.trustBundle,
      }),
      jobStore: new PostgresJobIdempotencyStore(input.prisma, input.config.projectId),
    };
    const dependencies = { ...base, ...input.material };
    let candidate: unknown;
    try {
      candidate = options.createDomainApis
        ? options.createDomainApis(dependencies)
        : createDefaultAuthorityDomainApis(dependencies);
    } catch {
      return undefined;
    }
    const domainApis = parseAuthorityDomainApis(candidate, dependencies);
    if (!domainApis) return undefined;
    domainApisReady = true;
    return { ...base, domainApis, close: () => input.prisma.$disconnect() };
  }

  async function start(): Promise<void> {
    if (!parsed.success) { state = 'running'; return; }
    const material = await loadAuthorityMaterial(
      parsed.data.signingPrivateKeyPath,
      parsed.data.trustBundlePath,
    );
    signingReady = material.ok || material.signing;
    trustReady = material.ok || material.trust;
    if (!material.ok) { degraded = true; state = 'running'; return; }
    const prisma = new PrismaClient({ datasources: { db: { url: parsed.data.databaseUrl } } });
    try {
      dependency = await probeAuthorityDependencies(prisma, parsed.data, options.probeOverride);
    } catch {
      dependency = { database: false, schema: false, scope: false };
      degraded = true;
      await prisma.$disconnect();
      state = 'running';
      return;
    }
    if (!dependency.database || !dependency.schema || !dependency.scope) {
      degraded = true;
      await prisma.$disconnect();
      state = 'running';
      return;
    }
    resources = assemble({ config: parsed.data, material: material.material, prisma });
    if (!resources) await prisma.$disconnect();
    state = 'running';
  }

  async function readiness(): Promise<AuthorityReadiness> {
    if (!resources || !parsed.success || degraded || state !== 'running') return report();
    try {
      dependency = await probeAuthorityDependencies(resources.prisma, parsed.data, options.probeOverride);
      if (!dependency.database || !dependency.schema || !dependency.scope) degraded = true;
    } catch {
      dependency = { database: false, schema: false, scope: false };
      degraded = true;
    }
    return report();
  }

  return {
    start,
    liveness: (): AuthorityLiveness => ({ ok: state === 'running' || state === 'draining', state }),
    readiness,
    async assertReady(): Promise<void> {
      const current = await readiness();
      if (!current.ok) throw new AuthorityUnavailableError(firstReadinessFailure(current));
    },
    async recover(): Promise<void> {
      if (!resources || !parsed.success || state !== 'running') {
        throw new AuthorityUnavailableError(firstReadinessFailure(report()));
      }
      try {
        dependency = await probeAuthorityDependencies(resources.prisma, parsed.data, options.probeOverride);
        degraded = !dependency.database || !dependency.schema || !dependency.scope;
      } catch {
        dependency = { database: false, schema: false, scope: false };
        degraded = true;
      }
      if (degraded) throw new AuthorityUnavailableError(firstReadinessFailure(report()));
    },
    beginDrain(): void { if (state === 'running') state = 'draining'; },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      state = 'draining';
      await resources?.close();
      resources = undefined;
      state = 'closed';
    },
    resources: (): AuthorityResources | undefined => resources,
  } satisfies AuthorityRuntimePort & {
    readonly start: () => Promise<void>;
    readonly recover: () => Promise<void>;
    readonly resources: () => AuthorityResources | undefined;
  };
}
