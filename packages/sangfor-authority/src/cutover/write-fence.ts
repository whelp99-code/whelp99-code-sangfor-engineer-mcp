import { AsyncLocalStorage } from 'node:async_hooks';
import {
  assertNoLocalSafetyMarker,
  normalizeLocalWriteIntent,
  type LocalWriteFencePort,
  type LocalWriteIntent,
  type LocalWriteIntentInput,
  type LocalWriteScope,
} from '@sangfor/shared';
import type { AuthorityDatabase } from '../authority-store-contracts.js';
import { AuthorityCutoverError } from './errors.js';
import { PostgresLocalWriteIntentRepository } from './write-intents.js';

export type PostgresWriteFenceFaults = {
  readonly afterIntentCommitted?: (intent: LocalWriteIntent) => void | Promise<void>;
  readonly afterBytesMutated?: (intent: LocalWriteIntent) => void | Promise<void>;
};
type HeldIntent = { readonly scopeKey: string; readonly targetPaths: ReadonlySet<string> };
const heldIntent = new AsyncLocalStorage<HeldIntent>();
const scopeKey = (scope: LocalWriteScope): string =>
  `${scope.tenantId}\0${scope.projectId}\0${scope.actorId}\0${scope.aggregate}\0${scope.epoch}\0${scope.sourceRoot}`;

export class PostgresAuthorityWriteFence implements LocalWriteFencePort {
  readonly authorityKind = 'postgres' as const;
  private readonly intents: PostgresLocalWriteIntentRepository;
  constructor(database: AuthorityDatabase, private readonly faults: PostgresWriteFenceFaults = {}) {
    this.intents = new PostgresLocalWriteIntentRepository(database);
  }

  async write<T>(scope: LocalWriteScope, input: LocalWriteIntentInput, writeBytes: () => T | Promise<T>): Promise<T> {
    assertNoLocalSafetyMarker(scope);
    const intent = normalizeLocalWriteIntent(scope, input);
    const held = heldIntent.getStore();
    if (held?.scopeKey === scopeKey(scope)) {
      if (!intent.targetPaths.every((path) => held.targetPaths.has(path))) {
        throw new AuthorityCutoverError('LOCAL_WRITE_NESTED_TARGET_MISMATCH');
      }
      return writeBytes();
    }
    await this.intents.begin(scope, intent);
    await this.faults.afterIntentCommitted?.(intent);
    assertNoLocalSafetyMarker(scope);
    let result: T;
    try {
      result = await heldIntent.run(
        { scopeKey: scopeKey(scope), targetPaths: new Set(intent.targetPaths) }, writeBytes,
      );
      await this.faults.afterBytesMutated?.(intent);
    } catch (error) {
      try { await this.intents.finish(scope, intent.writeId, 'ABORTED'); }
      catch (reconcileError) {
        throw new AuthorityCutoverError('LOCAL_WRITE_OUTCOME_INDETERMINATE', [intent.writeId], { cause: reconcileError });
      }
      throw error;
    }
    try { await this.intents.finish(scope, intent.writeId, 'COMPLETED'); }
    catch (error) { throw new AuthorityCutoverError('LOCAL_WRITE_OUTCOME_INDETERMINATE', [intent.writeId], { cause: error }); }
    return result;
  }
}
