import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEngagementScopedData, resolveRepoData } from '../../../shared/src/index.js';
import { parseBoundaryLoopLearnQueueV1 } from '../runtime-boundaries.js';

/**
 * P1b — close the gap→collect edge.
 *
 * `gap-queries` already turns unanswered searches into a deduplicated queue in
 * data/sources/gap-queries.json, but nothing consumed it: edge e2 was declared
 * `manual`, so the engine recorded "manual edge — engine never fires it" and the
 * queue grew forever. The system knew what it did not know and did nothing.
 *
 * This executor makes the edge automatic and observable while keeping the
 * expensive part deliberate:
 *
 *  - By default it QUEUES: it reports the pending gap terms and the collector's
 *    readiness, performing no outbound crawl. Crawling Sangfor community/KB on
 *    every tick is provider-dependent work with real cost and rate limits.
 *  - With SANGFOR_LOOP_AUTO_COLLECT=1 it reports the terms as dispatchable and
 *    surfaces the precondition verdict, mirroring the existing
 *    SANGFOR_LOOP_AUTO_REEMBED=1 precedent for embedding drift.
 *
 * The KB collector additionally needs a logged-in browser exposing CDP. When
 * that is missing the runner drops data/runtime/needs-glass.flag, which nothing
 * read until now — a silent stall. This executor consumes that flag so a stalled
 * collector shows up in the tick outcome instead of rotting on disk.
 */

export const GAP_QUERIES_IN = () =>
  resolveRepoData('data/sources/gap-queries.json', 'SANGFOR_GAP_QUERIES_PATH');

export const NEEDS_GLASS_FLAG = () =>
  join(resolveRepoData('data/runtime'), 'needs-glass.flag');

export interface GapQueryEntry {
  query: string;
  count?: number;
  products?: string[];
  lastSeen?: string;
}

export interface LearnSourcesResult {
  detail: string;
  /** Gap terms waiting to be collected. */
  pending: GapQueryEntry[];
  /** True only when the operator opted in to outbound collection. */
  autoCollect: boolean;
  /** Set when the KB collector precondition is currently unmet. */
  blockedReason?: string;
}

function readGapQueries(path: string): GapQueryEntry[] {
  if (!existsSync(path)) return [];
  return parseBoundaryLoopLearnQueueV1(readFileSync(path, 'utf8')).queries;
}

/** The KB half of collection needs a logged-in browser on CDP; report honestly. */
function readGlassBlock(flagPath: string): string | undefined {
  if (!existsSync(flagPath)) return undefined;
  const raw = readFileSync(flagPath, 'utf8').trim();
  return raw.length > 0 ? raw : 'glass_cdp_unreachable';
}

export function runLearnSourcesExecutor(input: {
  gapQueriesPath?: string;
  glassFlagPath?: string;
  autoCollect?: boolean;
} = {}): LearnSourcesResult {
  const gapQueriesPath = input.gapQueriesPath ?? GAP_QUERIES_IN();
  const glassFlagPath = input.glassFlagPath ?? NEEDS_GLASS_FLAG();
  const autoCollect = input.autoCollect ?? process.env.SANGFOR_LOOP_AUTO_COLLECT === '1';

  const pending = readGapQueries(gapQueriesPath);
  const blockedReason = readGlassBlock(glassFlagPath);

  if (pending.length === 0) {
    return {
      detail: blockedReason
        ? `no pending gap queries; KB collector blocked (${blockedReason})`
        : 'no pending gap queries',
      pending,
      autoCollect,
      ...(blockedReason ? { blockedReason } : {}),
    };
  }

  const terms = pending.map((p) => p.query);
  const preview = terms.slice(0, 3).join('; ');
  const more = terms.length > 3 ? ` (+${terms.length - 3} more)` : '';

  if (blockedReason) {
    return {
      detail: `${pending.length} gap term(s) waiting, KB collector blocked (${blockedReason}): ${preview}${more}`,
      pending,
      autoCollect,
      blockedReason,
    };
  }

  return {
    detail: autoCollect
      ? `${pending.length} gap term(s) dispatchable for collection: ${preview}${more}`
      : `${pending.length} gap term(s) queued; set SANGFOR_LOOP_AUTO_COLLECT=1 to dispatch: ${preview}${more}`,
    pending,
    autoCollect,
  };
}

/** Re-exported so the scope-boundary gate sees the engagement-scoped feedback root. */
export const FEEDBACK_ROOT = () =>
  resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');
