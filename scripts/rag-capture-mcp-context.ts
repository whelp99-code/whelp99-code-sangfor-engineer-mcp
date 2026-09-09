/** Capture actual stdio MCP evidence for a client-answer evaluation. No answers are synthesized here. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { corpusEvalFixtureSchema } from '../packages/sangfor-rag/src/corpus-eval-contract.js';
const [indexPath, fixturePath] = process.argv.slice(2);
if (!indexPath || !fixturePath || process.argv.length !== 4) throw new Error('Usage: pnpm run rag:capture:mcp <index.json> <fixture.json>');
const fixtureBytes = readFileSync(fixturePath), indexBytes = readFileSync(indexPath);
const fixture = corpusEvalFixtureSchema.parse(JSON.parse(fixtureBytes.toString('utf8')));
const hitSchema = z.object({ id: z.string().min(1), filePath: z.string().min(1), title: z.string(), text: z.string().min(1), product: z.string(), version: z.string().optional(), score: z.number().finite(), contextChunks: z.array(z.object({ id: z.string(), filePath: z.string(), product: z.string(), version: z.string().optional(), title: z.string(), text: z.string(), contentHash: z.string() })).optional() });
const responseSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });
const env: NodeJS.ProcessEnv = { ...process.env, MCP_NO_SERVE: '0', SANGFOR_SEARCH_GAP_CAPTURE: '0' };
delete env.VITEST;
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/mcp-server/src/index.ts'], { stdio: ['pipe', 'pipe', 'inherit'], env });
const lines = createInterface({ input: child.stdout });
let nextId = 0;
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function fail(error: Error) { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); }
child.on('error', fail);
child.on('exit', () => fail(new Error('MCP_CAPTURE_CHILD_EXITED')));
lines.on('line', (line) => {
  try {
    const message = responseSchema.parse(JSON.parse(line));
    const request = pending.get(message.id);
    if (!request) throw new Error('MCP_CAPTURE_UNEXPECTED_RESPONSE');
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error !== undefined) request.reject(new Error('MCP_CAPTURE_RPC_ERROR'));
    else request.resolve(message.result);
  } catch { fail(new Error('MCP_CAPTURE_MALFORMED_RESPONSE')); }
});
function request(method: string, params: unknown): Promise<unknown> {
  return new Promise((resolveRequest, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP_CAPTURE_TIMEOUT')); }, 60_000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })+'\n');
  });
}
try {
  const initialize = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rag-answer-evaluation', version: '1' } });
  const listing = z.object({ tools: z.array(z.object({ name: z.string(), annotations: z.object({ readOnlyHint: z.boolean() }).passthrough() }).passthrough()) }).parse(await request('tools/list', {}));
  if (!listing.tools.some((tool) => tool.name === 'sangfor_rag_search' && tool.annotations.readOnlyHint)) throw new Error('MCP_CAPTURE_READ_TOOL_MISSING');
  const rows = [];
  for (const query of [...fixture.queries, ...fixture.noAnswerQueries]) {
    const answerPrompt = await request('prompts/get', { name: 'sangfor-answer-from-docs', arguments: { question: query.query, product: query.product, version: query.version } });
    const raw = z.object({ isError: z.literal(false), structuredContent: z.unknown() }).passthrough().parse(await request('tools/call', { name: 'sangfor_rag_search', arguments: { query: query.query, product: query.product, version: query.version, limit: fixture.k, indexPath: resolve(indexPath), privacy_mode: 'raw', contextNeighbors: 1, include_vectors: false } }));
    const hits = z.array(hitSchema).parse(raw.structuredContent);
    if (hits.some((hit) => hit.product !== query.product || (query.version && hit.version !== query.version))) throw new Error('MCP_CAPTURE_SCOPE_MISMATCH');
    rows.push({ queryId: query.queryId, query: query.query, product: query.product, version: query.version, answerPrompt,
      hits: hits.map((hit) => ({ ...hit, textSha256: createHash('sha256').update(hit.text).digest('hex') })) });
  }
  if (!readFileSync(indexPath).equals(indexBytes) || !readFileSync(fixturePath).equals(fixtureBytes)) throw new Error('MCP_CAPTURE_INPUT_CHANGED');
  console.log(JSON.stringify({ schemaVersion: 1, transport: 'actual-stdio-mcp', initialize,
    fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), indexSha256: createHash('sha256').update(indexBytes).digest('hex'),
    answerGeneration: 'not-run; client must answer only from captured hits and attach exact evidence', rows }, null, 2));
} finally { lines.close(); child.stdin.end(); child.kill(); }
