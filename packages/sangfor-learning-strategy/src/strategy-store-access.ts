import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalWriteAuthority } from '@sangfor/shared';
import { StrategyStoreManager, type StrategyRevision, type StrategyStore } from './store.js';

/** Filesystem access to the strategy stores held under one root directory. */

export interface StrategyStoreAccess {
  readonly root: string;
  readonly authority: LocalWriteAuthority;
}

export interface OpenedStrategyStore {
  readonly manager: StrategyStoreManager;
  readonly store: StrategyStore;
}

export function uniqueRevisions(store: StrategyStore): StrategyRevision[] {
  const byId = new Map<string, StrategyRevision>();
  for (const revision of store.generations.flatMap((generation) => generation.revisions)) byId.set(revision.revisionId, revision);
  return [...byId.values()];
}

export function strategyStorePath(root: string, strategyId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(strategyId)) throw new Error('INVALID_INPUT: strategyId is invalid.');
  return join(root, `${strategyId}.json`);
}

export function strategyStoreManager(access: StrategyStoreAccess, strategyId: string): StrategyStoreManager {
  return new StrategyStoreManager(strategyStorePath(access.root, strategyId), access.authority);
}

export function openStrategyStore(access: StrategyStoreAccess, strategyId: string): OpenedStrategyStore {
  const manager = strategyStoreManager(access, strategyId);
  const store = manager.load();
  if (!store) throw new Error('STORE_UNAVAILABLE: strategy is missing or corrupt.');
  return { manager, store };
}

export function loadStrategyStores(access: StrategyStoreAccess): OpenedStrategyStore[] {
  if (!existsSync(access.root)) return [];
  return readdirSync(access.root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const manager = new StrategyStoreManager(join(access.root, entry.name), access.authority);
      const store = manager.load();
      if (!store) throw new Error(`STORE_CORRUPT: ${entry.name}`);
      return { manager, store };
    });
}

export function allStrategyRevisions(access: StrategyStoreAccess): StrategyRevision[] {
  return loadStrategyStores(access).flatMap(({ store }) => uniqueRevisions(store));
}
