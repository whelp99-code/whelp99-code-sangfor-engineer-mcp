import type http from 'node:http';
import type { AuthorityRuntimePort } from './authority-runtime.js';
import { firstReadinessFailure } from './authority-readiness.js';
import { dashboardHtml } from './ui.js';

export function sendJson(
  response: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

type HealthRouteInput = {
  readonly method: string;
  readonly path: string;
  readonly response: http.ServerResponse;
  readonly authorityRuntime?: AuthorityRuntimePort;
};

export async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function refuseUnreadyAuthorityApi(input: HealthRouteInput): Promise<boolean> {
  if (!input.authorityRuntime || !input.path.startsWith('/api/')) return false;
  const readiness = await input.authorityRuntime.readiness();
  if (readiness.ok) return false;
  sendJson(input.response, {
    error: 'BLRO authority is not ready',
    reason: firstReadinessFailure(readiness),
  }, 503);
  return true;
}

export async function routeProcessShell(input: HealthRouteInput): Promise<boolean> {
  if (input.method === 'GET' && (input.path === '/health' || input.path === '/live')) {
    const liveness = input.authorityRuntime?.liveness() ?? { ok: true, state: 'running' };
    sendJson(input.response, liveness, liveness.ok ? 200 : 503);
    return true;
  }
  if (input.method === 'GET' && input.path === '/ready') {
    const readiness = input.authorityRuntime
      ? await input.authorityRuntime.readiness()
      : { ok: true, schemaVersion: 'legacy', checks: {} };
    sendJson(input.response, readiness, readiness.ok ? 200 : 503);
    return true;
  }
  if (input.method === 'GET' && (input.path === '/' || input.path === '/index.html')) {
    input.response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    input.response.end(dashboardHtml());
    return true;
  }
  return false;
}
