import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { appendJsonl, nowId, resolveRepoData, withDirLock, writeFileAtomicSync } from '../../shared/src/index.js';
import {
  parseBoundaryLoopCursorsV1,
  parseBoundaryLoopGraphV1,
  parseBoundaryLoopLedgerLineV1,
} from './runtime-boundaries.js';

// ─── Loop-graph runtime (design: docs/plans/designs/001-loop-graph-runtime.md)
// The graph is DATA (data/graph/pipeline.json), verified against the code by
// tests/graph-drift.test.ts. This engine only wires triggers to executors:
// it never approves anything (gate nodes are recorded as gate-pending and
// skipped), and it fails closed on corrupt graph/cursor state.

export type LoopTrigger = 'new-jsonl-lines' | 'file-changed' | 'every-tick' | 'manual';

export interface LoopGraphNode {
  id: string;
  kind: string;
  run?: string;
  tool?: string;
  src?: string[];
  reads: string[];
  writes: string[];
  gate?: 'human-approval';
  note?: string;
}

export interface LoopGraphEdge {
  id: string;
  from: string;
  to: string;
  on: LoopTrigger;
  watch?: string;
}

export interface LoopGraph {
  version: 1;
  nodes: LoopGraphNode[];
  edges: LoopGraphEdge[];
}

const TRIGGERS: readonly LoopTrigger[] = ['new-jsonl-lines', 'file-changed', 'every-tick', 'manual'];
const DEFAULT_GRAPH_PATH = () => resolveRepoData('data/graph/pipeline.json', 'SANGFOR_LOOP_GRAPH_PATH');
const DEFAULT_CURSORS_PATH = () => resolveRepoData('data/runtime/loop-cursors.json', 'SANGFOR_LOOP_CURSORS_PATH');
const DEFAULT_LEDGER_PATH = () => resolveRepoData('data/runtime/loop-ledger.jsonl', 'SANGFOR_LOOP_LEDGER_PATH');

export function loadLoopGraph(graphPath = DEFAULT_GRAPH_PATH()): LoopGraph {
  if (!existsSync(graphPath)) throw new Error(`LOOP_GRAPH_MISSING: ${graphPath}`);
  let parsed: LoopGraph;
  try {
    parsed = parseBoundaryLoopGraphV1(readFileSync(graphPath, 'utf8'));
  } catch (error) {
    throw new LoopStateError('LOOP_GRAPH_CORRUPT', { cause: error });
  }
  if (parsed.version !== 1) throw new Error(`LOOP_GRAPH_CORRUPT: unsupported version ${String(parsed.version)}`);
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error('LOOP_GRAPH_CORRUPT: nodes/edges must be arrays');
  const ids = new Set<string>();
  for (const node of parsed.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error(`LOOP_GRAPH_CORRUPT: missing/duplicate node id '${node.id}'`);
    ids.add(node.id);
  }
  for (const edge of parsed.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`LOOP_GRAPH_CORRUPT: edge ${edge.id} references unknown node`);
    if (!TRIGGERS.includes(edge.on)) throw new Error(`LOOP_GRAPH_CORRUPT: edge ${edge.id} has unknown trigger '${String(edge.on)}'`);
  }
  return parsed;
}

// ─── Cursors: per-edge progress markers. Fail closed on corruption — a
// silently-reset cursor would replay every event as new (duplicate work) or,
// worse, mask lost progress as "nothing to do".
export interface EdgeCursor { lines?: number; mtimeMs?: number }
export type CursorStore = Record<string, EdgeCursor>;

function loadCursors(cursorsPath: string): CursorStore {
  if (!existsSync(cursorsPath)) return {};
  try {
    return parseBoundaryLoopCursorsV1(readFileSync(cursorsPath, 'utf8'));
  } catch (error) {
    throw new LoopStateError('LOOP_CURSORS_CORRUPT', { cause: error });
  }
}

export class LoopStateError extends Error {
  readonly name = 'LoopStateError';

  constructor(
    readonly code: 'LOOP_GRAPH_CORRUPT' | 'LOOP_CURSORS_CORRUPT',
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export type TickOutcome = 'executed' | 'noop' | 'error' | 'gate-pending' | 'manual';

export interface ExecutorContext {
  edge: LoopGraphEdge;
  node: LoopGraphNode;
  /** New JSONL lines since the cursor (new-jsonl-lines trigger only). */
  newLines?: string[];
  /** Absolute path of the watched file, when the edge declares one. */
  watchPath?: string;
}

export type NodeExecutor = (ctx: ExecutorContext) => Promise<{ detail?: string }> | { detail?: string };

export interface EdgeOutcome { edge: string; node: string; outcome: TickOutcome; detail?: string }
export interface TickResult { tickId: string; at: string; outcomes: EdgeOutcome[] }

export interface LoopLedgerEntry extends EdgeOutcome { id: string; ts: string; tick: string }

export interface RunLoopTickOptions {
  graph?: LoopGraph;
  graphPath?: string;
  cursorsPath?: string;
  ledgerPath?: string;
  /** Root against which relative edge.watch paths resolve (default: repo root). */
  watchRoot?: string;
  executors: Record<string, NodeExecutor>;
}

export async function runLoopTick(options: RunLoopTickOptions): Promise<TickResult> {
  const graph = options.graph ?? loadLoopGraph(options.graphPath);
  const cursorsPath = options.cursorsPath ?? DEFAULT_CURSORS_PATH();
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH();
  const watchRoot = options.watchRoot ?? resolveRepoData('.');
  const tickId = nowId('loop_tick');
  const at = new Date().toISOString();
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  // One tick at a time: concurrent ticks would double-execute the same events
  // before either advances the cursor.
  return withDirLock(`${cursorsPath}.lock`, async () => {
    const cursors = loadCursors(cursorsPath);
    const outcomes: EdgeOutcome[] = [];

    for (const edge of graph.edges) {
      const node = nodesById.get(edge.to);
      if (node === undefined) throw new LoopStateError('LOOP_GRAPH_CORRUPT');
      const watchPath = edge.watch === undefined ? undefined : isAbsolute(edge.watch) ? edge.watch : join(watchRoot, edge.watch);
      const record = (outcome: TickOutcome, detail?: string) => outcomes.push({ edge: edge.id, node: node.id, outcome, detail });

      if (edge.on === 'manual') { record('manual', 'manual edge — engine never fires it'); continue; }
      if (node.gate === 'human-approval') { record('gate-pending', 'human-approval gate — loop stops here by design'); continue; }

      const executor = options.executors[node.id];
      const cursor = cursors[edge.id] ?? {};
      try {
        if (edge.on === 'new-jsonl-lines') {
          if (!watchPath || !existsSync(watchPath)) { record('noop', 'watch file absent'); continue; }
          const lines = readFileSync(watchPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
          const seen = cursor.lines ?? 0;
          if (lines.length <= seen) { record('noop', `no new lines (${lines.length} seen)`); continue; }
          if (!executor) { record('error', `no executor registered for node '${node.id}'`); continue; }
          const result = await executor({ edge, node, newLines: lines.slice(seen), watchPath });
          cursors[edge.id] = { ...cursor, lines: lines.length };
          record('executed', result.detail);
        } else if (edge.on === 'file-changed') {
          if (!watchPath || !existsSync(watchPath)) { record('noop', 'watch file absent'); continue; }
          const mtimeMs = statSync(watchPath).mtimeMs;
          if (cursor.mtimeMs !== undefined && mtimeMs <= cursor.mtimeMs) { record('noop', 'watch file unchanged'); continue; }
          if (!executor) { record('error', `no executor registered for node '${node.id}'`); continue; }
          const result = await executor({ edge, node, watchPath });
          cursors[edge.id] = { ...cursor, mtimeMs };
          record('executed', result.detail);
        } else {
          // every-tick
          if (!executor) { record('error', `no executor registered for node '${node.id}'`); continue; }
          const result = await executor({ edge, node, watchPath });
          record('executed', result.detail);
        }
      } catch (error) {
        // Cursor deliberately NOT advanced: the same events retry next tick.
        record('error', String(error instanceof Error ? error.message : error));
      }
    }

    writeFileAtomicSync(cursorsPath, JSON.stringify(cursors, null, 2));
    for (const outcome of outcomes) {
      const entry: LoopLedgerEntry = { id: nowId('loop'), ts: at, tick: tickId, ...outcome };
      appendJsonl(ledgerPath, entry);
    }
    return { tickId, at, outcomes };
  });
}

// ─── Status surface (read-only) — consumed by the sangfor_loop_status MCP tool
// and control-tower /api/loop/status.
export interface LoopStatus {
  graphPath: string;
  nodes: number;
  edges: number;
  gates: string[];
  cursors: CursorStore;
  pendingByEdge: Record<string, number>;
  lastLedger: LoopLedgerEntry[];
}

export function buildLoopStatus(options: { graphPath?: string; cursorsPath?: string; ledgerPath?: string; watchRoot?: string; tail?: number } = {}): LoopStatus {
  const graphPath = options.graphPath ?? DEFAULT_GRAPH_PATH();
  const graph = loadLoopGraph(graphPath);
  const cursorsPath = options.cursorsPath ?? DEFAULT_CURSORS_PATH();
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH();
  const watchRoot = options.watchRoot ?? resolveRepoData('.');
  const cursors = loadCursors(cursorsPath);
  const pendingByEdge: Record<string, number> = {};
  for (const edge of graph.edges) {
    if (edge.on !== 'new-jsonl-lines' || !edge.watch) continue;
    const watchPath = isAbsolute(edge.watch) ? edge.watch : join(watchRoot, edge.watch);
    if (!existsSync(watchPath)) { pendingByEdge[edge.id] = 0; continue; }
    const lines = readFileSync(watchPath, 'utf8').split('\n').filter((l) => l.trim().length > 0).length;
    pendingByEdge[edge.id] = Math.max(0, lines - (cursors[edge.id]?.lines ?? 0));
  }
  let lastLedger: LoopLedgerEntry[] = [];
  if (existsSync(ledgerPath)) {
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    lastLedger = lines.slice(-(options.tail ?? 20)).map((line) => parseBoundaryLoopLedgerLineV1(line));
  }
  return {
    graphPath,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    gates: graph.nodes.filter((n) => n.gate === 'human-approval').map((n) => n.id),
    cursors,
    pendingByEdge,
    lastLedger,
  };
}
