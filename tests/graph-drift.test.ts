import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// S1 — graph drift gate. The declared loop graph (data/graph/pipeline.json) is a
// verified contract, not documentation: for every node that names `src` files,
// the set of `data/...` string literals actually present in those sources must
// equal the node's declared reads∪writes. A node without `src` is declared-only
// (its logic lives in a broad multi-concern file) and is exempt from mining.
// The miner is test-owned on purpose — the runtime package must not be able to
// redefine what "drift" means.

const REPO_ROOT = resolve(__dirname, '..');
const GRAPH_PATH = join(REPO_ROOT, 'data', 'graph', 'pipeline.json');

interface GraphNode {
  id: string;
  kind: string;
  src?: string[];
  reads: string[];
  writes: string[];
  gate?: string;
  note?: string;
}
interface GraphEdge { id: string; from: string; to: string; on: string; watch?: string }
interface LoopGraph { version: number; nodes: GraphNode[]; edges: GraphEdge[] }

const DATA_LITERAL = /'(data\/[\w./-]+)'/g;

function mineDataLiterals(files: string[], root: string): Set<string> {
  const mined = new Set<string>();
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const match of text.matchAll(DATA_LITERAL)) mined.add(match[1]);
  }
  return mined;
}

/** Returns drift violations for one node; empty array = clean. */
function checkNodeDrift(node: GraphNode, root: string): string[] {
  if (!node.src || node.src.length === 0) return [];
  const declared = new Set([...node.reads, ...node.writes]);
  const mined = mineDataLiterals(node.src, root);
  const violations: string[] = [];
  for (const path of mined) {
    if (!declared.has(path)) violations.push(`${node.id}: undeclared data access '${path}' found in src`);
  }
  for (const path of declared) {
    if (!mined.has(path)) violations.push(`${node.id}: declared path '${path}' not found in any src file`);
  }
  return violations;
}

describe('loop graph drift gate (S1)', () => {
  it('data/graph/pipeline.json exists and is a valid v1 graph', () => {
    expect(existsSync(GRAPH_PATH), `missing loop graph declaration at ${GRAPH_PATH}`).toBe(true);
    const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as LoopGraph;
    expect(graph.version).toBe(1);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(graph.nodes.length);
    for (const edge of graph.edges) {
      expect(ids.has(edge.from), `edge ${edge.id} from unknown node ${edge.from}`).toBe(true);
      expect(ids.has(edge.to), `edge ${edge.id} to unknown node ${edge.to}`).toBe(true);
      expect(['new-jsonl-lines', 'file-changed', 'every-tick', 'manual']).toContain(edge.on);
    }
  });

  it('every node with src declares exactly the data paths its sources touch', () => {
    const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as LoopGraph;
    const violations = graph.nodes.flatMap((n) => checkNodeDrift(n, REPO_ROOT));
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('human-approval gates are declared-only (no executor src, never auto-run)', () => {
    const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as LoopGraph;
    for (const node of graph.nodes.filter((n) => n.gate === 'human-approval')) {
      expect(node.src ?? []).toEqual([]);
    }
  });

  // Mutation proof: the checker itself must be able to fail — an undeclared
  // data literal in a src file is reported, and a fabricated declared path is too.
  it('drift checker flags undeclared access and phantom declarations (mutation case)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-drift-'));
    try {
      writeFileSync(join(dir, 'evil.ts'), "const p = 'data/evil/undeclared.json';\n");
      const tampered: GraphNode = { id: 'evil-node', kind: 'internal', src: ['evil.ts'], reads: ['data/never/written.json'], writes: [] };
      const violations = checkNodeDrift(tampered, dir);
      expect(violations.some((v) => v.includes("undeclared data access 'data/evil/undeclared.json'"))).toBe(true);
      expect(violations.some((v) => v.includes("declared path 'data/never/written.json' not found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
