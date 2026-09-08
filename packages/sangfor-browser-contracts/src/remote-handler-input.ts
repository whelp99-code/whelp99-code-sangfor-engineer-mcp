import { z } from 'zod';
import type { BrowserExecutionContext } from './browser-execution.js';
import type { LeafCertificate } from './enrollment.js';
import { parseJobEnvelope, type JobEnvelope } from './job-envelope.js';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  formatContractVersion,
  negotiateContractVersion,
  type ContractVersion,
} from './protocol-version.js';
import {
  REMOTE_TRANSPORT_ERROR_CODES,
  errorBody,
  jsonHeaders,
  type RemoteHandlerResponse,
  type RemotePeerIdentity,
} from './remote-protocol.js';

export type RemoteTransportPreflightInput = {
  readonly client: RemotePeerIdentity | null;
  readonly method: string;
  readonly urlPath: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
};

export type RemoteHandlerInput = RemoteTransportPreflightInput & {
  readonly bodyText: string;
  readonly executionContext?: BrowserExecutionContext;
};

const approvedPreflight = Symbol('approvedRemoteTransportPreflight');

export type RemoteTransportPreflight = {
  readonly [approvedPreflight]: true;
  readonly certificate: LeafCertificate | undefined;
};

export function preflightTransportInput(
  input: RemoteTransportPreflightInput,
  policy: {
    readonly path: string;
    readonly authority: ContractVersion;
    readonly authorizeClient: (identity: RemotePeerIdentity) => boolean;
  },
): RemoteTransportPreflight | RemoteHandlerResponse {
  if (input.urlPath.split('?')[0] !== policy.path) {
    return response(404, REMOTE_TRANSPORT_ERROR_CODES.PATH_NOT_FOUND, `No handler for ${input.urlPath}.`);
  }
  if (input.method.toUpperCase() !== 'POST') {
    return {
      ...response(405, REMOTE_TRANSPORT_ERROR_CODES.METHOD_NOT_ALLOWED, 'Only POST is accepted.'),
      headers: jsonHeaders({ allow: 'POST' }),
    };
  }
  if (!input.client?.tlsAuthorized) {
    return response(401, REMOTE_TRANSPORT_ERROR_CODES.CLIENT_UNAUTHORIZED, 'An authorized client certificate is required.');
  }
  if (!policy.authorizeClient(input.client)) {
    return response(403, REMOTE_TRANSPORT_ERROR_CODES.CLIENT_UNAUTHORIZED, 'Client certificate is not authorized.');
  }
  const decision = negotiateContractVersion(input.headers?.[CONTRACT_VERSION_HEADER], policy.authority);
  if (decision.kind === 'unsupported') {
    return {
      statusCode: 426,
      bodyText: errorBody(
        REMOTE_TRANSPORT_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED,
        `${decision.reason}: ${decision.message}`,
      ),
      headers: jsonHeaders({ [CONTRACT_VERSION_HEADER]: formatContractVersion(policy.authority) }),
    };
  }
  return {
    [approvedPreflight]: true,
    certificate: input.client.certificate,
  };
}

export function parseRemoteEnvelope(
  bodyText: string,
  now: (() => Date) | undefined,
): JobEnvelope | RemoteHandlerResponse {
  try {
    const body: unknown = JSON.parse(bodyText);
    return parseJobEnvelope(body, (now ?? (() => new Date()))());
  } catch (error) {
    const message = error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join('; ')
      : error instanceof Error ? error.message : 'Invalid envelope.';
    return response(400, REMOTE_TRANSPORT_ERROR_CODES.BAD_ENVELOPE, message);
  }
}

export const defaultContractVersion = (): ContractVersion => BLRO_CONTRACT_VERSION;

function response(statusCode: number, code: string, message: string): RemoteHandlerResponse {
  return { statusCode, bodyText: errorBody(code, message), headers: jsonHeaders() };
}
