import { createHash } from 'node:crypto';
import type { AuthorityDatabase, SqlExecutor } from '../authority-store-contracts.js';
import type { AuthorityAggregate } from '../migration-manifest.js';
import { AUTHORITY_ADAPTER_POLICIES, type AuthorityAdapterPolicy } from './adapter-policy.js';
import { AuthorityCutoverError } from './errors.js';
import type { PostgresCutoverRepository } from './postgres-repository.js';
import { CutoverState, type CutoverScope } from './types.js';

function policyFor(aggregate: AuthorityAggregate): AuthorityAdapterPolicy {
  const policy = AUTHORITY_ADAPTER_POLICIES.find((entry) => entry.aggregate === aggregate);
  if (!policy) throw new AuthorityCutoverError('CUTOVER_POLICY_UNKNOWN');
  return policy;
}

export class PostgresNativeAdapter {
  readonly policy: AuthorityAdapterPolicy;
  constructor(
    private readonly database: AuthorityDatabase,
    readonly aggregate: AuthorityAggregate,
    private readonly projectId: string,
  ) {
    this.policy = policyFor(aggregate);
    if (this.policy.policy !== 'postgres_native') throw new AuthorityCutoverError('CUTOVER_NATIVE_POLICY_INVALID');
  }

  async readinessDigest(transaction?: SqlExecutor): Promise<string> {
    const inspect = async (tx: SqlExecutor): Promise<readonly string[]> => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.project_id', $1, true)`, this.projectId);
      const rows: string[] = [];
      const projects = await tx.$queryRawUnsafe<Array<{ ready: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM "BlroProject" WHERE "id"=$1) AS ready`, this.projectId,
      );
      if (projects[0]?.ready !== true) throw new AuthorityCutoverError('CUTOVER_NATIVE_PROJECT_NOT_READY');
      rows.push(`project:${this.projectId}`);
      if (this.aggregate === 'tenant_identity') {
        const identities = await tx.$queryRawUnsafe<Array<{ ready: boolean }>>(
          `SELECT EXISTS (SELECT 1 FROM "BlroMembership" m JOIN "BlroActor" a ON a."id"=m."actorId" JOIN "BlroRole" r ON r."id"=m."roleId" WHERE m."projectId"=$1) AS ready`, this.projectId,
        );
        if (identities[0]?.ready !== true) throw new AuthorityCutoverError('CUTOVER_NATIVE_IDENTITY_NOT_READY');
        rows.push('identity:ready');
      }
      if (this.aggregate === 'project_installation_identity') {
        const enrollment = await tx.$queryRawUnsafe<Array<{ ready: boolean }>>(
          `SELECT EXISTS (SELECT 1 FROM "BlroEnrollmentIdentity" WHERE "projectId"=$1 AND "state"='active') AS ready`, this.projectId,
        );
        if (enrollment[0]?.ready !== true) throw new AuthorityCutoverError('CUTOVER_NATIVE_ENROLLMENT_NOT_READY');
        rows.push('enrollment:ready');
      }
      for (const table of this.policy.targetTables) {
        const result = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
          `SELECT to_regclass($1) IS NOT NULL AS present`, `"${table}"`,
        );
        if (result[0]?.present !== true) throw new AuthorityCutoverError('CUTOVER_NATIVE_TARGET_MISSING', [table]);
        rows.push(table);
      }
      return rows;
    };
    const tables = transaction ? await inspect(transaction)
      : await this.database.$transaction(inspect, { isolationLevel: 'Serializable' });
    return createHash('sha256').update([...tables].sort().join('\n')).digest('hex');
  }

  async prepare(repository: PostgresCutoverRepository) {
    const scope = { projectId: this.projectId, aggregate: this.aggregate } as const;
    const current = await repository.read(scope);
    if (current.state === CutoverState.SHADOW_READING || current.state === CutoverState.FROZEN
      || current.state === CutoverState.POSTGRES_PRIMARY) return current;
    const digest = await this.readinessDigest();
    const started = await repository.apply(scope, {
      kind: 'START_BACKFILL', highWaterMark: `postgres-native:${digest}`, expectedRevision: current.revision,
    });
    return repository.apply(scope, {
      kind: 'VERIFY_BACKFILL', sourceDigest: digest, targetDigest: digest, expectedRevision: started.revision,
    });
  }
}

export class InvalidateOnCutoverAdapter {
  readonly policy: AuthorityAdapterPolicy;
  constructor(
    readonly aggregate: AuthorityAggregate,
    private readonly projectId: string,
  ) {
    this.policy = policyFor(aggregate);
    if (this.policy.policy !== 'invalidate_on_cutover') throw new AuthorityCutoverError('CUTOVER_INVALIDATION_POLICY_INVALID');
  }

  async prepare(repository: PostgresCutoverRepository, expectedEpoch: number) {
    const scope = { projectId: this.projectId, aggregate: this.aggregate } as const;
    const current = await repository.read(scope);
    if (current.epoch !== expectedEpoch) throw new AuthorityCutoverError('CUTOVER_STALE_EPOCH');
    if (current.state === CutoverState.SHADOW_READING || current.state === CutoverState.FROZEN
      || current.state === CutoverState.POSTGRES_PRIMARY) return current;
    const digest = createHash('sha256').update(`invalidate\0${this.aggregate}\0${expectedEpoch}`).digest('hex');
    const started = await repository.apply(scope, {
      kind: 'START_BACKFILL', highWaterMark: `invalidate:${expectedEpoch}`, expectedRevision: current.revision,
    });
    return repository.apply(scope, {
      kind: 'VERIFY_BACKFILL', sourceDigest: digest, targetDigest: digest, expectedRevision: started.revision,
    });
  }

  async verifyFrozen(repository: PostgresCutoverRepository, expectedEpoch: number): Promise<void> {
    await repository.verifyEpochInvalidated(
      { projectId: this.projectId, aggregate: this.aggregate } satisfies CutoverScope,
      expectedEpoch,
    );
  }
}
