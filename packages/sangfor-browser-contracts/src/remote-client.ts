import { request as httpsRequest } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import {
  browserExecutionRequestSchema,
  browserExecutionResultSchema,
  type BrowserExecutionPort,
} from './browser-execution.js';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  formatContractVersion,
  type ContractVersion,
} from './protocol-version.js';
import {
  REMOTE_EXECUTION_DEADLINE_HEADER,
  REMOTE_TRANSPORT_ERROR_CODES,
  buildRemoteJobEnvelope,
  createExactServerIdentityChecker,
  indeterminateAfterDispatch,
  normalizeFingerprint256,
  refusedResult,
  remoteErrorBodySchema,
  type RemoteEnvelopeOptions,
} from './remote-protocol.js';
import { collectRemoteResponseBody } from './remote-response.js';

export interface RemoteTlsClientOptions {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
  readonly ca: string | Buffer | Array<string | Buffer>;
  readonly expectedServerFingerprint256: string;
  readonly servername?: string;
  readonly checkServerIdentity?: (
    servername: string,
    certificate: PeerCertificate,
  ) => Error | undefined;
}

export interface RemoteHttpRequest {
  readonly url: URL;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly tls: RemoteTlsClientOptions;
  readonly signal?: AbortSignal;
  readonly deadline?: string;
}

export interface RemoteHttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface DispatchHooks {
  markDispatched(): void;
}

export type RemoteHttpTransport = (
  request: RemoteHttpRequest,
  hooks: DispatchHooks,
) => Promise<RemoteHttpResponse>;

export interface RemoteBrowserExecutionPortOptions {
  readonly endpointUrl: string;
  readonly tls: RemoteTlsClientOptions;
  readonly envelope: RemoteEnvelopeOptions;
  readonly transport?: RemoteHttpTransport;
  /** The contract version this endpoint speaks; declared on every dispatch. */
  readonly contractVersion?: ContractVersion;
}

export function createNodeHttpsTransport(): RemoteHttpTransport {
  return (request, hooks) => new Promise((resolve, reject) => {
    const checker = request.tls.checkServerIdentity
      ?? createExactServerIdentityChecker(request.tls.expectedServerFingerprint256);
    const outgoing = httpsRequest({
      protocol: request.url.protocol,
      hostname: request.url.hostname,
      port: request.url.port || '443',
      path: `${request.url.pathname}${request.url.search}`,
      method: request.method,
      headers: request.headers,
      cert: request.tls.cert,
      key: request.tls.key,
      ca: request.tls.ca,
      rejectUnauthorized: true,
      servername: request.tls.servername ?? request.url.hostname,
      checkServerIdentity: checker,
      signal: request.signal,
    }, (incoming) => {
      collectRemoteResponseBody(incoming).then((body) => resolve({
        statusCode: incoming.statusCode ?? 0,
        body,
      }), reject);
    });
    outgoing.on('error', reject);
    outgoing.on('finish', hooks.markDispatched);
    outgoing.end(request.body);
  });
}

export interface RemoteBrowserExecutionPort extends BrowserExecutionPort {
  readonly buildEnvelope: typeof buildRemoteJobEnvelope;
}

export function createRemoteBrowserExecutionPort(
  options: RemoteBrowserExecutionPortOptions,
): RemoteBrowserExecutionPort {
  const endpointUrl = new URL(options.endpointUrl);
  if (endpointUrl.protocol !== 'https:') {
    throw new Error('Remote browser transport endpoint must use https.');
  }
  if (!normalizeFingerprint256(options.tls.expectedServerFingerprint256)) {
    throw new Error('expectedServerFingerprint256 is required.');
  }
  const transport = options.transport ?? createNodeHttpsTransport();
  const declaredVersion = formatContractVersion(
    options.contractVersion ?? BLRO_CONTRACT_VERSION,
  );
  return {
    buildEnvelope: buildRemoteJobEnvelope,
    async execute(input, context) {
      const request = browserExecutionRequestSchema.parse(input);
      const envelope = buildRemoteJobEnvelope(request, options.envelope);
      const body = JSON.stringify(envelope);
      let dispatched = false;
      try {
        const response = await transport({
          url: endpointUrl,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'content-length': String(Buffer.byteLength(body)),
            [CONTRACT_VERSION_HEADER]: declaredVersion,
            ...(context === undefined
              ? {}
              : { [REMOTE_EXECUTION_DEADLINE_HEADER]: context.deadline }),
          },
          body,
          tls: options.tls,
          signal: context?.signal,
          deadline: context?.deadline,
        }, {
          markDispatched() {
            dispatched = true;
          },
        });
        return mapResponse(request.requestId, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (dispatched) {
          return indeterminateAfterDispatch(
            request.requestId,
            `Connection lost after job dispatch: ${message}`,
          );
        }
        const identityCode = REMOTE_TRANSPORT_ERROR_CODES.SERVER_IDENTITY_MISMATCH;
        return refusedResult(
          request.requestId,
          message.includes(identityCode)
            ? identityCode
            : REMOTE_TRANSPORT_ERROR_CODES.TRANSPORT_UNAVAILABLE,
          message,
        );
      }
    },
  };
}

function mapResponse(
  requestId: string,
  response: RemoteHttpResponse,
) {
  let parsed: unknown;
  try {
    parsed = response.body ? JSON.parse(response.body) : null;
  } catch {
    return indeterminateAfterDispatch(requestId, 'Remote response was invalid JSON.');
  }
  const result = browserExecutionResultSchema.safeParse(parsed);
  if (!result.success) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return indeterminateAfterDispatch(requestId, 'Remote success body was not a valid result.');
    }
    const refusal = remoteErrorBodySchema.safeParse(parsed);
    return refusal.success
      ? refusedResult(requestId, refusal.data.error.code, refusal.data.error.message)
      : refusedResult(
        requestId,
        REMOTE_TRANSPORT_ERROR_CODES.BAD_RESPONSE,
        `Remote endpoint refused the dispatch with HTTP ${response.statusCode}.`,
      );
  }
  return result.data.requestId === requestId
    ? result.data
    : indeterminateAfterDispatch(requestId, 'Remote result requestId mismatch.');
}
