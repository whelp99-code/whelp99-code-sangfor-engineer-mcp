import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = process.cwd();
const PackageManifestSchema = z.object({ scripts: z.record(z.string(), z.string()) });
const REQUIRED_CI_SCRIPTS = {
  'test:postgres:mandatory': 'tsx scripts/run-mandatory-postgres-tests.ts --require',
  'check:mcp-inventory-truth': 'tsx scripts/check-mcp-inventory-truth.ts',
  'check:tracker-truth:offline': 'tsx scripts/check-tracker-truth.ts --offline-fixture tests/fixtures/tracker/valid.json',
  'check:tracker-truth': 'tsx scripts/check-tracker-truth.ts',
} as const;

type Scripts = Readonly<Record<string, string>>;

function hasRequiredCiScripts(scripts: Scripts): boolean {
  return Object.entries(REQUIRED_CI_SCRIPTS).every(([name, command]) => scripts[name] === command);
}

const packageScripts = PackageManifestSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')),
).scripts;
const ciWorkflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

describe('CI package script contract', () => {
  it('wires every CI package script to its real implementation when the workflow invokes it', () => {
    // Given
    const workflowScripts = [...ciWorkflow.matchAll(/pnpm run ([\w:-]+)/gu)].map((match) => match[1]);

    // When
    const contractIsSatisfied = hasRequiredCiScripts(packageScripts);

    // Then
    expect(contractIsSatisfied).toBe(true);
    expect(workflowScripts).toEqual(expect.arrayContaining(Object.keys(REQUIRED_CI_SCRIPTS)));
  });

  it.each(Object.entries(REQUIRED_CI_SCRIPTS))(
    'fails the contract when %s is removed or renamed',
    (name, command) => {
      // Given
      const { [name]: removedScript, ...withoutRequiredScript } = packageScripts;
      const renamedScripts = { ...withoutRequiredScript, [`${name}:renamed`]: command };

      // When
      const removalIsAccepted = hasRequiredCiScripts(withoutRequiredScript);
      const renameIsAccepted = hasRequiredCiScripts(renamedScripts);

      // Then
      expect(removedScript).toBe(command);
      expect(removalIsAccepted).toBe(false);
      expect(renameIsAccepted).toBe(false);
    },
  );
});
