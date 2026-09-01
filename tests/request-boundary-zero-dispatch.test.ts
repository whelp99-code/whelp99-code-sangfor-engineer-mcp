import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.MCP_NO_SERVE = '1';

const mocks = vi.hoisted(() => ({
  analyzeProject: vi.fn(),
  createRun: vi.fn(),
}));

vi.mock('../apps/operator-console/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/operator-console/src/api.js')>()),
  postAnalyzeProject: mocks.analyzeProject,
}));

vi.mock('../apps/control-tower/src/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/control-tower/src/api.js')>()),
  createApi: () => ({ createRun: mocks.createRun }),
}));

const { createOperatorServer } = await import('../apps/operator-console/src/server.js');
const { createTowerServer } = await import('../apps/control-tower/src/server.js');

const servers: http.Server[] = [];

afterEach(async () => {
  mocks.analyzeProject.mockReset();
  mocks.createRun.mockReset();
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
}

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('route boundary zero-dispatch behavior', () => {
  it('rejects malformed operator input before its domain handler', async () => {
    // Given
    const base = await listen(createOperatorServer());

    // When
    const response = await post(base, '/api/analyze-project', {
      customerName: 'Acme', requirements: [7],
    });

    // Then
    expect(response.status).toBe(400);
    expect(mocks.analyzeProject).not.toHaveBeenCalled();
  });

  it('rejects malformed control-tower input before API dispatch', async () => {
    // Given
    const base = await listen(createTowerServer({ authorityMode: 'local' }));

    // When
    const response = await post(base, '/api/runs', {
      toolId: 'stub.read', args: [],
    });

    // Then
    expect(response.status).toBe(400);
    expect(mocks.createRun).not.toHaveBeenCalled();
  });
});
