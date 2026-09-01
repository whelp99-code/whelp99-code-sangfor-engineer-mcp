import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCanonicalWorkAtomCatalog } from '../packages/sangfor-competency/src/index.js';

const REPO_CATALOG = join(import.meta.dirname, '..', 'data', 'competency');
const roots: string[] = [];

type RawAtom = {
  readonly id: string;
  readonly automatability: 'auto' | 'hybrid' | 'human';
  readonly [key: string]: unknown;
};

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new Error('fixture value is not canonicalizable');
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

function manifest(atoms: readonly RawAtom[]) {
  const sorted = [...atoms].sort(({ id: left }, { id: right }) => left.localeCompare(right));
  return {
    version: 1,
    semanticSha256: createHash('sha256').update(`sangfor.work-atom-catalog.v1\n${canonical(sorted)}`).digest('hex'),
    atomIds: sorted.map(({ id }) => id),
    counts: {
      atoms: sorted.length,
      automatable: sorted.filter(({ automatability }) => automatability !== 'human').length,
      human: sorted.filter(({ automatability }) => automatability === 'human').length,
    },
  };
}

function fixture(withManifest = true): { readonly root: string; readonly atoms: readonly RawAtom[] } {
  const root = mkdtempSync(join(tmpdir(), 'competency-catalog-manifest-'));
  roots.push(root);
  cpSync(join(REPO_CATALOG, 'work-atoms.json'), join(root, 'work-atoms.json'));
  cpSync(join(REPO_CATALOG, 'capability-maturity.json'), join(root, 'capability-maturity.json'));
  const parsed: unknown = JSON.parse(readFileSync(join(root, 'work-atoms.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('atoms' in parsed) || !Array.isArray(parsed.atoms)) {
    throw new Error('catalog fixture malformed');
  }
  const atoms = parsed.atoms.filter((atom): atom is RawAtom => typeof atom === 'object' && atom !== null && 'id' in atom && 'automatability' in atom);
  if (withManifest) writeFileSync(join(root, 'catalog-manifest.json'), JSON.stringify(manifest(atoms)));
  return { root, atoms };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical WorkAtom catalog manifest', () => {
  it('Given an exact manifest, When the catalog loads, Then its full semantic authority is returned', () => {
    const value = fixture();

    const loaded = loadCanonicalWorkAtomCatalog(value.root);

    expect(loaded).toMatchObject({ ok: true, catalog: { manifest: manifest(value.atoms) } });
  });

  it('Given no manifest, When the catalog loads, Then it refuses rather than accepting an unbound denominator', () => {
    const value = fixture(false);
    expect(loadCanonicalWorkAtomCatalog(value.root).ok).toBe(false);
  });

  it.each(['deleted', 'extra', 'changed', 'classification'] as const)('Given a %s atom change under the old manifest, When loaded, Then the whole catalog refuses', (mutation) => {
    const value = fixture();
    const atoms = [...value.atoms];
    switch (mutation) {
      case 'deleted': atoms.pop(); break;
      case 'extra': {
        const first = value.atoms[0];
        if (first === undefined) throw new Error('fixture atom unavailable');
        atoms.push({ ...first, id: 'invented_atom' });
        break;
      }
      case 'changed':
      case 'classification': {
        const first = atoms[0];
        if (first === undefined) throw new Error('fixture atom unavailable');
        atoms[0] = mutation === 'changed'
          ? { ...first, title: 'semantically changed title' }
          : { ...first, automatability: first.automatability === 'human' ? 'auto' : 'human' };
        break;
      }
      default: mutation satisfies never;
    }
    writeFileSync(join(value.root, 'work-atoms.json'), JSON.stringify({ version: 1, atoms }));

    expect(loadCanonicalWorkAtomCatalog(value.root).ok).toBe(false);
  });
});
