/**
 * Golden snapshot corpus loader (design 002, block G1).
 *
 * A fixture pins one vendor payload shape against the normalization and the
 * verdicts it must still produce. Loading validates shape up front so a
 * malformed or half-written fixture fails loud in CI instead of quietly
 * shrinking the regression surface.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IntendedSpec, Verdict } from '@sangfor/spec';

export type GoldenVendor = 'fortios' | 'cisco';

export interface GoldenFixture {
  vendor: GoldenVendor;
  firmware: string;
  /** Already-anonymized vendor payload, keyed by the API call it came from. */
  rawPayload: Record<string, unknown>;
  /** Leaf key names that survive scrubbing — the fixture's own scrub contract. */
  allowlist: string[];
  /** Normalized facts the vendor mapper must produce from rawPayload. */
  expectedObserved: Record<string, unknown>;
  /** Spec evaluated against expectedObserved (kept with the fixture, not loaded from data/). */
  spec: IntendedSpec;
  /** Fixed evaluation time so freshness budgets are reproducible. */
  evaluatedAt: string;
  /** Spec item id → engine verdict. */
  expectedVerdicts: Record<string, Verdict>;
}

const VENDORS: readonly GoldenVendor[] = ['fortios', 'cisco'];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid golden fixture: ${message}`);
}

/** Fixture file names in the corpus directory, sorted for deterministic iteration. */
export function listGoldenFixtures(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

/** Read and validate one fixture. Throws on a missing file or a malformed shape. */
export function loadGoldenFixture(dir: string, name: string): GoldenFixture {
  const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as GoldenFixture;
  assert(VENDORS.includes(parsed.vendor), `unknown vendor "${parsed.vendor}" in ${name}`);
  assert(typeof parsed.firmware === 'string' && parsed.firmware !== '', `missing firmware in ${name}`);
  assert(parsed.rawPayload !== null && typeof parsed.rawPayload === 'object', `missing rawPayload in ${name}`);
  assert(Array.isArray(parsed.allowlist), `missing allowlist in ${name}`);
  assert(parsed.expectedObserved !== null && typeof parsed.expectedObserved === 'object', `missing expectedObserved in ${name}`);
  assert(parsed.spec !== null && typeof parsed.spec === 'object' && Array.isArray(parsed.spec.items), `missing spec in ${name}`);
  assert(typeof parsed.evaluatedAt === 'string' && !Number.isNaN(Date.parse(parsed.evaluatedAt)), `missing evaluatedAt in ${name}`);
  assert(parsed.expectedVerdicts !== null && typeof parsed.expectedVerdicts === 'object', `missing expectedVerdicts in ${name}`);
  const specItemIds = new Set(parsed.spec.items.map((item) => item.id));
  for (const id of Object.keys(parsed.expectedVerdicts)) {
    assert(specItemIds.has(id), `expectedVerdicts references unknown spec item "${id}" in ${name}`);
  }
  return parsed;
}
