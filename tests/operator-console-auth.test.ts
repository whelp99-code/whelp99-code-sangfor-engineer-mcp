import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { buildApiHeaders } from '../apps/operator-console/src/ui.js';
import { createOperatorServer } from '../apps/operator-console/src/server.js';

describe('operator console API auth headers', () => {
  it('adds Authorization bearer header when a dashboard token is stored', () => {
    expect(buildApiHeaders('secret-token', { 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer secret-token',
    });
  });

  it('refuses guide export and download without the API token', async () => {
    const previous = process.env.SANGFOR_API_TOKEN;
    process.env.SANGFOR_API_TOKEN = 'guide-token';
    const server = createOperatorServer({ engineerCase: { env: {} } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const exported = await fetch(`${base}/api/engineer-cases/guide-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId: 'case-1' }),
      });
      expect(exported.status).toBe(401);
      expect(await exported.json()).toMatchObject({ error: 'unauthorized' });
      const downloaded = await fetch(`${base}/api/engineer-cases/guide-download?caseId=case-1&artifactId=gdocx-1`);
      expect(downloaded.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.SANGFOR_API_TOKEN;
      else process.env.SANGFOR_API_TOKEN = previous;
    }
  });
});
