import { createHash, randomBytes } from 'node:crypto';
import type http from 'node:http';
import { isLoopback, checkAuth } from '../../../packages/shared/src/index.js';
import {
  acknowledgeRotationInputSchema,
  claimBootstrapTokenInputSchema,
  enrollmentInstallationIdSchema,
  issueBootstrapTokenInputSchema,
  issueBootstrapTokenRequestSchema,
  revokeEnrollmentInputSchema,
  rotateEnrollmentInputSchema,
  type EnrollmentLifecycleDecision,
  type EnrollmentLifecycleRefusal,
} from '../../../packages/sangfor-browser-contracts/src/index.js';
import type { AuthorityRuntimePort } from './authority-runtime.js';
import { readJsonBody, sendJson } from './health-routes.js';

export type AuthorityEnrollmentRouteInput = {
  readonly method: string;
  readonly path: string;
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly authorityRuntime?: AuthorityRuntimePort;
  readonly apiToken?: string;
};

export function isEnrollmentLoopbackPeer(address: string | undefined): boolean {
  return address !== undefined && isLoopback(address);
}

function refusalStatus(reason: EnrollmentLifecycleRefusal): number {
  switch (reason) {
    case 'CERTIFICATE_INVALID':
    case 'CERTIFICATE_NOT_YET_VALID':
    case 'TOKEN_TTL_EXCEEDED':
      return 400;
    case 'BINDING_MISMATCH':
    case 'CLIENT_EKU_MISSING':
    case 'ENROLLMENT_REVOKED':
    case 'ISSUER_UNTRUSTED':
    case 'SAN_MISMATCH':
      return 403;
    case 'ENROLLMENT_MISSING':
    case 'TOKEN_INVALID':
      return 404;
    case 'ENROLLMENT_EXISTS':
    case 'REVISION_CONFLICT':
    case 'ROTATION_INVALID':
    case 'TOKEN_REPLAYED':
      return 409;
    case 'CERTIFICATE_EXPIRED':
    case 'TOKEN_EXPIRED':
      return 410;
    default:
      return assertNever(reason);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled enrollment refusal: ${String(value)}`);
}

function sendDecision(response: http.ServerResponse, decision: EnrollmentLifecycleDecision): void {
  sendJson(response, decision, decision.ok ? 200 : refusalStatus(decision.reason));
}

function pathInstallation(encoded: string): string {
  return enrollmentInstallationIdSchema.parse(decodeURIComponent(encoded));
}

function assertPathInstallation(pathValue: string, bodyValue: string): void {
  if (pathValue !== bodyValue) throw new EnrollmentRouteInputError('INSTALLATION_PATH_MISMATCH');
}

export async function routeAuthorityEnrollment(input: AuthorityEnrollmentRouteInput): Promise<boolean> {
  if (!input.path.startsWith('/api/enrollments')) return false;
  if (!input.apiToken?.trim()) {
    sendJson(input.response, { error: 'ENROLLMENT_API_TOKEN_UNAVAILABLE' }, 503);
    return true;
  }
  if (!isEnrollmentLoopbackPeer(input.request.socket.remoteAddress)) {
    sendJson(input.response, { error: 'ENROLLMENT_LOOPBACK_REQUIRED' }, 403);
    return true;
  }
  if (!checkAuth(input.request.headers['authorization'], input.apiToken).ok) {
    sendJson(input.response, { error: 'unauthorized' }, 401);
    return true;
  }
  const api = input.authorityRuntime?.enrollments();
  if (!api) {
    sendJson(input.response, { error: 'ENROLLMENT_AUTHORITY_UNAVAILABLE' }, 503);
    return true;
  }
  try {
    if (input.method === 'POST' && input.path === '/api/enrollments/bootstrap-tokens') {
      const request = issueBootstrapTokenRequestSchema.parse(await readJsonBody(input.request));
      const bootstrapToken = randomBytes(32).toString('base64url');
      const decision = await api.issueBootstrapToken(issueBootstrapTokenInputSchema.parse({
        ...request,
        tokenDigest: createHash('sha256').update(bootstrapToken, 'utf8').digest('hex'),
      }));
      if (!decision.ok) {
        sendJson(input.response, decision, refusalStatus(decision.reason));
        return true;
      }
      sendJson(input.response, { ok: true, bootstrapToken });
      return true;
    }
    if (input.method === 'POST' && input.path === '/api/enrollments/bootstrap') {
      sendDecision(input.response, await api.claimBootstrapToken(
        claimBootstrapTokenInputSchema.parse(await readJsonBody(input.request)),
      ));
      return true;
    }
    const resource = input.path.match(/^\/api\/enrollments\/([^/]+)(?:\/(rotate|acknowledge|revoke))?$/u);
    if (!resource?.[1]) return false;
    const installationId = pathInstallation(resource[1]);
    const operation = resource[2];
    if (input.method === 'GET' && operation === undefined) {
      const enrollment = await api.getByInstallation(installationId);
      if (!enrollment) sendJson(input.response, { ok: false, reason: 'ENROLLMENT_MISSING' }, 404);
      else sendJson(input.response, enrollment);
      return true;
    }
    if (input.method !== 'POST' || operation === undefined) return false;
    const body = await readJsonBody(input.request);
    switch (operation) {
      case 'rotate': {
        const parsed = rotateEnrollmentInputSchema.parse(body);
        assertPathInstallation(installationId, parsed.installationId);
        sendDecision(input.response, await api.rotate(parsed));
        return true;
      }
      case 'acknowledge': {
        const parsed = acknowledgeRotationInputSchema.parse(body);
        assertPathInstallation(installationId, parsed.installationId);
        sendDecision(input.response, await api.acknowledgeRotation(parsed));
        return true;
      }
      case 'revoke': {
        const parsed = revokeEnrollmentInputSchema.parse(body);
        assertPathInstallation(installationId, parsed.installationId);
        sendDecision(input.response, await api.revoke(parsed));
        return true;
      }
      default:
        return false;
    }
  } catch (error) {
    if (error instanceof EnrollmentRouteInputError
      || error instanceof SyntaxError
      || error instanceof URIError
      || (error instanceof Error && error.name === 'ZodError')) {
      sendJson(input.response, { error: 'INVALID_ENROLLMENT_REQUEST' }, 400);
      return true;
    }
    sendJson(input.response, { error: 'ENROLLMENT_AUTHORITY_FAILURE' }, 503);
    return true;
  }
}

class EnrollmentRouteInputError extends Error {
  override readonly name = 'EnrollmentRouteInputError';
}
