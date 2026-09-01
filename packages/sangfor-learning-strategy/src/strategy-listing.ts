import type { StrategyScope } from './resolver.js';
import type { StrategyListPage, StrategyListRequest } from './service-contracts.js';
import { allStrategyRevisions, type StrategyStoreAccess } from './strategy-store-access.js';
import type { StrategyRevision } from './store.js';

/** Cursor-paged listing of the revisions a root holds, filtered by exact identity. */

export function decodeStrategyCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const value = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^[A-Za-z0-9-]{8,128}$/u.test(value)) throw new Error();
    return value;
  } catch { throw new Error('INVALID_CURSOR: cursor is malformed.'); }
}

export function listStrategyRevisions(access: StrategyStoreAccess, request: StrategyListRequest): StrategyListPage {
  const limit: number = request.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_INPUT: limit must be 1..100.');
  const after = decodeStrategyCursor(request.cursor as string | undefined);
  const matches = allStrategyRevisions(access)
    .filter((revision): revision is StrategyRevision & { scope: StrategyScope } => revision.scope !== undefined)
    .filter((revision) => request.strategyId === undefined || revision.strategyId === request.strategyId)
    .filter((revision) => request.vendor === undefined || revision.vendor === request.vendor)
    .filter((revision) => request.product === undefined || revision.scope.product === request.product)
    .filter((revision) => request.firmwareVersion === undefined || revision.scope.firmwareVersion === request.firmwareVersion)
    .filter((revision) => request.status === undefined || revision.state === request.status)
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
  const start = after === undefined ? 0 : matches.findIndex((revision) => revision.revisionId === after) + 1;
  if (after !== undefined && start === 0) throw new Error('INVALID_CURSOR: cursor does not identify the current result set.');
  const page = matches.slice(start, start + limit);
  const items = page.map((revision) => ({
    strategyId: revision.strategyId,
    revisionId: revision.revisionId,
    ...(revision.vendor === undefined ? {} : { vendor: revision.vendor }),
    product: revision.scope.product,
    firmwareVersion: revision.scope.firmwareVersion,
    status: revision.state,
    createdAt: revision.createdAt,
  }));
  const last = page.at(-1);
  return start + page.length < matches.length && last
    ? { items, nextCursor: Buffer.from(last.revisionId, 'utf8').toString('base64url') }
    : { items };
}
