import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('project completeness baseline CLI live-source contract', () => {
  it('rejects tracker snapshots instead of presenting fixtures as live GitHub truth', () => {
    // Given a stale fixture supplied through the former production CLI flag
    const args = [
      'exec',
      'tsx',
      'scripts/report-project-completeness.ts',
      '--baseline',
      '--json',
      '--tracker-snapshot',
      'tests/fixtures/tracker/valid.json',
    ];

    // When the production CLI is invoked
    const result = spawnSync('pnpm', args, { encoding: 'utf8', timeout: 30_000 });

    // Then fixture substitution is a usage error before any source is collected
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument '--tracker-snapshot'");
    expect(result.stdout).not.toContain('BASELINE_CAPTURED');
  });
});
