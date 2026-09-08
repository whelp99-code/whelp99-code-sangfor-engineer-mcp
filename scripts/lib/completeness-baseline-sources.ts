/**
 * Turns the repo, the environment, and the live surfaces into baseline observations.
 *
 * Every collector answers with a state as well as a value, because "the bridge
 * was down" and "the bridge advertises nothing" are different facts and only the
 * first is an environment blocker. Secret-bearing variables are recorded by
 * presence only — a baseline artifact is committed evidence, so a token value
 * must never be able to reach it. Markdown and issue bodies are scanned for
 * structural tokens only, never interpreted.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { BaselineObservation, BaselineSourceId, BaselineState } from './completeness-baseline.js';

export { collectPersistenceCutover, collectProductionWiring } from './completeness-baseline-environment.js';

/** Inputs a caller must supply; nothing here reaches for a global on its own. */
export interface CollectorEnvironment {
  readonly repoRoot: string;
  readonly collectedAt: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A probe result the CLI gathered, kept as data so collectors stay pure. */
export type ProbeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly state: Exclude<BaselineState, 'PASS'>; readonly detail: string };

/** Identity of an observation: which question, read from where, by what command. */
export interface ObservationDraft {
  readonly sourceId: BaselineSourceId;
  readonly origin: string;
  readonly command: string;
}

export const observe = (
  draft: ObservationDraft,
  environment: CollectorEnvironment,
  state: BaselineState,
  detail: string,
  data: unknown,
): BaselineObservation => ({ ...draft, collectedAt: environment.collectedAt, state, detail, data });

/**
 * Lifts a probe the CLI already ran. A failed probe keeps the state the probe
 * chose, so an unreachable bridge stays BLOCKED and never becomes a PASS with
 * an empty census.
 */
export function fromProbe<T>(
  draft: ObservationDraft,
  environment: CollectorEnvironment,
  probe: ProbeOutcome<T>,
  describe: (value: T) => { readonly detail: string; readonly data: unknown },
): BaselineObservation {
  if (!probe.ok) return observe(draft, environment, probe.state, probe.detail, null);
  const { detail, data } = describe(probe.value);
  return observe(draft, environment, 'PASS', detail, data);
}

/** `### #7 — title` rows under `## Open` in the tech-debt tracker. */
const DEBT_HEADING = /^###\s+#(\d+)\s+—\s+(.+)$/gm;
const DEBT_FILE = 'docs/plans/work/tech-debt-tracker.md';

export function collectActiveDebt(environment: CollectorEnvironment): BaselineObservation {
  const draft = {
    sourceId: 'active_debt',
    origin: DEBT_FILE,
    command: `read ${DEBT_FILE} and parse the "## Open" section headings`,
  } as const;
  const path = join(environment.repoRoot, DEBT_FILE);
  if (!existsSync(path)) {
    return observe(draft, environment, 'BLOCKED', `${DEBT_FILE} is absent from this worktree`, null);
  }

  const text = readFileSync(path, 'utf8');
  const open = text.split(/^##\s+/m).find((section) => section.startsWith('Open'));
  if (open === undefined) {
    return observe(draft, environment, 'FAIL', `${DEBT_FILE} declares no "## Open" section`, null);
  }

  const items = [...open.matchAll(DEBT_HEADING)].map(([, id, title]) => ({ id: `#${String(id)}`, title: String(title) }));
  return observe(draft, environment, 'PASS', `${items.length} open debt item(s)`, { items });
}

/**
 * Which suites this host cannot run. The gate expressions live in the test files
 * (`describe.skipIf(...)`, `describe.runIf(...)`), so the files are the source —
 * a list written here would go stale the moment a suite added a gate.
 */
const TEST_GATES = ['skipIf', 'runIf', 'skip'] as const;
const TEST_CALLERS = new Set(['describe', 'it', 'test']);
const TESTS_DIR = 'tests';

type TestGateParse =
  | { readonly ok: true; readonly gates: readonly string[] }
  | { readonly ok: false };

function declaredTestGates(source: string, file: string): TestGateParse {
  const found = new Set<string>();
  const diagnostics = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  }).diagnostics ?? [];
  if (diagnostics.length > 0) return { ok: false };
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && TEST_CALLERS.has(node.expression.text)
      && TEST_GATES.some((gate) => gate === node.name.text)
    ) {
      found.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { ok: true, gates: [...found].sort() };
}

export function collectTestEnvironmentBlockers(environment: CollectorEnvironment): BaselineObservation {
  const draft = {
    sourceId: 'test_environment_blockers',
    origin: `${TESTS_DIR}/**/*.test.ts`,
    command: `scan ${TESTS_DIR} for describe/it skipIf, runIf and skip gates`,
  } as const;
  const dir = join(environment.repoRoot, TESTS_DIR);
  if (!existsSync(dir)) {
    return observe(draft, environment, 'BLOCKED', `${TESTS_DIR} is absent from this worktree`, null);
  }

  /** Accumulator for a recursive source census. */
  const gatedFiles: { readonly file: string; readonly gates: readonly string[] }[] = [];
  const testFiles = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  for (const name of testFiles) {
    const parsed = declaredTestGates(readFileSync(join(dir, name), 'utf8'), name);
    if (!parsed.ok) {
      return observe(draft, environment, 'FAIL', `${TESTS_DIR}/${name} has TypeScript parse diagnostics`, null);
    }
    if (parsed.gates.length > 0) gatedFiles.push({ file: `${TESTS_DIR}/${name}`, gates: parsed.gates });
  }

  return observe(draft, environment, 'PASS', `${gatedFiles.length} test file(s) carry a conditional gate`, { gatedFiles });
}
