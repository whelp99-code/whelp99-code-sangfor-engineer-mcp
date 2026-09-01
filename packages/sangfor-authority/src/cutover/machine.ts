import { AUTHORITY_MANIFEST, type AuthorityAggregate } from '../migration-manifest.js';
import { AuthorityCutoverError } from './errors.js';
import { canonicalRecordSet } from './records.js';
import type { LocalWriteScope } from '@sangfor/shared';
import type { PostgresCutoverRepository } from './postgres-repository.js';
import { removeLocalSafetyMarker, writeLocalSafetyMarker } from './safety-marker.js';
import { CutoverState, type CutoverSourceAdapter, type CutoverTargetAdapter } from './types.js';

function requireAuthoritative(aggregate: AuthorityAggregate): void {
  const entry = AUTHORITY_MANIFEST.entries.find((candidate) => candidate.aggregate === aggregate);
  if (entry?.classification !== 'authoritative' || entry.target.kind !== 'postgres') {
    throw new AuthorityCutoverError('CUTOVER_AGGREGATE_UNSUPPORTED');
  }
}

export class AuthorityCutoverMachine {
  constructor(
    private readonly repository: PostgresCutoverRepository,
    private readonly source: CutoverSourceAdapter,
    private readonly target: CutoverTargetAdapter,
    private readonly localScope: Pick<LocalWriteScope, 'tenantId' | 'actorId' | 'sourceRoot'>,
  ) {
    if (source.aggregate !== target.aggregate) throw new AuthorityCutoverError('CUTOVER_ADAPTER_SCOPE_MISMATCH');
    requireAuthoritative(source.aggregate);
  }

  async status(projectId: string) {
    return this.repository.read({ projectId, aggregate: this.source.aggregate });
  }

  async backfill(projectId: string) {
    const scope = { projectId, aggregate: this.source.aggregate } as const;
    const current = await this.repository.read(scope);
    await this.repository.claimSourceRoot({ ...scope, tenantId: this.localScope.tenantId, sourceRoot: this.localScope.sourceRoot });
    if (current.state !== CutoverState.LOCAL_PRIMARY && current.state !== CutoverState.BACKFILLING) return current;
    const snapshot = await this.source.capture(projectId);
    const started = await this.repository.apply(scope, {
      kind: 'START_BACKFILL', highWaterMark: snapshot.highWaterMark, expectedRevision: current.revision,
    });
    if (started.sourceHighWaterMark !== snapshot.highWaterMark) {
      throw new AuthorityCutoverError('CUTOVER_HIGH_WATER_MARK_CHANGED');
    }
    await this.target.stage({ projectId, highWaterMark: snapshot.highWaterMark, records: snapshot.records });
    const sourceSet = canonicalRecordSet(snapshot.records);
    const targetSet = canonicalRecordSet(await this.target.canonicalRecords(projectId, snapshot.highWaterMark));
    if (sourceSet.digest !== targetSet.digest || sourceSet.count !== targetSet.count
      || sourceSet.keys.join('\0') !== targetSet.keys.join('\0')) {
      throw new AuthorityCutoverError('CUTOVER_PARITY_MISMATCH');
    }
    return this.repository.apply(scope, {
      kind: 'VERIFY_BACKFILL', sourceDigest: sourceSet.digest, targetDigest: targetSet.digest,
      expectedRevision: started.revision,
    });
  }

  async verifyShadow(projectId: string): Promise<void> {
    const scope = { projectId, aggregate: this.source.aggregate } as const;
    const current = await this.repository.read(scope);
    if (current.state !== CutoverState.SHADOW_READING) throw new AuthorityCutoverError('CUTOVER_STATE_CONFLICT');
    const source = await this.source.capture(projectId);
    if (source.highWaterMark !== current.sourceHighWaterMark) throw new AuthorityCutoverError('CUTOVER_SOURCE_CHANGED');
    const sourceSet = canonicalRecordSet(source.records);
    const targetSet = canonicalRecordSet(await this.target.shadowRead(projectId));
    if (sourceSet.digest !== targetSet.digest || sourceSet.keys.join('\0') !== targetSet.keys.join('\0')) {
      throw new AuthorityCutoverError('CUTOVER_SHADOW_MISMATCH');
    }
  }

  async freeze(projectId: string, at: string) {
    const scope = { projectId, aggregate: this.source.aggregate } as const;
    const current = await this.repository.read(scope);
    if (current.state !== CutoverState.SHADOW_READING) throw new AuthorityCutoverError('CUTOVER_STATE_CONFLICT');
    return this.repository.freezeVerified(scope, {
      at,
      expectedRevision: current.revision,
      verifyFinalParity: async (transaction) => {
        const source = await this.source.capture(projectId);
        if (source.highWaterMark !== current.sourceHighWaterMark) throw new AuthorityCutoverError('CUTOVER_SOURCE_CHANGED');
        const sourceSet = canonicalRecordSet(source.records);
        const targetSet = canonicalRecordSet(await this.target.canonicalRecords(projectId, source.highWaterMark, transaction));
        if (sourceSet.digest !== targetSet.digest || sourceSet.keys.join('\0') !== targetSet.keys.join('\0')) {
          throw new AuthorityCutoverError('CUTOVER_SHADOW_MISMATCH');
        }
        if (!current.sourceDigest || !current.targetDigest || !current.sourceHighWaterMark) {
          throw new AuthorityCutoverError('CUTOVER_PARITY_MISSING');
        }
        writeLocalSafetyMarker({
          ...this.localScope, projectId, aggregate: this.source.aggregate, epoch: current.epoch,
          sourceDigest: current.sourceDigest, targetDigest: current.targetDigest,
          highWaterMark: current.sourceHighWaterMark, fencedAt: at,
        });
      },
    });
  }

  async promote(projectId: string) {
    const scope = { projectId, aggregate: this.source.aggregate } as const;
    const current = await this.repository.read(scope);
    return this.repository.apply(scope, { kind: 'PROMOTE', expectedRevision: current.revision });
  }

  async rollback(projectId: string) {
    const scope = { projectId, aggregate: this.source.aggregate } as const;
    const current = await this.repository.read(scope);
    await this.target.cleanup(projectId);
    return this.repository.rollbackVerified(scope, {
      expectedRevision: current.revision,
      removeMarker: () => removeLocalSafetyMarker({ ...this.localScope, projectId, aggregate: this.source.aggregate }),
    });
  }
}
