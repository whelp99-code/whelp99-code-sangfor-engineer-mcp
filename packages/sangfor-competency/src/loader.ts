/**
 * Fail-closed WorkAtom catalog loading.
 *
 * The old loader skipped an unparseable file with a stderr line and deduped
 * colliding ids in silence, so a half-read catalog still produced a confident
 * percentage. Here a catalog is all-or-nothing: any corrupt file, schema
 * violation, or normalized-id collision refuses the whole load and names the
 * fault, because a denominator assembled from whatever happened to parse is
 * not a measurement.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepoData } from '../../shared/src/index.js';
import { normalizeAtomId, workAtomFileSchema, type WorkAtom, type WorkAtomFile } from './schema.js';
import { violation, type CoverageViolation } from './violations.js';

export type CatalogLoad =
  | { readonly ok: true; readonly atoms: readonly WorkAtom[] }
  | { readonly ok: false; readonly violations: readonly CoverageViolation[] };

export const defaultCatalogRoot = (): string => resolveRepoData('data/competency', 'SANGFOR_COMPETENCY_ROOT');

// `Array.isArray` does not narrow a union whose array arm is `readonly`, so
// discriminate on the wrapper key instead of asserting the shape.
const atomsOf = (parsed: WorkAtomFile): readonly WorkAtom[] =>
  'atoms' in parsed ? parsed.atoms : parsed;

function readCatalogFile(root: string, file: string, sink: CoverageViolation[]): readonly WorkAtom[] {
  let raw: string;
  try {
    raw = readFileSync(join(root, file), 'utf8');
  } catch (error) {
    sink.push(violation('corruptFile', null, `${file}: unreadable (${error instanceof Error ? error.message : 'unknown error'})`));
    return [];
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    sink.push(violation('corruptFile', null, `${file}: unparseable JSON (${error instanceof Error ? error.message : 'unknown error'})`));
    return [];
  }

  const parsed = workAtomFileSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      sink.push(violation('schemaInvalid', null, `${file}: ${issue.path.join('.') || '<root>'} ${issue.message}`));
    }
    return [];
  }
  return atomsOf(parsed.data);
}

/**
 * Non-atom sidecars live in the same directory (capability-maturity.json owns
 * the policy, not the taxonomy) and are addressed by name rather than by
 * "whatever failed to look like atoms", so a genuinely broken atom file can
 * never be mistaken for a sidecar and skipped.
 */
const SIDECAR_FILES: ReadonlySet<string> = new Set(['capability-maturity.json']);

export function loadWorkAtomCatalog(root: string = defaultCatalogRoot()): CatalogLoad {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, violations: [violation('missingCatalog', null, `catalog root is not a directory: ${root}`)] };
  }

  const violations: CoverageViolation[] = [];
  const atoms: WorkAtom[] = [];
  const files = readdirSync(root)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.') && !SIDECAR_FILES.has(f))
    .sort();

  for (const file of files) atoms.push(...readCatalogFile(root, file, violations));

  const seen = new Map<string, string>();
  for (const atom of atoms) {
    const key = normalizeAtomId(atom.id);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, atom.id);
    else violations.push(violation('duplicateId', atom.id, `id '${atom.id}' collides with '${first}' after normalization to '${key}'`));
  }

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, atoms };
}
