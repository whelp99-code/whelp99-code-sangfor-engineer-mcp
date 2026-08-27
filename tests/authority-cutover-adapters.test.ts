import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_ADAPTER_POLICIES,
  AUTHORITY_MANIFEST,
  AuthorityCutoverError,
  parseAuthorityAdapterRegistry,
} from '../packages/sangfor-authority/src/index.js';

describe('authority cutover adapter registry', () => {
  it('uses exact native target sets and the real enrollment identity table', () => {
    const native = AUTHORITY_ADAPTER_POLICIES.filter((entry) => entry.policy === 'postgres_native');
    for (const policy of native) {
      const manifest = AUTHORITY_MANIFEST.entries.find((entry) => entry.aggregate === policy.aggregate);
      if (manifest?.target.kind !== 'postgres') throw new Error('native target must be postgres');
      expect([...policy.targetTables].sort()).toEqual([...manifest.target.tables].sort());
    }
    expect(native.find((entry) => entry.aggregate === 'project_installation_identity')?.targetTables)
      .toContain('BlroEnrollmentIdentity');
  });
  it('Given the canonical manifest, When policies are checked, Then all authoritative aggregates are owned exactly once', () => {
    const authoritative = AUTHORITY_MANIFEST.entries
      .filter((entry) => entry.classification === 'authoritative')
      .map((entry) => entry.aggregate).sort();
    expect(AUTHORITY_ADAPTER_POLICIES.map((entry) => entry.aggregate).sort()).toEqual(authoritative);
    expect(AUTHORITY_ADAPTER_POLICIES).toHaveLength(18);
    expect(() => parseAuthorityAdapterRegistry(AUTHORITY_ADAPTER_POLICIES)).not.toThrow();
  });

  it('Given unknown, omitted, duplicate, stale target, or local native source policy, When parsed, Then it fails closed', () => {
    const base = structuredClone(AUTHORITY_ADAPTER_POLICIES);
    expect(() => parseAuthorityAdapterRegistry(base.slice(1))).toThrow(AuthorityCutoverError);
    expect(() => parseAuthorityAdapterRegistry([...base, base[0]])).toThrow(AuthorityCutoverError);
    expect(() => parseAuthorityAdapterRegistry([{ ...base[0], aggregate: 'invented' }, ...base.slice(1)]))
      .toThrow(AuthorityCutoverError);
    expect(() => parseAuthorityAdapterRegistry([{ ...base[0], targetTables: ['Invented'] }, ...base.slice(1)]))
      .toThrow(AuthorityCutoverError);
    const native = base.find((entry) => entry.policy === 'postgres_native');
    if (!native) throw new AuthorityCutoverError('CUTOVER_POLICY_FIXTURE_MISSING');
    expect(() => parseAuthorityAdapterRegistry(base.map((entry) => entry === native
      ? { ...entry, sourceInventoryRefs: ['persist:invented.ts#writer'] }
      : entry))).toThrow(AuthorityCutoverError);
  });
});
