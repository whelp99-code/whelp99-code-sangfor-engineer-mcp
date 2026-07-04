import http from 'node:http';
import { URL } from 'node:url';
import { checkAuth } from '../../../packages/shared/src/index.js';
import type { RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import { createApi, ApiError, type TowerOptions } from './api.js';

export interface TowerServerOptions extends TowerOptions {
  apiToken?: string;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

export function createTowerServer(opts: TowerServerOptions = {}): http.Server {
  const api = createApi(opts);
  const apiToken = opts.apiToken ?? process.env.SANGFOR_API_TOKEN;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Shared-secret gate for API routes (no-op when the token is unset).
    if (path.startsWith('/api/')) {
      const auth = checkAuth(req.headers['authorization'], apiToken);
      if (!auth.ok) return json(res, { error: 'unauthorized' }, auth.status ?? 401);
    }

    try {
      if (method === 'POST' && path === '/api/runs') {
        const b = await readJsonBody(req);
        return json(res, await api.createRun({
          toolId: String(b.toolId ?? ''),
          args: (b.args && typeof b.args === 'object' ? b.args : {}) as Record<string, unknown>,
          deviceId: typeof b.deviceId === 'string' ? b.deviceId : undefined,
        }));
      }
      if (method === 'GET' && path === '/api/runs') {
        const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v));
        return json(res, {
          runs: api.listRuns({
            status: (url.searchParams.get('status') ?? undefined) as RunStatus | undefined,
            toolId: url.searchParams.get('toolId') ?? undefined,
            deviceId: url.searchParams.get('deviceId') ?? undefined,
            sweepId: url.searchParams.get('sweepId') ?? undefined,
            sinceDays: num(url.searchParams.get('sinceDays')),
            limit: num(url.searchParams.get('limit')),
          }),
        });
      }
      const approveMatch = path.match(/^\/api\/runs\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const b = await readJsonBody(req);
        return json(res, await api.approveRun(approveMatch[1], {
          approvedBy: String(b.approvedBy ?? ''),
          changeTicketId: typeof b.changeTicketId === 'string' ? b.changeTicketId : undefined,
          rollbackPlanId: typeof b.rollbackPlanId === 'string' ? b.rollbackPlanId : undefined,
        }));
      }
      const rejectMatch = path.match(/^\/api\/runs\/([^/]+)\/reject$/);
      if (method === 'POST' && rejectMatch) {
        const b = await readJsonBody(req);
        return json(res, api.rejectRun(rejectMatch[1], {
          reason: typeof b.reason === 'string' ? b.reason : undefined,
        }));
      }
      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (method === 'GET' && runMatch) return json(res, api.getRun(runMatch[1]));

      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json(res, { error: error.message }, error.status);
      return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}
