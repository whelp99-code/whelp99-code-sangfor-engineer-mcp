import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI = join(REPO_ROOT, 'scripts', 'report-project-completeness.ts');
const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lowerOnlyCatalog(): { readonly catalogRoot: string; readonly evidenceRoot: string } {
  const catalogRoot = mkdtempSync(join(tmpdir(), 'lower-only-catalog-'));
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'lower-only-evidence-'));
  roots.push(catalogRoot, evidenceRoot);
  writeFileSync(join(catalogRoot, 'capability-maturity.json'), JSON.stringify({
    version: 1,
    entries: [{ product: 'HCI_SCP', capabilityId: 'resource_inventory', maturity: 'tested_mock' }],
  }));
  writeFileSync(join(catalogRoot, 'work-atoms.json'), JSON.stringify({ version: 1, atoms: [{
    id: 'mock-only', product: 'HCI_SCP', phase: 'operate', title: 'mock only',
    automatability: 'auto', coveredBy: 'sangfor_evaluate_config', maturity: 'tested_mock',
  }] }));
  return { catalogRoot, evidenceRoot };
}

async function startBridge(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ tools: [{
      name: 'sangfor_evaluate_config', description: 'evaluate',
      inputSchema: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'] },
      annotations: { title: 'evaluate', readOnlyHint: true, destructiveHint: false }, category: 'advisory',
    }] }));
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('bridge fixture address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function run(args: readonly string[]): Promise<{ readonly status: number | null; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', CLI, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout }));
  });
}

describe('report CLI lazy effective authority', () => {
  it('Given one lower-maturity automatable atom and no evidence or ledger, When strict CLI runs, Then it reports valid 0/1 coverage', async () => {
    // Given
    const roots = lowerOnlyCatalog();
    const registryUrl = await startBridge();

    // When
    const result = await run([
      '--strict', '--json', '--catalog-root', roots.catalogRoot,
      '--evidence-root', roots.evidenceRoot, '--registry-url', registryUrl,
    ]);

    // Then
    expect(result.status).toBe(0);
    const payload = z.object({
      ok: z.boolean(),
      report: z.object({ replacedAtoms: z.number(), automatableAtoms: z.number() }).passthrough(),
    }).passthrough().parse(JSON.parse(result.stdout));
    expect(payload).toEqual(expect.objectContaining({ ok: true, report: expect.objectContaining({ replacedAtoms: 0, automatableAtoms: 1 }) }));
  });
});
