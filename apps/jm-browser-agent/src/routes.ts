import type { ServerResponse } from 'node:http';
import {
  firstReadinessFailure,
  type JmAgentRuntime,
} from '../../../packages/sangfor-jm-agent/src/index.js';

export function sendJson(response: ServerResponse, body: unknown, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function errorBody(code: string, message: string): unknown {
  return { schemaVersion: 'browser-remote-error.v1', error: { code, message } };
}

/**
 * The process-and-dependency shell. `/live` is process-only by construction: it
 * reads the liveness state and touches no dependency and no dispatch path.
 */
export function routeHealth(
  method: string,
  path: string,
  response: ServerResponse,
  runtime: JmAgentRuntime,
): boolean {
  if (method === 'GET' && path === '/live') {
    const liveness = runtime.liveness();
    sendJson(response, liveness, liveness.ok ? 200 : 503);
    return true;
  }
  if (method === 'GET' && path === '/ready') {
    const readiness = runtime.readiness();
    sendJson(response, readiness, readiness.ok ? 200 : 503);
    return true;
  }
  return false;
}

/** Refuses the job route before any dispatch when a dependency is unready. */
export function refuseUnreadyJob(
  response: ServerResponse,
  runtime: JmAgentRuntime,
): boolean {
  const readiness = runtime.readiness();
  if (readiness.ok) return false;
  sendJson(response, errorBody(
    'JM_AGENT_UNREADY',
    firstReadinessFailure(readiness) ?? 'JM agent is not ready.',
  ), 503);
  return true;
}
