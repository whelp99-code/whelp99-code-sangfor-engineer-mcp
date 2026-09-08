/**
 * Characterization: the committed WorkAtom catalog as it stands today.
 *
 * Locks the two facts the canonicalization work must preserve (20 total /
 * 16 automatable / 4 human-only) and the caller discrepancy it must remove:
 * a caller that supplies no grounding counts 2 replaced atoms, while a caller
 * that grounds coveredBy against the tool registry and evidence against a
 * confined artifact root counts only 1. Two honest surfaces must not be able
 * to print two different "1인 대체율" from the same curated data.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkAtomCatalog, type WorkAtom } from '../packages/sangfor-competency/src/index.js';

const curatedAtoms = (): readonly WorkAtom[] => {
  const loaded = loadWorkAtomCatalog();
  if (!loaded.ok) throw new Error(`curated catalog failed to load: ${loaded.violations.map((v) => v.detail).join('; ')}`);
  return loaded.atoms;
};

const REPO_ROOT = join(import.meta.dirname, '..');
const CATALOG = join(REPO_ROOT, 'data', 'competency', 'work-atoms.json');

interface RawAtom {
  readonly id: string;
  readonly automatability: string;
  readonly maturity: string;
  readonly coveredBy?: string | null;
  readonly evidence?: string | null;
}

const rawAtoms = (): readonly RawAtom[] => {
  const parsed: unknown = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const atoms = (parsed as { atoms?: unknown }).atoms;
  if (!Array.isArray(atoms)) throw new Error('work-atoms.json has no atoms array');
  return atoms as readonly RawAtom[];
};

describe('curated WorkAtom catalog — shape that must survive canonicalization', () => {
  it('Given the committed catalog, When loaded, Then it is 20 atoms: 16 automatable + 4 human-only', () => {
    const loaded = curatedAtoms();
    expect(loaded).toHaveLength(20);
    expect(loaded.filter((a) => a.automatability !== 'human')).toHaveLength(16);
    expect(loaded.filter((a) => a.automatability === 'human')).toHaveLength(4);
  });

  it('Given the committed catalog, When ids are normalized, Then every id is unique', () => {
    const ids = curatedAtoms().map((a) => a.id.trim().toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Given the committed catalog, When field_verified atoms are inspected, Then exactly two claim replacement and one of them cites a directory-style evidence string', () => {
    const verified = rawAtoms().filter((a) => a.maturity === 'field_verified' && a.coveredBy && a.evidence);
    expect(verified.map((a) => a.id).sort()).toEqual(['deploy_asbuilt_doc', 'op_daily_health']);

    const asBuilt = verified.find((a) => a.id === 'deploy_asbuilt_doc');
    const dailyHealth = verified.find((a) => a.id === 'op_daily_health');
    // The discrepancy source: prose/dir evidence passes an ungrounded caller and
    // fails a grounded one, so raw counts 2 while grounded counts 1 out of 16.
    expect(asBuilt?.evidence).toBe('outputs/ (generated setting/operations guides)');
    expect(dailyHealth?.evidence).toBe('outputs/diagnosis/EPP_6.0.4_live_diagnosis.md');
  });
});
