import { z } from 'zod';
import {
  browserExecutionResultSchema,
  type BrowserExecutionContext,
  type BrowserExecutionPort,
  type BrowserExecutionResult,
} from './browser-execution.js';
import { parseJobEnvelope, type JobEnvelope } from './job-envelope.js';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  formatContractVersion,
  negotiateContractVersion,
  type ContractVersion,
} from './protocol-version.js';
import {
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_TRANSPORT_ERROR_CODES,
  errorBody,
  jsonHeaders,
  resultResponse,
  type RemoteHandlerResponse,
  type RemotePeerIdentity,
} from './remote-protocol.js';

export interface JobIdempotencyStore {
  get(jobId: string): Promise<BrowserExecutionResult | undefined>;
  put(jobId: string, result: BrowserExecutionResult): Promise<void>;
}

class MemoryJobIdempotencyStore implements JobIdempotencyStore {
  private readonly results = new Map<string, BrowserExecutionResult>();

  async get(jobId: string): Promise<BrowserExecutionResult | undefined> {
    return this.results.get(jobId);
  }

  async put(jobId: string, result: BrowserExecutionResult): Promise<void> {
    this.results.set(jobId, result);
  }
}

export interface RemoteBrowserJobHandlerOptions {
  readonly executor: BrowserExecutionPort;
  readonly authorizeClient: (identity: RemotePeerIdentity) => boolean;
  readonly preExecution?: (input: {
    readonly client: RemotePeerIdentity;
    readonly envelope: JobEnvelope;
  }) => Promise<
    | { readonly allow: true }
    | { readonly allow: false; readonly code?: string; readonly message: string }
  >;
  readonly idempotencyStore?: JobIdempotencyStore;
  readonly now?: () => Date;
  readonly path?: string;
  /** The contract version this BLRO authority speaks. Peers negotiate against it. */
  readonly contractVersion?: ContractVersion;
}

export interface RemoteHandlerInput {
  readonly client: RemotePeerIdentity | null;
  readonly method: string;
  readonly urlPath: string;
  readonly bodyText: string;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly executionContext?: BrowserExecutionContext;
}

export function createRemoteBrowserJobHandler(
  options: RemoteBrowserJobHandlerOptions,
) {
  const store = options.idempotencyStore ?? new MemoryJobIdempotencyStore();
  const inFlight = new Map<string, Promise<BrowserExecutionResult>>();
  const path = options.path ?? REMOTE_BROWSER_JOB_PATH;
  const authority = options.contractVersion ?? BLRO_CONTRACT_VERSION;
  return {
    idempotencyStore: store,
    async handle(input: RemoteHandlerInput): Promise<RemoteHandlerResponse> {
      const early = earlyRefuse(input, path, options.authorizeClient)
        ?? refuseUnsupportedContract(input, authority);
      if (early) return early;
      const client = input.client as RemotePeerIdentity;
      const parsed = parseEnvelope(input.bodyText, options.now);
      if ('statusCode' in parsed) return parsed;
      const envelope = parsed;
      const cached = await store.get(envelope.jobId);
      if (cached) return resultResponse(200, cached);
      const running = inFlight.get(envelope.jobId);
      if (running) return resultResponse(200, await running);
      const execution = executeOnce({
        options, client, envelope, store, executionContext: input.executionContext,
      });
      inFlight.set(envelope.jobId, execution);
      try {
        return resultResponse(200, await execution);
      } catch (error) {
        if (error instanceof AuthorizationRefusal) {
          return {
            statusCode: 403,
            bodyText: errorBody(error.code, error.message),
            headers: jsonHeaders(),
          };
        }
        throw error;
      } finally {
        inFlight.delete(envelope.jobId);
      }
    },
  };
}

class AuthorizationRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface RemoteExecutionInput {
  readonly options: RemoteBrowserJobHandlerOptions;
  readonly client: RemotePeerIdentity;
  readonly envelope: JobEnvelope;
  readonly store: JobIdempotencyStore;
  readonly executionContext: BrowserExecutionContext | undefined;
}

async function executeOnce(input: RemoteExecutionInput): Promise<BrowserExecutionResult> {
  if (input.options.preExecution) {
    const decision = await input.options.preExecution({
      client: input.client, envelope: input.envelope,
    });
    if (!decision.allow) {
      throw new AuthorizationRefusal(
        decision.code ?? REMOTE_TRANSPORT_ERROR_CODES.JOB_AUTHORIZATION_DENIED,
        decision.message,
      );
    }
  }
  const rawResult = input.executionContext === undefined
    ? await input.options.executor.execute(input.envelope.request)
    : await input.options.executor.execute(input.envelope.request, input.executionContext);
  const result = browserExecutionResultSchema.parse(rawResult);
  await input.store.put(input.envelope.jobId, result);
  return result;
}

function earlyRefuse(
  input: RemoteHandlerInput,
  path: string,
  authorizeClient: (identity: RemotePeerIdentity) => boolean,
): RemoteHandlerResponse | undefined {
  if (input.urlPath.split('?')[0] !== path) {
    return {
      statusCode: 404,
      bodyText: errorBody(
        REMOTE_TRANSPORT_ERROR_CODES.PATH_NOT_FOUND,
        `No handler for ${input.urlPath}.`,
      ),
      headers: jsonHeaders(),
    };
  }
  if (input.method.toUpperCase() !== 'POST') {
    return {
      statusCode: 405,
      bodyText: errorBody(
        REMOTE_TRANSPORT_ERROR_CODES.METHOD_NOT_ALLOWED,
        'Only POST is accepted.',
      ),
      headers: jsonHeaders({ allow: 'POST' }),
    };
  }
  if (!input.client || !input.client.tlsAuthorized) {
    return {
      statusCode: 401,
      bodyText: errorBody(
        REMOTE_TRANSPORT_ERROR_CODES.CLIENT_UNAUTHORIZED,
        'An authorized client certificate is required.',
      ),
      headers: jsonHeaders(),
    };
  }
  if (!authorizeClient(input.client)) {
    return {
      statusCode: 403,
      bodyText: errorBody(
        REMOTE_TRANSPORT_ERROR_CODES.CLIENT_UNAUTHORIZED,
        'Client certificate is not authorized.',
      ),
      headers: jsonHeaders(),
    };
  }
  return undefined;
}

/**
 * The canonical header key is looked up exactly. A differently-cased or
 * differently-spelled key is not a declaration, so it refuses as missing.
 */
function refuseUnsupportedContract(
  input: RemoteHandlerInput,
  authority: ContractVersion,
): RemoteHandlerResponse | undefined {
  const decision = negotiateContractVersion(
    input.headers?.[CONTRACT_VERSION_HEADER],
    authority,
  );
  if (decision.kind === 'supported') return undefined;
  return {
    statusCode: 426,
    bodyText: errorBody(
      REMOTE_TRANSPORT_ERROR_CODES.CONTRACT_VERSION_UNSUPPORTED,
      `${decision.reason}: ${decision.message}`,
    ),
    headers: jsonHeaders({
      [CONTRACT_VERSION_HEADER]: formatContractVersion(authority),
    }),
  };
}

function parseEnvelope(
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
    return {
      statusCode: 400,
      bodyText: errorBody(REMOTE_TRANSPORT_ERROR_CODES.BAD_ENVELOPE, message),
      headers: jsonHeaders(),
    };
  }
}
