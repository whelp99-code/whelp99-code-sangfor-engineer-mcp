import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonl, nowId, resolveEngagementScopedData } from '../../../packages/shared/src/index.js';
import {
  parseBoundaryMcpSearchGapLineV1,
  type SearchGapEvent,
} from './runtime-boundaries.js';

export type { SearchGapEvent } from './runtime-boundaries.js';

const SEARCH_GAP_FILE = 'search-gaps.jsonl';
const DEFAULT_SEARCH_GAP_WEAK_THRESHOLD = 0.15;

function searchGapCaptureEnabled(): boolean {
  return process.env.SANGFOR_SEARCH_GAP_CAPTURE !== '0';
}

export function searchGapWeakThreshold(): number {
  const raw = process.env.SANGFOR_RAG_WEAK_THRESHOLD;
  if (raw === undefined) return DEFAULT_SEARCH_GAP_WEAK_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SEARCH_GAP_WEAK_THRESHOLD;
}

// Same root-resolution convention as packages/sangfor-feedback/src/index.ts:26
// (SANGFOR_FEEDBACK_ROOT override, else data/feedback anchored to the repo root),
// plus engagement scoping (see resolveEngagementScopedData) so search-gap
// capture isolates per customer engagement when SANGFOR_ENGAGEMENT_ID is set.
export function feedbackRoot(): string {
  return resolveEngagementScopedData('data/feedback', 'SANGFOR_FEEDBACK_ROOT');
}

function searchGapFilePath(): string {
  return join(feedbackRoot(), SEARCH_GAP_FILE);
}

export function recordSearchGap(input: { query: string; product?: string; version?: string; hitCount: number; topScore?: number; reason: 'no_hits' | 'low_score' }): void {
  if (!searchGapCaptureEnabled()) return;
  try {
    const event: SearchGapEvent = { id: nowId('search_gap'), ts: new Date().toISOString(), ...input };
    appendJsonl(searchGapFilePath(), event);
  } catch (error) {
    process.stderr.write(`[search-gap] failed to record search gap: ${String(error instanceof Error ? error.message : error)}\n`);
  }
}

export function readSearchGaps(): SearchGapEvent[] {
  let raw: string;
  try {
    raw = readFileSync(searchGapFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseBoundaryMcpSearchGapLineV1(line));
}

// ─── C3: safety self-test ───────────────────────────────────────────────────
// In-process proof that the fail-closed gates actually refuse an unapproved
