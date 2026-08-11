import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLoopGraph, runLoopTick, type LoopGraph, type TickResult } from '../packages/sangfor-loop/src/index.js';
import { runGapQueriesExecutor } from '../packages/sangfor-loop/src/executors/gap-queries.js';
import { runEmbeddingDriftExecutor } from '../packages/sangfor-loop/src/executors/embedding-drift.js';
import { runRagEvalExecutor } from '../packages/sangfor-loop/src/executors/rag-eval.js';

// S2-S5 — loop engine contract. All paths are temp-dir scoped; nothing in this
// file touches the real data/ tree.

let dir: string;
const saved = { ...process.env };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'loop-tick-')); });
afterEach(() => { process.env = { ...saved }; rmSync(dir, { recursive: true, force: true }); });

const fixtureGraph = (): LoopGraph => ({
  version: 1,
  nodes: [
    { id: 'producer', kind: 'producer', reads: [], writes: ['data/feedback/search-gaps.jsonl'] },
    { id: 'consumer', kind: 'internal', reads: ['data/feedback/search-gaps.jsonl'], writes: ['data/out.json'] },
    { id: 'gated', kind: 'mcp-tool', gate: 'human-approval', reads: [], writes: [] },
  ],
  edges: [
    { id: 'e1', from: 'producer', to: 'consumer', on: 'new-jsonl-lines', watch: 'gaps.jsonl' },
    { id: 'e2', from: 'producer', to: 'gated', on: 'every-tick' },
  ],
});

const paths = () => ({
  cursorsPath: join(dir, 'cursors.json'),
  ledgerPath: join(dir, 'ledger.jsonl'),
  watchRoot: dir,
});

describe('loop graph loader (fail-closed)', () => {
  it('throws LOOP_GRAPH_MISSING when the graph file does not exist', () => {
    expect(() => loadLoopGraph(join(dir, 'nope.json'))).toThrow(/LOOP_GRAPH_MISSING/);
  });
  it('throws LOOP_GRAPH_CORRUPT on unparseable or schema-invalid graphs', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(() => loadLoopGraph(bad)).toThrow(/LOOP_GRAPH_CORRUPT/);
    writeFileSync(bad, JSON.stringify({ version: 2, nodes: [], edges: [] }));
    expect(() => loadLoopGraph(bad)).toThrow(/LOOP_GRAPH_CORRUPT/);
    writeFileSync(bad, JSON.stringify({ version: 1, nodes: [{ id: 'a', kind: 'x', reads: [], writes: [] }], edges: [{ id: 'e', from: 'a', to: 'ghost', on: 'every-tick' }] }));
    expect(() => loadLoopGraph(bad)).toThrow(/LOOP_GRAPH_CORRUPT/);
  });
  it('loads the real committed pipeline graph', () => {
    const graph = loadLoopGraph();
    expect(graph.nodes.some((n) => n.id === 'gap-queries')).toBe(true);
  });
});

describe('runLoopTick (S2 idempotency + ledger + gates)', () => {
  it('executes on new jsonl lines, then a second tick is a no-op', async () => {
    const gapFile = join(dir, 'gaps.jsonl');
    writeFileSync(gapFile, JSON.stringify({ id: 'g1', query: 'ssl vpn drop' }) + '\n');
    const executed: string[][] = [];
    const result1 = await runLoopTick({
      graph: fixtureGraph(),
      ...paths(),
      executors: { consumer: async ({ newLines }) => { executed.push(newLines ?? []); return { detail: 'ok' }; } },
    });
    expect(result1.outcomes.find((o) => o.edge === 'e1')?.outcome).toBe('executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toHaveLength(1);

    const result2: TickResult = await runLoopTick({
      graph: fixtureGraph(),
      ...paths(),
      executors: { consumer: async ({ newLines }) => { executed.push(newLines ?? []); return { detail: 'ok' }; } },
    });
    expect(result2.outcomes.find((o) => o.edge === 'e1')?.outcome).toBe('noop');
    expect(executed).toHaveLength(1); // executor NOT called again

    // ledger recorded both ticks
    const ledger = readFileSync(paths().ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.filter((e) => e.edge === 'e1').map((e) => e.outcome)).toEqual(['executed', 'noop']);
  });

  it('a failing executor records error and does NOT advance the cursor', async () => {
    const gapFile = join(dir, 'gaps.jsonl');
    writeFileSync(gapFile, JSON.stringify({ id: 'g1' }) + '\n');
    let calls = 0;
    const boom = async () => { calls += 1; throw new Error('exec-fail'); };
    const r1 = await runLoopTick({ graph: fixtureGraph(), ...paths(), executors: { consumer: boom } });
    expect(r1.outcomes.find((o) => o.edge === 'e1')?.outcome).toBe('error');
    const r2 = await runLoopTick({ graph: fixtureGraph(), ...paths(), executors: { consumer: boom } });
    expect(r2.outcomes.find((o) => o.edge === 'e1')?.outcome).toBe('error'); // retried, cursor not advanced
    expect(calls).toBe(2);
  });

  it('gate nodes are never executed — recorded as gate-pending even with an executor registered', async () => {
    const result = await runLoopTick({
      graph: fixtureGraph(),
      ...paths(),
      executors: { gated: async () => ({ detail: 'MUST NEVER RUN' }) },
    });
    expect(result.outcomes.find((o) => o.edge === 'e2')?.outcome).toBe('gate-pending');
  });

  it('corrupt cursor store fails closed', async () => {
    writeFileSync(paths().cursorsPath, '{broken');
    await expect(runLoopTick({ graph: fixtureGraph(), ...paths(), executors: {} })).rejects.toThrow(/LOOP_CURSORS_CORRUPT/);
  });
});

describe('P1 gapQueries executor (S3 dedupe)', () => {
  it('merges gap events into deduped queries with counts, idempotent per line set', () => {
    const out = join(dir, 'gap-queries.json');
    const lines = [
      JSON.stringify({ id: 'g1', ts: 't1', query: 'SSL VPN 설정', product: 'IAG', hitCount: 0, reason: 'no_hits' }),
      JSON.stringify({ id: 'g2', ts: 't2', query: 'ssl vpn 설정', product: 'IAG', hitCount: 1, topScore: 0.05, reason: 'low_score' }),
      JSON.stringify({ id: 'g3', ts: 't3', query: 'HCI 클러스터 확장', hitCount: 0, reason: 'no_hits' }),
    ];
    const r = runGapQueriesExecutor({ newLines: lines, outPath: out });
    expect(r.detail).toContain('2 queries');
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.queries).toHaveLength(2);
    const ssl = parsed.queries.find((q: { query: string }) => q.query === 'ssl vpn 설정');
    expect(ssl.count).toBe(2);
    expect(ssl.products).toEqual(['IAG']);
    // second batch with one repeat accumulates, no duplicate entries
    runGapQueriesExecutor({ newLines: [lines[0]], outPath: out });
    const parsed2 = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed2.queries).toHaveLength(2);
    expect(parsed2.queries.find((q: { query: string }) => q.query === 'ssl vpn 설정').count).toBe(3);
  });

  it('malformed lines are skipped, not fatal', () => {
    const out = join(dir, 'gap-queries.json');
    const r = runGapQueriesExecutor({ newLines: ['{broken', JSON.stringify({ id: 'g', query: 'q', hitCount: 0, reason: 'no_hits' })], outPath: out });
    expect(JSON.parse(readFileSync(out, 'utf8')).queries).toHaveLength(1);
    expect(r.detail).toContain('1 skipped');
  });
});

describe('P2 embeddingDrift executor (S4)', () => {
  const writeIndex = (model: string) => {
    const indexPath = join(dir, 'index.json');
    writeFileSync(indexPath, JSON.stringify({ version: 2, updatedAt: 't', chunks: [
      { id: 'c1', sourceType: 'manual', product: 'HCI', title: 't', section: 's', text: 'x', trustLevel: 'official', vector: [0.1], contentHash: 'h', filePath: 'f', embeddingBackend: 'rapid-mlx', embeddingModel: model, vectorDims: 1 },
    ] }));
    return indexPath;
  };
  it('writes needs-reembed.flag when index model differs from the configured model', () => {
    const flag = join(dir, 'needs-reembed.flag');
    const r = runEmbeddingDriftExecutor({ indexPath: writeIndex('old-model'), flagPath: flag, configuredModel: 'new-model' });
    expect(r.detail).toContain('drift');
    expect(existsSync(flag)).toBe(true);
    expect(readFileSync(flag, 'utf8')).toContain('old-model');
    expect(readFileSync(flag, 'utf8')).toContain('new-model');
  });
  it('removes a stale flag when models match', () => {
    const flag = join(dir, 'needs-reembed.flag');
    writeFileSync(flag, 'stale');
    const r = runEmbeddingDriftExecutor({ indexPath: writeIndex('same-model'), flagPath: flag, configuredModel: 'same-model' });
    expect(r.detail).toContain('no drift');
    expect(existsSync(flag)).toBe(false);
  });
});

describe('P3 ragEval executor (S5)', () => {
  // Four seed cases (HCI/IAG/ENDPOINT_SECURE/CYBER_COMMAND) always exist in
  // sangfor-evals; SANGFOR_EVALS_ROOT only adds feedback-derived cases on top.
  it('with no accumulated cases, evaluates exactly the seed products honestly', () => {
    process.env.SANGFOR_EVALS_ROOT = join(dir, 'empty-evals');
    const r = runRagEvalExecutor({});
    expect(r.results).toHaveLength(4);
    expect(r.results.map((p) => p.product).sort()).toEqual(['CYBER_COMMAND', 'ENDPOINT_SECURE', 'HCI', 'IAG']);
    for (const p of r.results) {
      expect(typeof p.ok).toBe('boolean');
      expect(p.caseCount).toBeGreaterThanOrEqual(1);
    }
    expect(r.detail).toContain('4 products');
  });
  it('an accumulated feedback case joins its product suite', () => {
    const evalsRoot = join(dir, 'evals');
    mkdirSync(evalsRoot, { recursive: true });
    writeFileSync(join(evalsRoot, 'eval-cases.jsonl'),
      JSON.stringify({ id: 'ev1', product: 'HCI', name: 'must mention HA', requiredText: 'HA' }) + '\n');
    process.env.SANGFOR_EVALS_ROOT = evalsRoot;
    const r = runRagEvalExecutor({});
    const hci = r.results.find((p) => p.product === 'HCI');
    expect(hci?.caseCount).toBe(2); // 1 seed + 1 accumulated
    expect(r.detail).toContain('5 cases');
  });
});
