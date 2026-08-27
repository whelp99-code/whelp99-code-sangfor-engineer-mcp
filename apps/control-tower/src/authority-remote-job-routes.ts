import type http from 'node:http';
import type { AuthorityRuntimePort } from './authority-runtime.js';
import { readJsonBody, sendJson } from './health-routes.js';

export type AuthorityRemoteJobRouteInput = {
  readonly method: string;
  readonly path: string;
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly authorityRuntime?: AuthorityRuntimePort;
};

export async function routeAuthorityRemoteJob(input: AuthorityRemoteJobRouteInput): Promise<boolean> {
  if (input.path !== '/api/remote-browser-jobs') return false;
  if (input.method !== 'POST') {
    sendJson(input.response, { error: 'METHOD_NOT_ALLOWED' }, 405);
    return true;
  }
  const api = input.authorityRuntime?.remoteJobs?.();
  if (!api) {
    sendJson(input.response, { error: 'REMOTE_JOB_AUTHORITY_UNAVAILABLE' }, 503);
    return true;
  }
  try {
    sendJson(input.response, await api.submit(await readJsonBody(input.request)));
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
      sendJson(input.response, { error: 'INVALID_REMOTE_JOB_REQUEST' }, 400);
      return true;
    }
    sendJson(input.response, { error: 'REMOTE_JOB_AUTHORITY_FAILURE' }, 503);
  }
  return true;
}
