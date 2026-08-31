import type http from 'node:http';
import type { AuthorityRuntimePort } from './authority-runtime.js';
import { firstReadinessFailure } from './authority-readiness.js';
import { dashboardHtml } from './ui.js';
import {
  MAX_REQUEST_BODY_BYTES,
  readCappedRequestBody,
} from '../../../packages/shared/src/runtime-body-cap.js';
import {
  decodeControlTowerRequestBody,
  parseBoundaryControlTowerRequestBodyV1,
} from './runtime-boundaries.js';
import type {
  ControlTowerRequestBody,
  ControlTowerRequestRoute,
} from './request-boundaries.js';

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

export async function readJsonBody<TRoute extends ControlTowerRequestRoute>(
  request: http.IncomingMessage,
  route: TRoute,
): Promise<ControlTowerRequestBody<TRoute>> {
  const raw = await readCappedRequestBody(request, MAX_REQUEST_BODY_BYTES);
  const body = parseBoundaryControlTowerRequestBodyV1(raw.trim() ? raw : '{}');
  return decodeControlTowerRequestBody(body, route);
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
