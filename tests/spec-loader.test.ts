import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec, listSpecCoverage } from '../packages/sangfor-spec/src/index.js';

describe('loadSpec', () => {
  it('loads the IAG 13.0.120 seed spec and merges its items', () => {
    const spec = loadSpec('IAG', '13.0.120');
    expect(spec).not.toBeNull();
    expect(spec!.product).toBe('IAG');
    expect(spec!.items.length).toBeGreaterThanOrEqual(3);
    expect(spec!.items.every((i) => i.source?.page)).toBe(true);
  });

  it('normalizes product aliases (SWG/EPP names) to the spec directory', () => {
    const spec = loadSpec('SWG', '13.0.120');
    expect(spec?.product).toBe('IAG');
    expect(loadSpec('HCI/SCP', '6.11.3')?.product).toBe('HCI');
  });

  it('uses ENDPOINT_SECURE as the canonical spec product while reading legacy EPP directories', () => {
    const root = mkdtempSpecRoot();
    const dir = join(root, 'EPP', '6.0.4');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.spec.json'), JSON.stringify({
      id: 'spec_epp_agent',
      product: 'EPP',
      version: '6.0.4',
      items: [{
        id: 'agent_online',
        capabilityId: 'endpoint_inventory',
        label: 'Endpoint agent online',
        observedKey: 'agentOnline',
        op: 'eq',
        expected: true,
        severity: 'must',
        source: { manual: 'Endpoint Secure Manual', page: 'p.1' },
      }],
    }));

    const spec = loadSpec('EPP', '6.0.4', root);

    expect(spec?.product).toBe('ENDPOINT_SECURE');
    expect(spec?.id).toBe('spec_ENDPOINT_SECURE_6_0_4');
    expect(spec?.items[0].capabilityId).toBe('endpoint_inventory');
  });

  it('returns null when no spec exists for the product/version', () => {
    expect(loadSpec('IAG', '99.9.9')).toBeNull();
    expect(loadSpec('MISSING_PRODUCT', '1.0.0')).toBeNull();
  });

  it('reports which products/versions have specs (coverage)', () => {
    const cov = listSpecCoverage();
    expect(cov).toContainEqual(expect.objectContaining({ product: 'IAG', version: '13.0.120' }));
  });

  it('rejects traversal, absolute, drive, whitespace, control, and oversized path segments', () => {
    const root = mkdtempSpecRoot();
    const safeDir = join(root, 'EPP', '6.0.4');
    mkdirSync(safeDir, { recursive: true });
    writeFixture(join(safeDir, 'agent.spec.json'), 'EPP', '6.0.4');

    for (const version of [
      '.', '..', '../EPP/6.0.4', 'EPP/6.0.4', 'EPP\\6.0.4', '/6.0.4', 'C:\\6.0.4',
      ' 6.0.4', '6.0.4 ', '6.0 4', '6.0.4\u0000', '6.0.4\n', 'v'.repeat(65),
    ]) {
      expect(loadSpec('EPP', version, root)).toBeNull();
    }
    for (const product of ['../EPP', 'EPP/child', 'EPP\\child', 'C:\\EPP', '.', '..', 'unknown product', 'x'.repeat(65)]) {
      expect(loadSpec(product, '6.0.4', root)).toBeNull();
    }
    expect(loadSpec('EPP', '6.0.4', root)?.product).toBe('ENDPOINT_SECURE');
  });

  it('refuses symlinked roots, product directories, version directories, and spec files', () => {
    const root = mkdtempSpecRoot();
    const outside = mkdtempSpecRoot();
    const outsideDir = join(outside, 'NGFW', '8.0.0');
    mkdirSync(outsideDir, { recursive: true });
    const outsideSpec = join(outsideDir, 'outside.spec.json');
    writeFixture(outsideSpec, 'NGFW', '8.0.0');

    symlinkSync(join(outside, 'NGFW'), join(root, 'NGFW'));
    expect(loadSpec('NGFW', '8.0.0', root)).toBeNull();

    const iagDir = join(root, 'IAG');
    mkdirSync(iagDir, { recursive: true });
    symlinkSync(outsideDir, join(iagDir, '8.0.0'));
    expect(loadSpec('IAG', '8.0.0', root)).toBeNull();

    const safeDir = join(iagDir, '13.0.120');
    mkdirSync(safeDir, { recursive: true });
    symlinkSync(outsideSpec, join(safeDir, 'linked.spec.json'));
    expect(loadSpec('IAG', '13.0.120', root)).toBeNull();

    const rootLink = `${root}-link`;
    symlinkSync(root, rootLink);
    temporaryRoots.push(rootLink);
    expect(loadSpec('IAG', '13.0.120', rootLink)).toBeNull();
    expect(listSpecCoverage(root)).toEqual([]);
  });
});

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function mkdtempSpecRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sangfor-spec-'));
  temporaryRoots.push(root);
  return root;
}

function writeFixture(path: string, product: string, version: string): void {
  writeFileSync(path, JSON.stringify({
    id: `spec_${product}_${version}`,
    product,
    version,
    items: [{
      id: 'fixture_item',
      capabilityId: 'fixture',
      label: 'Fixture item',
      observedKey: 'fixture',
      op: 'exists',
      severity: 'recommended',
    }],
  }));
}
