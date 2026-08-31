import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEngagementScopedData, resolveRepoData, writeFileAtomicSync } from '../../../shared/src/index.js';
import {
  parseBoundaryLoopGapEventV1,
  parseBoundaryLoopGapQueriesV1,
} from '../runtime-boundaries.js';

// P1 — turn captured search gaps into a deduplicated collection queue.
// Reads new SearchGapEvent JSONL lines (delivered by the tick engine) and
// merges them into data/sources/gap-queries.json, which learn:sources can
// consume as KB search terms (consumption wiring is the planned e2 edge).

// Engagement-scoped, and resolved as <scoped feedback dir>/<file> rather than
// scoping the file path itself: resolveEngagementScopedData appends the segment
// at the END, so scoping a file path would yield a DIRECTORY named after the
// file. An explicit SANGFOR_SEARCH_GAPS_PATH is an absolute override and is
// deliberately never scoped. Mirrors apps/mcp-server searchGapFile().
export const GAP_QUERIES_WATCH = () =>
  process.env.SANGFOR_SEARCH_GAPS_PATH
  ?? join(resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT'), 'search-gaps.jsonl');
export const GAP_QUERIES_OUT = () => resolveRepoData('data/sources/gap-queries.json', 'SANGFOR_GAP_QUERIES_PATH');

export interface GapEventLine {
  id?: string;
  ts?: string;
  query: string;
  product?: string;
  hitCount: number;
  topScore?: number;
  reason: 'no_hits' | 'low_score';
}

export interface GapQueryEntry {
  query: string;
  count: number;
  products: string[];
  lastSeen: string;
}

export interface GapQueriesFile { version: 1; updatedAt: string; queries: GapQueryEntry[] }

const normalizeQuery = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, ' ');

export function runGapQueriesExecutor(input: { newLines?: string[]; outPath?: string }): { detail: string } {
  const outPath = input.outPath ?? GAP_QUERIES_OUT();
  const newLines = input.newLines ?? [];
  let existing: GapQueriesFile = { version: 1, updatedAt: '', queries: [] };
  if (existsSync(outPath)) {
    // Fail closed on corruption: silently restarting from empty would both lose
    // accumulated counts and duplicate nothing visibly — the quiet kind of loss.
    existing = parseBoundaryLoopGapQueriesV1(readFileSync(outPath, 'utf8'));
  }
  const byQuery = new Map(existing.queries.map((q) => [q.query, q]));
  for (const line of newLines) {
    const event = parseBoundaryLoopGapEventV1(line);
    const query = normalizeQuery(event.query);
    const entry = byQuery.get(query) ?? { query, count: 0, products: [], lastSeen: '' };
    entry.count += 1;
    entry.lastSeen = event.ts ?? new Date().toISOString();
    if (event.product && !entry.products.includes(event.product)) entry.products = [...entry.products, event.product].sort();
    byQuery.set(query, entry);
  }
  const payload: GapQueriesFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    queries: [...byQuery.values()].sort((a, b) => b.count - a.count || a.query.localeCompare(b.query)),
  };
  writeFileAtomicSync(outPath, JSON.stringify(payload, null, 2));
  return { detail: `${payload.queries.length} queries, ${newLines.length} merged, 0 skipped` };
}
