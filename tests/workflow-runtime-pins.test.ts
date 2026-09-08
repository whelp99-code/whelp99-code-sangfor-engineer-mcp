import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_RUNTIME_PINS } from '../packages/sangfor-browser-contracts/src/protocol-version.js';
import { readWorkflowRuntimePins } from '../scripts/lib/workflow-runtime-pins.js';

const workflow = (name: string): string => readFileSync(
  new URL(`../.github/workflows/${name}`, import.meta.url),
  'utf8',
);

const SETUP_NODE = `
jobs:
  verify:
    steps:
      - uses: pnpm/action-setup@v4
        with:
          version: 10.28.1
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: pnpm
`;

describe('workflow runtime pin extraction', () => {
  it('reads the Node major only from a setup-node step and pnpm only from action-setup', () => {
    const pins = readWorkflowRuntimePins(SETUP_NODE);
    expect(pins).toEqual({ nodeMajors: [22], pnpmVersions: ['10.28.1'] });
  });

  it.each([
    [
      'a docker image version field',
      `${SETUP_NODE}      - uses: docker/build-push-action@v6\n        with:\n          version: 9.9.9\n`,
    ],
    [
      'an unrelated step input named node-version',
      `${SETUP_NODE}      - uses: some/other-action@v1\n        with:\n          node-version: '18'\n`,
    ],
    [
      'a bare top-level version key',
      `version: 1.2.3\n${SETUP_NODE}`,
    ],
    [
      'a version inside an env block',
      `${SETUP_NODE}      - name: Noise\n        env:\n          version: 7.7.7\n        run: echo hi\n`,
    ],
  ])('ignores %s', (_case, yaml) => {
    // Given YAML that carries a version-looking key outside a setup action,
    // Then the pin reader must not count it — an unrelated bump cannot
    // silently satisfy the runtime pin contract.
    expect(readWorkflowRuntimePins(yaml)).toEqual({ nodeMajors: [22], pnpmVersions: ['10.28.1'] });
  });

  it('reads a setup action even when its inputs are ordered unusually', () => {
    const pins = readWorkflowRuntimePins(`
jobs:
  verify:
    steps:
      - name: Node
        uses: actions/setup-node@v5
        with:
          cache: pnpm
          node-version: 24
`);
    expect(pins).toEqual({ nodeMajors: [24], pnpmVersions: [] });
  });

  it('proves both the BLRO Node lane and the JM Node lane in CI, in that order', () => {
    // Given the shipped policy that BLRO (Node 22) upgrades before JM (Node 24),
    // Then CI must exercise both majors and declare the BLRO lane first.
    expect(readWorkflowRuntimePins(workflow('ci.yml')).nodeMajors)
      .toEqual([NODE_RUNTIME_PINS.blroMajor, NODE_RUNTIME_PINS.jmMajor]);
  });

  it('pins one pnpm version across every workflow', () => {
    for (const name of ['ci.yml', 'pr-validation.yml', 'cd.yml']) {
      const { pnpmVersions } = readWorkflowRuntimePins(workflow(name));
      expect(pnpmVersions.length).toBeGreaterThan(0);
      expect(new Set(pnpmVersions)).toEqual(new Set([NODE_RUNTIME_PINS.pnpm]));
    }
  });

  it('keeps the JM lane ordered behind the BLRO lane', () => {
    const ci = workflow('ci.yml');
    expect(ci).toMatch(/verify-jm-endpoint:\s*\n\s*needs:\s*verify\b/);
  });
});
