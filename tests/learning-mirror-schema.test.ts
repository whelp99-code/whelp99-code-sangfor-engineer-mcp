import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('PR-010 additive Prisma mirror schema', () => {
  it('defines exactly the seven learning mirror models and one additive migration', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../prisma/migrations/20260728000100_learning_strategy_mirror/migration.sql', import.meta.url), 'utf8');
    for (const model of [
      'LearningMethodCatalog', 'LearningFirmwareProfile', 'LearningStrategyRevision',
      'LearningLifecycleEvent', 'LearningEvidence', 'LearningRun', 'LearningMirrorReceipt',
    ]) {
      expect(schema).toMatch(new RegExp(`model ${model} \\{`, 'u'));
      expect(migration).toContain(`CREATE TABLE "${model}"`);
    }
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|TRUNCATE/iu);
    expect(schema).not.toMatch(/bundlePath|capturePayload|rawPayload/iu);
  });
});
