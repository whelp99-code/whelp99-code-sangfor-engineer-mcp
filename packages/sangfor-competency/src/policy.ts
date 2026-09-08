/**
 * Fail-closed capability-maturity policy loading for the coverage report.
 *
 * `@sangfor/safety` deliberately degrades a corrupt policy to "no maturity
 * evidence" — that is the right call for a SAFETY gate, where less evidence
 * means less permission. For a REPORT the same degradation inverts: an empty
 * policy silently removes every cross-check, so a corrupt file would make every
 * over-claim look verified. Reporting therefore gets its own strict reader and
 * leaves the safety oracle untouched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '../../shared/src/index.js';
import { capabilityKey, maturityPolicyFileSchema, type MaturityPolicyEntry } from './schema.js';
import { violation, type CoverageViolation } from './violations.js';

export type MaturityPolicyLoad =
  | { readonly ok: true; readonly entries: readonly MaturityPolicyEntry[] }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

const POLICY_FILE = 'capability-maturity.json';

export const defaultPolicyRoot = (): string => resolveRepoData('data/competency', 'SANGFOR_COMPETENCY_ROOT');

export function loadMaturityPolicyStrict(root: string = defaultPolicyRoot()): MaturityPolicyLoad {
  const path = join(root, POLICY_FILE);
  if (!existsSync(path)) {
    return { ok: false, violations: [violation('missingCatalog', null, `maturity policy not found at ${path}`)] };
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      violations: [violation('corruptFile', null, `${POLICY_FILE}: unparseable JSON (${error instanceof Error ? error.message : 'unknown error'})`)],
    };
  }

  const parsed = maturityPolicyFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((issue) =>
        violation('schemaInvalid', null, `${POLICY_FILE}: ${issue.path.join('.') || '<root>'} ${issue.message}`)),
    };
  }

  const seen = new Set<string>();
  const duplicates: CoverageViolation[] = [];
  for (const entry of parsed.data.entries) {
    const key = capabilityKey(entry);
    if (seen.has(key)) duplicates.push(violation('duplicateId', null, `capability '${key}' is declared more than once in ${POLICY_FILE}`));
    else seen.add(key);
  }
  if (duplicates.length > 0) return { ok: false, violations: duplicates };

  return { ok: true, entries: parsed.data.entries };
}
