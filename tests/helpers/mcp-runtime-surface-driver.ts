import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const RESPONSE_TIMEOUT_MS = 20_000;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonRpcResponse = { readonly id: number; readonly result?: JsonValue; readonly error?: JsonValue };
type PendingResponse = { readonly resolve: (response: JsonRpcResponse) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout };
type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key] ?? null)]));
  }
  return value;
}

function generatedFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), relativePath);
      else files.push(relativePath);
    }
  };
  visit(root, '');
  return files.sort();
}

function normalizeDryRunResult(value: JsonValue | undefined): JsonValue {
  if (value === undefined || !isJsonObject(value) || !isJsonObject(value.structuredContent)) return value ?? null;
  const structuredContent = { ...value.structuredContent, id: '<generated-id>' };
  return {
    ...value,
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}

export async function captureMcpRuntimeSurface(repoRoot: string): Promise<JsonValue> {
  const generatedRoot = mkdtempSync(join(tmpdir(), 'mcp-runtime-surface-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/mcp-server/src/index.ts'], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SANGFOR_SEARCH_GAP_CAPTURE: '0',
      SANGFOR_EMBEDDING_FORCE_HASH: '1',
      SANGFOR_DB_ENABLED: '0',
      SANGFOR_EMBEDDING_PROVIDER: 'hash',
      SANGFOR_FEEDBACK_ROOT: join(generatedRoot, 'feedback'),
      SANGFOR_EVALS_ROOT: join(generatedRoot, 'evals'),
      SANGFOR_WIKI_ROOT: join(generatedRoot, 'wiki'),
      SANGFOR_RUNS_ROOT: join(generatedRoot, 'runs'),
      SANGFOR_EVIDENCE_ROOT: join(generatedRoot, 'evidence'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, PendingResponse>();
  const stderrLines: string[] = [];
  const errors = createInterface({ input: child.stderr });
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  errors.on('line', (line) => {
    stderrLines.push(line);
    if (line === 'sangfor-engineer-mcp stdio server started') resolveStarted?.();
  });
  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => {
    const response = JSON.parse(line) as JsonRpcResponse;
    const waiter = pending.get(response.id);
    if (waiter === undefined) return;
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  });
  let nextId = 0;
  const call = (method: string, params?: JsonValue): Promise<JsonRpcResponse> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP surface capture timed out waiting for ${method}`));
      }, RESPONSE_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP surface child did not start')), RESPONSE_TIMEOUT_MS);
      started.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
    const initialize = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'surface-lock', version: '1' } });
    const toolResponse = await call('tools/list', {});
    const resources = await call('resources/list', {});
    const prompts = await call('prompts/list', {});
    const promptGet = await call('prompts/get', { name: 'sangfor-troubleshoot', arguments: { symptom: 'VPN tunnel flapping' } });
    const products = await call('tools/call', { name: 'sangfor_products', arguments: {} });
    const scopedRag = await call('tools/call', { name: 'sangfor_rag_search', arguments: { query: 'task36-no-match', product: 'IAG', privacy_mode: 'summary', indexPath: join(generatedRoot, 'missing-index.json') } });
    const generatedPlan = await call('tools/call', { name: 'sangfor_generate_product_change_plan', arguments: { product: 'HCI_SCP', requirements: ['Enable DRS and verify HA status'] } });
    const generatedResult = generatedPlan.result;
    const plan = generatedResult !== undefined && isJsonObject(generatedResult)
      ? generatedResult.structuredContent ?? null
      : null;
    const dryRun = await call('tools/call', { name: 'sangfor_dry_run_product_change', arguments: { plan } });
    const unknownTool = await call('tools/call', { name: 'sangfor_does_not_exist', arguments: {} });
    const absentArgs = await call('tools/call', { name: 'sangfor_products' });
    const nonObjectArgs = await call('tools/call', { name: 'sangfor_products', arguments: null });
    const wrongTypeArgs = await call('tools/call', { name: 'sangfor_get_manual_section', arguments: { id: 7 } });
    const malformedArgs = await call('tools/call', { name: 'sangfor_get_manual_section', arguments: {} });
    const secretLikeArgs = await call('tools/call', { name: 'sangfor_products', arguments: { password: 'surface-lock-secret', authorization: 'Bearer surface-lock-token', cookie: 'session=surface-lock' } });
    const resourceRead = await call('resources/read', { uri: 'sangfor://safety/posture' });
    const toolsResult = toolResponse.result;
    if (toolsResult === undefined || !isJsonObject(toolsResult)) throw new Error('tools/list returned no result object');
    const listedTools = toolsResult.tools;
    if (!Array.isArray(listedTools)) throw new Error('tools/list returned no tools array');
    const tools = [...listedTools].sort((left, right) => {
      const leftName = typeof left === 'object' && left !== null && !Array.isArray(left) && typeof left.name === 'string' ? left.name : '';
      const rightName = typeof right === 'object' && right !== null && !Array.isArray(right) && typeof right.name === 'string' ? right.name : '';
      return leftName.localeCompare(rightName);
    });
    const surface = canonicalize({
      schemaVersion: 'mcp-runtime-surface.v1',
      initialize: initialize.result ?? null,
      tools,
      resources: resources.result ?? null,
      prompts: prompts.result ?? null,
      promptGet: promptGet.result ?? null,
      behaviorV2: {
        deliberateDelta: 'strict-pre-dispatch-json-schema-validation',
        malformed: {
          absent: absentArgs.result ?? null,
          nonObject: nonObjectArgs.result ?? null,
          wrongType: wrongTypeArgs.result ?? null,
          missingRequired: malformedArgs.result ?? null,
          secretLikeUnknown: secretLikeArgs.result ?? null,
        },
        representative: {
          products: products.result ?? null,
          scopedRag: scopedRag.result ?? null,
          dryRun: normalizeDryRunResult(dryRun.result),
          unknownTool: unknownTool.result ?? null,
          resourceRead: resourceRead.result ?? null,
        },
      },
      qa: {
        generatedFiles: generatedFiles(generatedRoot),
        stderr: stderrLines,
        secretValuesAbsent: !stderrLines.join('\n').includes('surface-lock-secret') && !stderrLines.join('\n').includes('surface-lock-token'),
      },
      representative: {
        products: products.result ?? null,
        scopedRag: scopedRag.result ?? null,
        dryRun: normalizeDryRunResult(dryRun.result),
        unknownTool: unknownTool.result ?? null,
        malformedArgs: malformedArgs.result ?? null,
        secretLikeArgs: secretLikeArgs.result ?? null,
        resourceRead: resourceRead.result ?? null,
      },
    });
    const sha256 = createHash('sha256').update(JSON.stringify(surface)).digest('hex');
    if (!isJsonObject(surface)) throw new Error('canonical MCP surface is not an object');
    return canonicalize({ ...surface, sha256 });
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('MCP surface capture child closed'));
    }
    child.stdin.end();
    child.kill('SIGTERM');
    output.close();
    errors.close();
    rmSync(generatedRoot, { recursive: true, force: true });
  }
}
