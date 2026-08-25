/**
 * CI gate: the MCP tool census comes from the running server, never from prose.
 *
 * Boots the same stdio entrypoint the smoke check uses, reads `tools/list`, and
 * checks the annotation/write-set invariants. Documented counts are compared only
 * for `--documented <file>` sources, which is how the docs-regeneration task
 * proves a sentence is stale without this gate ever owning a number itself.
 */
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  evaluateInventoryTruth,
  parseToolInventory,
  type DocumentedCount,
  type DocumentedCountInput,
  type InventoryReport,
  type ToolInventory,
} from './lib/mcp-inventory-truth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOOT_TIMEOUT_MS = 60_000;
const DOCUMENTED_COUNT = /(\d+)\s*(?:개\s*)?(?:MCP\s*)?tools?\b|(\d+)\s*개\s*도구/gi;

type CliOptions = {
  readonly documentedSources: readonly string[];
  readonly offlineInventory: string | undefined;
  readonly json: boolean;
};

function parseArgs(argv: readonly string[]): CliOptions {
  const documentedSources: string[] = [];
  let offlineInventory: string | undefined;
  for (const [index, arg] of argv.entries()) {
    const value = argv[index + 1];
    if (value === undefined) continue;
    if (arg === '--documented') documentedSources.push(value);
    if (arg === '--offline-inventory') offlineInventory = value;
  }
  return { documentedSources, offlineInventory, json: argv.includes('--json') };
}

function readDocumentedCounts(sources: readonly string[]): DocumentedCountInput {
  if (sources.length === 0) return { kind: 'not_compared' };
  // One doc repeats the same sentence many times; a reader only needs to be told
  // once per distinct claimed number which file makes the claim.
  const claims = new Map<string, DocumentedCount>();
  for (const source of sources) {
    const text = readFileSync(source, 'utf8');
    for (const match of text.matchAll(DOCUMENTED_COUNT)) {
      const digits = match[1] ?? match[2];
      if (digits === undefined) continue;
      claims.set(`${source}:${digits}`, { source: `${source} claims ${digits}`, count: Number(digits) });
    }
  }
  return { kind: 'required', counts: [...claims.values()] };
}

function sendRpc(stdin: Writable, message: Record<string, unknown>): void {
  stdin.write(`${JSON.stringify(message)}\n`);
}

async function readLiveInventory(): Promise<ToolInventory> {
  const child = spawn('pnpm', ['exec', 'tsx', 'apps/mcp-server/src/index.ts'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MCP_PROBE: '1' },
  });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise<ToolInventory>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP_INVENTORY_TIMEOUT: server did not answer tools/list')), BOOT_TIMEOUT_MS);
      const settle = (finish: () => void): void => {
        clearTimeout(timer);
        finish();
      };
      child.on('error', (error) => settle(() => reject(error)));
      child.on('exit', (code) => settle(() => reject(new Error(`MCP_INVENTORY_EXIT: server exited with code ${String(code)}`))));
      lines.on('line', (line: string) => {
        const message: unknown = ((): unknown => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })();
        if (typeof message !== 'object' || message === null) return;
        const record: Record<string, unknown> = { ...message };
        if (record['error'] !== undefined) {
          settle(() => reject(new Error(`MCP_INVENTORY_RPC_ERROR: ${JSON.stringify(record['error'])}`)));
          return;
        }
        if (record['id'] === 1) {
          sendRpc(child.stdin, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          return;
        }
        if (record['id'] === 2) {
          settle(() => resolve(parseToolInventory(JSON.stringify(record['result']))));
        }
      });
      sendRpc(child.stdin, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'inventory-truth', version: '1.0' } },
      });
    });
  } finally {
    lines.close();
    child.kill();
  }
}

function render(report: InventoryReport, origin: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ marker: report.ok ? 'MCP_INVENTORY_TRUTH_PASS' : 'MCP_INVENTORY_TRUTH_FAIL', origin, ...report }, null, 2)}\n`);
    return;
  }
  const { total, writeTools, destructiveTools } = report.summary;
  if (report.ok) {
    process.stdout.write(`MCP_INVENTORY_TRUTH_PASS: ${total} tools from ${origin} (${writeTools.length} write, ${destructiveTools.length} destructive)\n`);
    return;
  }
  process.stdout.write(`MCP_INVENTORY_TRUTH_FAIL: ${report.violations.length} violation(s) against ${total} tools from ${origin}\n`);
  for (const violation of report.violations) {
    process.stdout.write(`  - [${violation.code}] ${violation.subject}: ${violation.detail}\n`);
  }
}

async function main(): Promise<number> { // no-excuse-ok: catch
  const options = parseArgs(process.argv.slice(2));
  try {
    const inventory = options.offlineInventory === undefined
      ? await readLiveInventory()
      : parseToolInventory(readFileSync(options.offlineInventory, 'utf8'));
    const report = evaluateInventoryTruth(inventory, readDocumentedCounts(options.documentedSources));
    render(report, options.offlineInventory ?? 'the live stdio server', options.json);
    return report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`MCP_INVENTORY_TRUTH_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

process.exit(await main());
