import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCapabilityCampaign,
  loadCanonicalWorkAtomCatalog,
  parseCapabilityCampaign,
} from '../packages/sangfor-competency/src/index.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'capability-evidence-cli.ts');
const REPO_CATALOG = join(REPO_ROOT, 'data', 'competency');
const roots: string[] = [];
const servers: Server[] = [];

type CliResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

function run(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function registryUrl(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ tools: [{
      name: 'sangfor_evaluate_config', description: 'fixture', inputSchema: { type: 'object' },
      annotations: { title: 'Evaluate config', readOnlyHint: true, destructiveHint: false }, category: 'test',
    }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('registry fixture unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'capability-campaign-cli-'));
  roots.push(root);
  return root;
}

function dirtyCatalog(mutation: 'missing_manifest' | 'deleted' | 'extra' | 'changed' | 'classification'): string {
  const root = tempRoot();
  for (const file of ['work-atoms.json', 'capability-maturity.json', 'catalog-manifest.json']) {
    cpSync(join(REPO_CATALOG, file), join(root, file));
  }
  if (mutation === 'missing_manifest') {
    unlinkSync(join(root, 'catalog-manifest.json'));
    return root;
  }
  const value: unknown = JSON.parse(readFileSync(join(root, 'work-atoms.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || !('atoms' in value) || !Array.isArray(value.atoms)) {
    throw new Error('catalog fixture malformed');
  }
  const atoms = [...value.atoms];
  const first = atoms[0];
  if (typeof first !== 'object' || first === null) throw new Error('catalog atom fixture malformed');
  switch (mutation) {
    case 'deleted': atoms.pop(); break;
    case 'extra': atoms.push({ ...first, id: 'invented_atom' }); break;
    case 'changed': atoms[0] = { ...first, title: 'semantically changed title' }; break;
    case 'classification': atoms[0] = { ...first, automatability: 'human' }; break;
    default: mutation satisfies never;
  }
  writeFileSync(join(root, 'work-atoms.json'), JSON.stringify({ version: 1, atoms }));
  return root;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('capability campaign scaffold CLI', () => {
  it('Given a campaign manifest, When an unknown secret field, traversal path, or atom edit is introduced, Then strict parsing or hash binding detects it', () => {
    const loaded = loadCanonicalWorkAtomCatalog();
    if (!loaded.ok) throw new Error('catalog fixture unavailable');
    const manifest = buildCapabilityCampaign('HCI', loaded.catalog);
    const requirement = manifest.requirements[0];
    if (requirement === undefined) throw new Error('campaign requirement unavailable');

    expect(() => parseCapabilityCampaign({ ...manifest, credential: 'do-not-store' }, loaded.catalog)).toThrow();
    expect(() => parseCapabilityCampaign({
      ...manifest,
      paths: { ...manifest.paths, evidenceRoot: '../outside' },
    }, loaded.catalog)).toThrow();
    expect(requirement.atomSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['HCI', 19],
    ['IAG', 16],
    ['EPP', 16],
    ['CC', 17],
  ] as const)('Given an empty task root, When %s is scaffolded, Then its exact relevant atom requirements are hash-bound', async (product, atomCount) => {
    const root = tempRoot();

    const result = await run(['campaign', 'scaffold', '--product', product, '--output', root]);

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(result.stdout.trim()).toBe('CAPABILITY_CAMPAIGN_SCAFFOLD_PASS');
    const manifest = JSON.parse(readFileSync(join(root, `capability-campaign-${product}.v1.json`), 'utf8')) as {
      version: number;
      product: string;
      catalog: { catalogHash: string; atomCount: number };
      requirements: readonly { atomId: string; phase: string; atomSha256: string; evidence: { o5Required: boolean } }[];
      readiness: { status: string; prerequisites: readonly string[] };
      paths: Readonly<Record<string, string>>;
    };
    expect(manifest).toMatchObject({ version: 1, product, catalog: { atomCount: 20 }, readiness: { status: 'BLOCKED' } });
    expect(manifest.catalog.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.requirements).toHaveLength(atomCount);
    expect(new Set(manifest.requirements.map(({ phase }) => phase))).toEqual(new Set(['discover', 'design', 'validate', 'deploy', 'handover', 'operate', 'incident']));
    expect(manifest.requirements.every(({ atomSha256 }) => /^[a-f0-9]{64}$/u.test(atomSha256))).toBe(true);
    expect(Object.values(manifest.paths).every((path) => !path.startsWith('/') && !path.includes('..'))).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/credential|password|secret|token|rawIdentit/iu);
  });

  it.each(['missing_manifest', 'deleted', 'extra', 'changed', 'classification'] as const)('Given a %s canonical catalog, When scaffold runs, Then it emits typed refusal and no 19/15 success', async (mutation) => {
    const output = tempRoot();
    const catalogRoot = dirtyCatalog(mutation);

    const result = await run(['campaign', 'scaffold', '--product', 'HCI', '--output', output], {
      SANGFOR_COMPETENCY_ROOT: catalogRoot,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ violations: [{ code: 'catalog_authority_invalid' }] });
  });

  it('Given a duplicate, traversal, symlink, secret-looking product, or missing arg, When scaffold runs, Then it refuses without overwriting', async () => {
    const root = tempRoot();
    const linked = join(tempRoot(), 'linked');
    symlinkSync(root, linked);
    expect((await run(['campaign', 'scaffold', '--product', 'HCI', '--output', root])).status).toBe(0);
    const before = readFileSync(join(root, 'capability-campaign-HCI.v1.json'), 'utf8');

    const attempts = await Promise.all([
      run(['campaign', 'scaffold', '--product', 'HCI', '--output', root]),
      run(['campaign', 'scaffold', '--product', '../HCI', '--output', root]),
      run(['campaign', 'scaffold', '--product', 'password', '--output', root]),
      run(['campaign', 'scaffold', '--product', 'HCI', '--output', linked]),
      run(['campaign', 'scaffold', '--product', 'HCI']),
      run(['campaign', 'scaffold', '--product', 'HCI', '--output', root, '--force']),
    ]);

    expect(attempts.every(({ status }) => status === 1)).toBe(true);
    expect(readFileSync(join(root, 'capability-campaign-HCI.v1.json'), 'utf8')).toBe(before);
  });
});

describe('capability census CLI', () => {
  it('Given the current immutable catalog, When JSON census runs, Then it lists 20/16/4 and withholds invalid replacement metrics', async () => {
    const url = await registryUrl();

    const result = await run(['census', '--json'], { SANGFOR_HTTP_BRIDGE_URL: url });

    expect(result).toMatchObject({ status: 0, stderr: '' });
    const census = JSON.parse(result.stdout) as {
      totals: { atoms: number; automatable: number; humanOnly: number };
      atoms: readonly { product: string; phase: string; capabilityRef: unknown; toolRef: unknown; claim: { state: string }; requiredEvidence: { o5Status: string } }[];
      blockedPrerequisites: readonly { product: string; status: string }[];
      replacementMetrics?: unknown;
      authority: { status: string };
    };
    expect(census.totals).toEqual({ atoms: 20, automatable: 16, humanOnly: 4 });
    expect(census.atoms).toHaveLength(20);
    expect(census.atoms.every(({ claim }) => ['active', 'stale', 'unverified', 'conflicting'].includes(claim.state))).toBe(true);
    expect(census.blockedPrerequisites).toEqual([
      expect.objectContaining({ product: 'HCI', status: 'BLOCKED' }),
      expect.objectContaining({ product: 'IAG', status: 'BLOCKED' }),
      expect.objectContaining({ product: 'EPP', status: 'BLOCKED' }),
      expect.objectContaining({ product: 'CC', status: 'BLOCKED' }),
    ]);
    expect(census.authority.status).toBe('invalid');
    expect(census).not.toHaveProperty('replacementMetrics');
  });

  it('Given a missing canonical manifest, When census runs, Then no partial census is published', async () => {
    const url = await registryUrl();
    const result = await run(['census', '--json'], {
      SANGFOR_HTTP_BRIDGE_URL: url,
      SANGFOR_COMPETENCY_ROOT: dirtyCatalog('missing_manifest'),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ violations: [{ code: 'catalog_authority_invalid' }] });
  });

  it.each([
    [[]], [['census']], [['census', '--json', '--extra']], [['stale', '--stale']], [['campaign']],
  ] as const)('Given unknown or missing arguments, When the CLI runs, Then it strictly refuses: %j', async (args) => {
    const result = await run(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
