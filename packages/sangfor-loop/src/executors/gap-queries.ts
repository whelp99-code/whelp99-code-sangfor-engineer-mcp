import { existsSync, readFileSync } from 'node:fs';
import { resolveRepoData, writeFileAtomicSync } from '../../../shared/src/index.js';

// P1 — turn captured search gaps into a deduplicated collection queue.
// Reads new SearchGapEvent JSONL lines (delivered by the tick engine) and
// merges them into data/sources/gap-queries.json, which learn:sources can
// consume as KB search terms (consumption wiring is the planned e2 edge).

export const GAP_QUERIES_WATCH = () => resolveRepoData('data/feedback/search-gaps.jsonl', 'SANGFOR_SEARCH_GAPS_PATH');
export const GAP_QUERIES_OUT = () => resolveRepoData('data/sources/gap-queries.json', 'SANGFOR_GAP_QUERIES_PATH');

interface GapEventLine {
  id?: string;
  ts?: string;
  query?: string;
  product?: string;
  reason?: string;
}

export interface GapQueryEntry {
  query: string;
  count: number;
  products: string[];
  lastSeen: string;
}

interface GapQueriesFile { version: 1; updatedAt: string; queries: GapQueryEntry[] }

const normalizeQuery = (query: string): string => query.trim().toLowerCase().replace(/\s+/g, ' ');

export function runGapQueriesExecutor(input: { newLines?: string[]; outPath?: string }): { detail: string } {
  const outPath = input.outPath ?? GAP_QUERIES_OUT();
  const newLines = input.newLines ?? [];
  let existing: GapQueriesFile = { version: 1, updatedAt: '', queries: [] };
  if (existsSync(outPath)) {
    // Fail closed on corruption: silently restarting from empty would both lose
    // accumulated counts and duplicate nothing visibly — the quiet kind of loss.
    try {
      existing = JSON.parse(readFileSync(outPath, 'utf8')) as GapQueriesFile;
    } catch {
      throw new Error(`GAP_QUERIES_CORRUPT: ${outPath}`);
    }
  }
  const byQuery = new Map(existing.queries.map((q) => [q.query, q]));
  let skipped = 0;
  for (const line of newLines) {
    let event: GapEventLine;
    try {
      event = JSON.parse(line) as GapEventLine;
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof event.query !== 'string' || event.query.trim() === '') { skipped += 1; continue; }
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
  return { detail: `${payload.queries.length} queries, ${newLines.length - skipped} merged, ${skipped} skipped` };
}
