import { randomUUID } from 'node:crypto';
import {
  decideAuthorization,
  type ActorType,
  type AuthorizationResult,
} from '@sangfor/identity';
import {
  buildAuditEvent,
  verifyAuditEvents,
  type AuditEvent,
} from './audit.js';

export {
  buildAuditEvent,
  verifyAuditEvents,
  type AuditEvent,
  type AuditEventInput,
} from './audit.js';
export {
  AUTHORITY_MIGRATIONS,
  type AuthorityAggregate,
} from './migrations.js';


export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown[]>(query: string, ...values: unknown[]): Promise<T>;
}

export interface AuthorityDatabase extends SqlExecutor {
  $transaction<T>(work: (tx: SqlExecutor) => Promise<T>, options?: { isolationLevel?: 'Serializable' }): Promise<T>;
}

export interface AuthorityActorScope {
  readonly tenantId: string;
  readonly projectId: string;
  readonly actorId: string;
}

function requireId(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(value) || value === '.' || value === '..' || value.includes('..')) {
    throw new Error(`AUTHORITY_INPUT_INVALID: ${label}`);
  }
}

function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      /password|secret|token|authorization|cookie/i.test(key) ? '***' : mask(nested),
    ]));
  }
  return value;
}

/**
 * The sole mutation API for BLRO authority tables. Callers receive scoped read
 * models, never a Prisma client, so a second aggregate writer cannot emerge by
 * convenience. Every project operation sets RLS scope in the same transaction.
 */
export class BlroAuthorityStore {
  constructor(private readonly db: AuthorityDatabase, private readonly auditSecret?: string) {}

  private async scoped<T>(projectId: string, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    requireId(projectId, 'projectId');
    return this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, projectId);
      return work(tx);
    }, { isolationLevel: 'Serializable' });
  }

  private async authorizationRows(
    tx: SqlExecutor,
    input: AuthorityActorScope & { readonly permission: string },
  ): Promise<Array<{
    tenantActive: boolean; projectActive: boolean; actorType: ActorType | null;
    actorActive: boolean; roleId: string | null; roleActive: boolean;
    permissions: string[]; membershipActive: boolean;
  }>> {
    return tx.$queryRawUnsafe(
      `SELECT
         EXISTS(SELECT 1 FROM "BlroTenant" t WHERE t."id"=$1) AS "tenantActive",
         EXISTS(SELECT 1 FROM "BlroProject" p WHERE p."id"=$2 AND p."tenantId"=$1 AND p."status"='active') AS "projectActive",
         (SELECT a."actorType" FROM "BlroActor" a WHERE a."id"=$3 AND a."tenantId"=$1 LIMIT 1) AS "actorType",
         EXISTS(SELECT 1 FROM "BlroActor" a WHERE a."id"=$3 AND a."tenantId"=$1 AND a."revokedAt" IS NULL) AS "actorActive",
         (SELECT m."roleId" FROM "BlroMembership" m WHERE m."projectId"=$2 AND m."actorId"=$3 LIMIT 1) AS "roleId",
         EXISTS(SELECT 1 FROM "BlroRole" r JOIN "BlroMembership" m ON m."roleId"=r."id"
           WHERE r."tenantId"=$1 AND m."projectId"=$2 AND m."actorId"=$3) AS "roleActive",
         COALESCE((SELECT r."permissions" FROM "BlroRole" r JOIN "BlroMembership" m ON m."roleId"=r."id"
           WHERE r."tenantId"=$1 AND m."projectId"=$2 AND m."actorId"=$3 LIMIT 1), ARRAY[]::text[]) AS "permissions",
         EXISTS(SELECT 1 FROM "BlroMembership" m
           WHERE m."projectId"=$2 AND m."actorId"=$3 AND m."revokedAt" IS NULL) AS "membershipActive"`,
      input.tenantId, input.projectId, input.actorId,
    );
  }

  private validateAuthorizationInput(
    input: AuthorityActorScope & { readonly permission: string },
  ): 'SCOPE_INVALID' | null {
    try {
      requireId(input.tenantId, 'tenantId'); requireId(input.projectId, 'projectId'); requireId(input.actorId, 'actorId');
      if (!/^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/u.test(input.permission)) return 'SCOPE_INVALID';
      return null;
    } catch {
      return 'SCOPE_INVALID';
    }
  }

  async authorize(
    input: AuthorityActorScope & { readonly permission: string },
  ): Promise<AuthorizationResult> {
    const invalid = this.validateAuthorizationInput(input);
    if (invalid) return { ok: false, reason: invalid };
    const rows = await this.scoped(input.projectId, (tx) => this.authorizationRows(tx, input));
    const row = rows[0];
    return decideAuthorization(input, {
      tenantActive: row?.tenantActive,
      projectActive: row?.projectActive,
      actorType: row?.actorType ?? undefined,
      actorActive: row?.actorActive,
      roleId: row?.roleId ?? undefined,
      roleActive: row?.roleActive,
      permissions: row?.permissions,
      membershipActive: row?.membershipActive,
    });
  }

  private async authorized<T>(
    input: AuthorityActorScope,
    permission: string,
    work: (tx: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const request = { ...input, permission };
    if (this.validateAuthorizationInput(request)) throw new Error('AUTHORITY_SCOPE_UNAUTHORIZED');
    return this.scoped(input.projectId, async (tx) => {
      const row = (await this.authorizationRows(tx, request))[0];
      if (!decideAuthorization(request, {
        tenantActive: row?.tenantActive,
        projectActive: row?.projectActive,
        actorType: row?.actorType ?? undefined,
        actorActive: row?.actorActive,
        roleId: row?.roleId ?? undefined,
        roleActive: row?.roleActive,
        permissions: row?.permissions,
        membershipActive: row?.membershipActive,
      }).ok) throw new Error('AUTHORITY_SCOPE_UNAUTHORIZED');
      return work(tx);
    });
  }

  async registerDevice(input: AuthorityActorScope & { id: string; name: string; product: string; host: string; metadata?: unknown }): Promise<void> {
    await this.authorized(input, 'registry:write', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "BlroDevice" ("id","tenantId","projectId","createdByActorId","name","product","host","metadata") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      input.id, input.tenantId, input.projectId, input.actorId, input.name, input.product, input.host, JSON.stringify(mask(input.metadata ?? {})),
    ).then(() => undefined));
  }

  async createRun(input: AuthorityActorScope & { id: string; status: string; toolProfileVersion: string; sourceSystem: string }): Promise<void> {
    await this.authorized(input, 'run:write', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "BlroRun" ("id","tenantId","projectId","actorId","status","toolProfileVersion","sourceSystem") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      input.id, input.tenantId, input.projectId, input.actorId, input.status, input.toolProfileVersion, input.sourceSystem,
    ).then(() => undefined));
  }

  async appendStep(input: AuthorityActorScope & { id: string; runId: string; ordinal: number; status: string; payload: unknown }): Promise<void> {
    await this.authorized(input, 'run:write', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "BlroRunStep" ("id","tenantId","projectId","runId","actorId","ordinal","status","payload") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      input.id, input.tenantId, input.projectId, input.runId, input.actorId, input.ordinal, input.status, JSON.stringify(mask(input.payload)),
    ).then(() => undefined));
  }

  async recordApproval(input: AuthorityActorScope & { id: string; actionHash: string; expiresAt: string; status: string }): Promise<void> {
    await this.authorized(input, 'approval:write', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "BlroApproval" ("id","tenantId","projectId","actorId","actionHash","expiresAt","status") VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7)`,
      input.id, input.tenantId, input.projectId, input.actorId, input.actionHash, input.expiresAt, input.status,
    ).then(() => undefined));
  }

  async appendAudit(input: AuthorityActorScope & { kind: string; payload: unknown }): Promise<AuditEvent> {
    return this.authorized(input, 'audit:write', async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `blro-audit:${input.projectId}`);
      const rows = await tx.$queryRawUnsafe<Array<{ projectId: string; seq: bigint | number; kind: string; payload: unknown; prevHash: string; actorId?: string; at: Date | string; hash: string; keyed: boolean }>>(
        `SELECT "projectId","seq","kind","payload","prevHash","actorId","at","hash","keyed" FROM "BlroAuditEvent" WHERE "projectId"=$1 ORDER BY "seq"`, input.projectId,
      );
      const existing: AuditEvent[] = rows.map((row) => ({ ...row, seq: Number(row.seq), at: new Date(row.at).toISOString() }));
      const check = verifyAuditEvents(existing, this.auditSecret);
      if (!check.ok) throw new Error(`AUDIT_CHAIN_TAMPERED: ${check.brokenAt}`);
      const event = buildAuditEvent({ projectId: input.projectId, seq: existing.length, kind: input.kind, payload: mask(input.payload), prevHash: existing.at(-1)?.hash ?? 'GENESIS', actorId: input.actorId }, this.auditSecret);
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroAuditEvent" ("id","tenantId","projectId","seq","at","actorId","kind","payload","prevHash","hash","keyed") VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb,$9,$10,$11)`,
        randomUUID(), input.tenantId, event.projectId, event.seq, event.at, event.actorId ?? null, event.kind, JSON.stringify(event.payload), event.prevHash, event.hash, event.keyed,
      );
      return event;
    });
  }

  async putEvidenceManifest(input: AuthorityActorScope & { id: string; runId: string; contentHash: string; manifest: unknown }): Promise<void> {
    await this.authorized(input, 'evidence:write', (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "BlroEvidenceManifest" ("id","tenantId","projectId","actorId","runId","contentHash","manifest") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      input.id, input.tenantId, input.projectId, input.actorId, input.runId, input.contentHash, JSON.stringify(mask(input.manifest)),
    ).then(() => undefined));
  }

  async putRagDocument(input: AuthorityActorScope & { id: string; title: string; sourceRef: string; contentHash: string; provenance: unknown; chunks: readonly { id: string; text: string; contentHash: string; vector?: unknown; aclActorIds?: readonly string[] }[] }): Promise<void> {
    await this.authorized(input, 'rag:write', async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "BlroRagDocument" ("id","tenantId","projectId","actorId","title","sourceRef","contentHash","provenance") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        input.id, input.tenantId, input.projectId, input.actorId, input.title, input.sourceRef, input.contentHash, JSON.stringify(mask(input.provenance)),
      );
      for (const chunk of input.chunks) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "BlroRagChunk" ("id","tenantId","projectId","documentId","text","contentHash","vector","aclActorIds") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          chunk.id, input.tenantId, input.projectId, input.id, chunk.text, chunk.contentHash, JSON.stringify(chunk.vector ?? null), chunk.aclActorIds ?? [],
        );
      }
    });
  }

  /** SQL WHERE is the candidate boundary; ranking code never receives another project's row. */
  async listRagCandidates(input: AuthorityActorScope): Promise<Array<{ id: string; text: string; vector: unknown }>> {
    return this.authorized(input, 'rag:read', (tx) => tx.$queryRawUnsafe(
      `SELECT "id","text","vector" FROM "BlroRagChunk" WHERE "projectId"=$1 AND (cardinality("aclActorIds")=0 OR $2=ANY("aclActorIds"))`,
      input.projectId, input.actorId,
    ));
  }
}
