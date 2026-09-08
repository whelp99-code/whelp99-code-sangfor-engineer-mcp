import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureMcpRuntimeSurface } from './helpers/mcp-runtime-surface-driver.js';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/mcp-runtime-behavior-v2.json');

describe('MCP runtime behavior contract v2', () => {
  it('locks the deliberate strict-validation delta and valid representative results', async () => {
    // Given the separately versioned post-validation behavior contract.
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const { sha256: _sha256, ...contract } = expected;
    expect(createHash('sha256').update(JSON.stringify(contract)).digest('hex')).toBe(expected.sha256);
    expect(expected.schemaVersion).toBe('mcp-runtime-behavior.v2');
    expect(expected.deliberateDelta).toBe('strict-pre-dispatch-json-schema-validation');

    // When the real stdio child executes malformed and valid calls.
    const actual = JSON.parse(JSON.stringify(await captureMcpRuntimeSurface(ROOT)));

    // Then machine results match v2 while the v1 shipped-copy fixture remains untouched.
    expect(actual.behaviorV2).toEqual({
      deliberateDelta: expected.deliberateDelta,
      malformed: expected.malformed,
      representative: expected.representative,
    });
    expect(readFileSync(join(ROOT, 'tests/fixtures/mcp-runtime-surface-v1.json'), 'utf8'))
      .toContain('009bbd66366710134b779f2c72e253e2510eec5319818047e1dd7d910a9ce4f0');
  }, 60_000);

  it('returns typed, secret-free refusals for the complete malformed matrix', () => {
    // Given the committed v2 machine contract.
    const contract = JSON.parse(readFileSync(FIXTURE, 'utf8'));

    // When every malformed case is inspected.
    const results = Object.values(contract.malformed) as Array<{
      isError: boolean;
      structuredContent: { error: { code: string; issues: unknown[] } };
    }>;

    // Then each refused before dispatch and no secret value entered machine content.
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error.code).toBe('INVALID_TOOL_ARGUMENTS');
      expect(result.structuredContent.error.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('surface-lock-secret');
      expect(JSON.stringify(result)).not.toContain('surface-lock-token');
    }
  });
});
