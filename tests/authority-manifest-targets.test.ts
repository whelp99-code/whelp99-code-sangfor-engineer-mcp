import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TARGETS = [
  'BlroServiceRegistry',
  'BlroPmRecord',
  'BlroFeedbackLesson',
  'BlroEvalRecord',
  'BlroWikiProposal',
  'BlroLearningRecord',
  'BlroFirmwareEvidence',
  'BlroConfigChronicle',
  'BlroCapabilityEvidence',
  'BlroRagSourceChunk',
] as const;

describe('Todo 20 authority schema targets', () => {
  it('defines every new authority target with project scope', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    for (const target of TARGETS) {
      const block = new RegExp(`model ${target} \\{([\\s\\S]*?)\\n\\}`, 'u').exec(schema)?.[1] ?? '';
      expect(block).toMatch(/\bprojectId\s+String\b/u);
      expect(block).toMatch(/@@index\(\[projectId/u);
    }
  });

  it('creates every target under ENABLE and FORCE RLS policy control', () => {
    const migration = readFileSync('prisma/migrations/20260826190000_authority_manifest_targets/migration.sql', 'utf8');
    for (const target of TARGETS) expect(migration).toContain(`'${target}'`);
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY');
  });
});
