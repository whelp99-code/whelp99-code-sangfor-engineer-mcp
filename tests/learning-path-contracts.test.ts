import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningStrategyService } from '../packages/sangfor-learning-strategy/src/service.js';
import { resolveRepoData } from '../packages/shared/src/index.js';

const repoRoot = process.cwd();
const strategyCliSource = readFileSync(join(repoRoot, 'scripts/strategy-cli.ts'), 'utf8');
const learningToolCatalogSource = readFileSync(join(repoRoot, 'apps/mcp-server/src/learning-tool-catalog.ts'), 'utf8');
const originalOverride = process.env.SANGFOR_PATH_CONTRACT_TEST_ROOT;

afterEach(() => {
  if (originalOverride === undefined) delete process.env.SANGFOR_PATH_CONTRACT_TEST_ROOT;
  else process.env.SANGFOR_PATH_CONTRACT_TEST_ROOT = originalOverride;
});

describe('learning observer canonical data paths', () => {
  it('anchors mutable strategy data, capture staging, and final bundles under data/', () => {
    expect(resolveRepoData('data/runtime/learning-strategies')).toBe(join(repoRoot, 'data/runtime/learning-strategies'));
    expect(resolveRepoData('data/runtime/learning-captures')).toBe(join(repoRoot, 'data/runtime/learning-captures'));
    expect(resolveRepoData('data/captures')).toBe(join(repoRoot, 'data/captures'));
    expect((new LearningStrategyService() as unknown as { root: string }).root)
      .toBe(join(repoRoot, 'data/runtime/learning-strategies'));
  });

  it('preserves the exact environment override contract', () => {
    const override = join(repoRoot, 'data/runtime/path-contract-override');
    process.env.SANGFOR_PATH_CONTRACT_TEST_ROOT = override;
    expect(resolveRepoData('data/runtime/learning-strategies', 'SANGFOR_PATH_CONTRACT_TEST_ROOT')).toBe(override);
    expect(strategyCliSource).toContain(
      "process.env.SANGFOR_LEARNING_STRATEGY_ROOT ?? resolveRepoData('data/runtime/learning-strategies')",
    );
  });

  it('pins the MCP final and transient capture directories without legacy root-level literals', () => {
    expect(learningToolCatalogSource).toContain("capturesDir: resolveRepoData('data/captures')");
    expect(learningToolCatalogSource).toContain("stagingRoot: resolveRepoData('data/runtime/learning-captures')");
    expect(learningToolCatalogSource).not.toContain("resolveRepoData('captures')");
    expect(learningToolCatalogSource).not.toContain("resolveRepoData('capture-staging')");
    expect(strategyCliSource).not.toContain("resolveRepoData('learning-strategies')");
  });
});
