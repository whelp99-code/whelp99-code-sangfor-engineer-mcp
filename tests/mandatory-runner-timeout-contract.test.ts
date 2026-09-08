import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('Given the heavy PostgreSQL profile, When Vitest is launched, Then test and hook budgets are explicitly bounded outside internal deadlines', () => {
  // Given / When
  const runner = readFileSync('scripts/run-mandatory-postgres-tests.ts', 'utf8');

  // Then
  expect(runner).toContain("'--testTimeout=180000'");
  expect(runner).toContain("'--hookTimeout=180000'");
});
