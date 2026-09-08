import { parseRuntimeJson } from '../../shared/src/runtime-schema.js';
import type { StrategyStore } from './store.js';
import { strategyStoreRuntimeSchema } from './runtime-boundary-codecs.js';

export function parseBoundaryLearningStrategyStoreV1(source: string): StrategyStore {
  return parseRuntimeJson(source, {
    schema: strategyStoreRuntimeSchema,
    schemaName: 'learning-strategy.store.v1',
    policy: 'freeze',
    expectedVersion: 1,
    versionPath: ['schemaVersion'],
    uniqueCollections: [
      { path: ['mirrorOutbox'], key: 'eventId' },
      { path: ['mirrorReceipts'], key: 'eventId' },
    ],
  });
}
