/**
 * Reads the runtime pins a GitHub workflow actually declares.
 *
 * The pins are tied to the setup action that consumes them: a Node major counts
 * only when it is the `node-version` input of an `actions/setup-node` step, and
 * a pnpm version counts only when it is the `version` input of a
 * `pnpm/action-setup` step. Any other `version:` key in the file — a docker
 * action input, an env value, a top-level key — is ignored, so an unrelated
 * bump can never satisfy the pin contract.
 */

export interface WorkflowRuntimePins {
  readonly nodeMajors: readonly number[];
  readonly pnpmVersions: readonly string[];
}

interface WorkflowStep {
  readonly uses: string;
  readonly inputs: ReadonlyMap<string, string>;
}

const INDENT = /^(\s*)/;
const STEP_START = /^(\s*)-\s+(.*)$/;
const KEY_VALUE = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/;

function indentOf(line: string): number {
  return (INDENT.exec(line)?.[1] ?? '').length;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.startsWith("'") ? "'" : trimmed.startsWith('"') ? '"' : '';
  return quote && trimmed.endsWith(quote) && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Collects `uses` steps with the inputs nested under their own `with:` block.
 * Indentation bounds each step, so a sibling step or an `env:` block cannot
 * leak an input into the step before it.
 */
function readSteps(yaml: string): readonly WorkflowStep[] {
  const lines = yaml.split('\n');
  const steps: WorkflowStep[] = [];
  let current: { uses: string; inputs: Map<string, string>; indent: number } | undefined;
  let withIndent: number | undefined;

  const flush = (): void => {
    if (current && current.uses) steps.push({ uses: current.uses, inputs: current.inputs });
    current = undefined;
    withIndent = undefined;
  };

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const stepStart = STEP_START.exec(line);
    if (stepStart) {
      flush();
      const indent = (stepStart[1] ?? '').length;
      current = { uses: '', inputs: new Map(), indent };
      const inline = KEY_VALUE.exec(`${' '.repeat(indent + 2)}${stepStart[2] ?? ''}`);
      if (inline && inline[2] === 'uses') current.uses = unquote(inline[3] ?? '');
      continue;
    }
    if (!current) continue;
    if (indentOf(line) <= current.indent) {
      flush();
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (!pair) continue;
    const [, rawIndent = '', key = '', rawValue = ''] = pair;
    const indent = rawIndent.length;
    if (key === 'uses' && withIndent === undefined) {
      current.uses = unquote(rawValue);
      continue;
    }
    if (key === 'with') {
      withIndent = indent;
      continue;
    }
    if (withIndent === undefined) continue;
    if (indent <= withIndent) {
      withIndent = undefined;
      continue;
    }
    current.inputs.set(key, unquote(rawValue));
  }
  flush();
  return steps;
}

function inputOf(step: WorkflowStep, action: string, input: string): string | undefined {
  return step.uses.startsWith(`${action}@`) || step.uses === action
    ? step.inputs.get(input)
    : undefined;
}

export function readWorkflowRuntimePins(yaml: string): WorkflowRuntimePins {
  const steps = readSteps(yaml);
  const nodeMajors: number[] = [];
  const pnpmVersions: string[] = [];
  for (const step of steps) {
    const nodeVersion = inputOf(step, 'actions/setup-node', 'node-version');
    if (nodeVersion !== undefined) {
      const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
      if (Number.isSafeInteger(major)) nodeMajors.push(major);
    }
    const pnpmVersion = inputOf(step, 'pnpm/action-setup', 'version');
    if (pnpmVersion !== undefined) pnpmVersions.push(pnpmVersion);
  }
  return { nodeMajors, pnpmVersions };
}
