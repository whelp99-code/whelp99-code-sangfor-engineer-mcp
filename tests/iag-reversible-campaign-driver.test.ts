import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMockConsoleServer } from '../apps/mock-sangfor-console/src/server.js';
import { runMockIagCampaign } from '../scripts/lib/iag-reversible-campaign.js';

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new TypeError('TEST_SERVER_ADDRESS_MISSING');
  return `http://127.0.0.1:${address.port}/iag`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

describe('Todo 18 reversible IAG campaign driver', () => {
  it('Given an empty loopback mock, When three cycles run, Then every apply is read back and explicitly restored', async () => {
    // Given
    const baseUrl = await listen(createMockConsoleServer());

    // When
    const report = await runMockIagCampaign({ baseUrl, exception: 'qa.example.invalid', restore: true });

    // Then
    expect(report).toMatchObject({
      evidenceClass: 'mock', maturity: 'tested_mock', promotionEligible: false,
      cycleCount: 3, deviceCount: 2, windowCount: 2,
      readBackPassCount: 9, readBackCount: 9, restoredCount: 3,
      retryCount: 0, collateralMutationCount: 0,
    });
    expect(new Set(report.cycles.map(({ deviceIdentityDigest }) => deviceIdentityDigest))).toHaveLength(2);
    expect(new Set(report.cycles.map(({ windowIdentityDigest }) => windowIdentityDigest))).toHaveLength(2);
  });

  it('Given the exception already exists, When a campaign starts, Then it refuses without deleting prior state', async () => {
    // Given
    const server = createMockConsoleServer({
      iagInitialEntries: [{ kind: 'URL_DOMAIN_EXCEPTION', value: 'qa.example.invalid', effect: 'ALLOW' }],
    });
    const baseUrl = await listen(server);

    // When
    const result = runMockIagCampaign({ baseUrl, exception: 'qa.example.invalid', restore: true });

    // Then
    await expect(result).rejects.toThrow('IAG_MOCK_PREEXISTING_EXCEPTION');
  });

  it('Given the exact CLI arguments, When the loopback campaign completes, Then it prints the PASS sentinel and candidate report', async () => {
    // Given
    const baseUrl = await listen(createMockConsoleServer());
    const child = spawn('pnpm', [
      'exec', 'tsx', 'scripts/test-iag-reversible-apply.ts',
      '--base-url', baseUrl, '--exception', 'qa.example.invalid', '--restore',
    ], { cwd: process.cwd(), env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // When
    const [status] = await once(child, 'close');

    // Then
    expect(status).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe('IAG_REVERSIBLE_APPLY_PASS');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ promotionEligible: false, cycleCount: 3 });
  });
});
