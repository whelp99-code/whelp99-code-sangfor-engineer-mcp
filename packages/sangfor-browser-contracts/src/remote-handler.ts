import {
  browserExecutionResultSchema,
  type BrowserExecutionContext,
  type BrowserExecutionPort,
} from './browser-execution.js';
import type { JobEnvelope } from './job-envelope.js';
import {
  defaultContractVersion,
  parseRemoteEnvelope,
  refuseTransportInput,
  type RemoteHandlerInput,
} from './remote-handler-input.js';
import {
  REMOTE_JOB_REFUSAL_REASONS,
  type RemoteJobDispatch,
  type RemoteJobReservation,
  type RemoteJobStore,
} from './remote-job-store.js';
import {
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_TRANSPORT_ERROR_CODES,
  errorBody,
  indeterminateAfterDispatch,
  jsonHeaders,
  resultResponse,
  type RemoteHandlerResponse,
  type RemotePeerIdentity,
} from './remote-protocol.js';
import type { ContractVersion } from './protocol-version.js';

export type { RemoteHandlerInput } from './remote-handler-input.js';

export type RemoteBrowserJobHandlerOptions = {
  readonly executor: BrowserExecutionPort;
  readonly authorizeClient: (identity: RemotePeerIdentity) => boolean;
  readonly jobStore: RemoteJobStore;
  readonly now?: () => Date;
  readonly path?: string;
  readonly contractVersion?: ContractVersion;
};

export function createRemoteBrowserJobHandler(options: RemoteBrowserJobHandlerOptions) {
  const path = options.path ?? REMOTE_BROWSER_JOB_PATH;
  const authority = options.contractVersion ?? defaultContractVersion();
  return {
    jobStore: options.jobStore,
    async handle(input: RemoteHandlerInput): Promise<RemoteHandlerResponse> {
      const early = refuseTransportInput(input, {
        path,
        authority,
        authorizeClient: options.authorizeClient,
      });
      if (early) return early;
      const envelope = parseRemoteEnvelope(input.bodyText, options.now);
      if ('statusCode' in envelope) return envelope;
      const certificate = input.client?.certificate;
      const [reserved] = await Promise.allSettled([
        options.jobStore.authorizeAndReserve({ envelope, certificate }),
      ]);
      if (!reserved || reserved.status === 'rejected') {
        return errorResponse(
          503,
          REMOTE_TRANSPORT_ERROR_CODES.JOB_AUTHORITY_UNAVAILABLE,
          'Remote job authority is unavailable; no dispatch was authorized.',
        );
      }
      return reservationResponse({
        options,
        envelope,
        reservation: reserved.value,
        executionContext: input.executionContext,
      });
    },
  };
}

type ReservationContext = {
  readonly options: RemoteBrowserJobHandlerOptions;
  readonly envelope: JobEnvelope;
  readonly reservation: RemoteJobReservation;
  readonly executionContext: BrowserExecutionContext | undefined;
};

async function reservationResponse(context: ReservationContext): Promise<RemoteHandlerResponse> {
  switch (context.reservation.kind) {
    case 'retained':
      return resultResponse(200, context.reservation.result);
    case 'indeterminate':
      return resultResponse(200, indeterminateResult(context.reservation.requestId));
    case 'refused':
      return context.reservation.reason === REMOTE_JOB_REFUSAL_REASONS.REQUEST_CONFLICT
        ? errorResponse(
          409,
          REMOTE_TRANSPORT_ERROR_CODES.JOB_REQUEST_CONFLICT,
          'Remote job request conflicts with retained authority state.',
        )
        : errorResponse(
          403,
          REMOTE_TRANSPORT_ERROR_CODES.JOB_AUTHORIZATION_DENIED,
          'Remote job authorization was refused.',
        );
    case 'unavailable':
      return errorResponse(
        503,
        REMOTE_TRANSPORT_ERROR_CODES.JOB_AUTHORITY_UNAVAILABLE,
        'Remote job authority is unavailable; no dispatch was authorized.',
      );
    case 'dispatch':
      return executeReserved({
        options: context.options,
        envelope: context.envelope,
        dispatch: context.reservation.dispatch,
        executionContext: context.executionContext,
      });
    default:
      throw new RemoteHandlerInvariantError(context.reservation);
  }
}

type ReservedExecutionContext = Omit<ReservationContext, 'reservation'> & {
  readonly dispatch: RemoteJobDispatch;
};

async function executeReserved(context: ReservedExecutionContext): Promise<RemoteHandlerResponse> {
  const [execution] = await Promise.allSettled([
    context.executionContext === undefined
      ? context.options.executor.execute(context.envelope.request)
      : context.options.executor.execute(context.envelope.request, context.executionContext),
  ]);
  if (!execution || execution.status === 'rejected') {
    await sealIndeterminate(context.options.jobStore, context.dispatch);
    return resultResponse(200, indeterminateResult(context.dispatch.requestId));
  }
  const parsed = browserExecutionResultSchema.safeParse(execution.value);
  if (!parsed.success || parsed.data.requestId !== context.dispatch.requestId) {
    await sealIndeterminate(context.options.jobStore, context.dispatch);
    return resultResponse(200, indeterminateResult(context.dispatch.requestId));
  }
  const [retention] = await Promise.allSettled([
    context.options.jobStore.retainResult({ dispatch: context.dispatch, result: parsed.data }),
  ]);
  if (!retention || retention.status === 'rejected') {
    return resultResponse(200, indeterminateResult(context.dispatch.requestId));
  }
  switch (retention.value.kind) {
    case 'retained':
      return resultResponse(200, retention.value.result);
    case 'indeterminate':
      return resultResponse(200, indeterminateResult(context.dispatch.requestId));
    default:
      throw new RemoteHandlerInvariantError(retention.value);
  }
}

async function sealIndeterminate(store: RemoteJobStore, dispatch: RemoteJobDispatch): Promise<void> {
  await Promise.allSettled([store.markIndeterminate({ dispatch })]);
}

function indeterminateResult(requestId: string) {
  return indeterminateAfterDispatch(
    requestId,
    'Dispatch authority was committed, but no authoritative retained result was read back.',
  );
}

function errorResponse(statusCode: number, code: string, message: string): RemoteHandlerResponse {
  return { statusCode, bodyText: errorBody(code, message), headers: jsonHeaders() };
}

class RemoteHandlerInvariantError extends Error {
  override readonly name = 'RemoteHandlerInvariantError';
  constructor(readonly value: never) {
    super('Remote job reservation variant was not handled.');
  }
}
