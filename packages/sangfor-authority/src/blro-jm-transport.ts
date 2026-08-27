import { request as httpsRequest } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import {
  BLRO_CONTRACT_VERSION,
  CONTRACT_VERSION_HEADER,
  REMOTE_BROWSER_JOB_PATH,
  browserExecutionResultSchema,
  createExactServerIdentityChecker,
  formatContractVersion,
  isLoopbackBrowserTarget,
  type RemoteHttpResponse,
  type RemoteTlsClientOptions,
} from '@sangfor/browser-contracts';
import type {
  BlroDispatchTarget,
  BlroJmDispatchInput,
  BlroJmDispatchOutcome,
  BlroJmTransport,
} from './blro-remote-dispatcher.js';

export type NodeBlroJmTransportOptions = {
  readonly tls: RemoteTlsClientOptions;
  readonly timeoutMs: number;
};

type RequestInput = {
  readonly url: URL;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
};

type RequestObservation =
  | { readonly kind: 'response'; readonly response: RemoteHttpResponse }
  | { readonly kind: 'error'; readonly dispatched: boolean };

export function createNodeBlroJmTransport(options: NodeBlroJmTransportOptions): BlroJmTransport {
  return {
    async preflight(target: BlroDispatchTarget): Promise<boolean> {
      const endpoint = endpointUrl(target.endpointUrl, '/ready');
      const observed = await request({
        url: endpoint, method: 'GET', headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs),
      }, options.tls);
      if (observed.kind !== 'response' || observed.response.statusCode !== 200) return false;
      try {
        const value: unknown = JSON.parse(observed.response.body);
        return typeof value === 'object' && value !== null && 'ok' in value && value.ok === true;
      } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
      }
    },

    async dispatch(input: BlroJmDispatchInput): Promise<BlroJmDispatchOutcome> {
      const body = JSON.stringify(input.envelope);
      const observed = await request({
        url: endpointUrl(input.target.endpointUrl, REMOTE_BROWSER_JOB_PATH),
        method: 'POST',
        headers: {
          accept: 'application/json', 'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          [CONTRACT_VERSION_HEADER]: formatContractVersion(BLRO_CONTRACT_VERSION),
          'x-sangfor-authority-receipt': input.receipt,
          'x-sangfor-authority-receipt-id': input.receiptId,
          'x-sangfor-job-id': input.envelope.jobId,
        },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      }, options.tls);
      if (observed.kind === 'error') {
        return observed.dispatched ? { kind: 'indeterminate' } : { kind: 'predispatch_refused' };
      }
      let value: unknown;
      try {
        value = JSON.parse(observed.response.body);
      } catch (error) {
        if (error instanceof SyntaxError) return { kind: 'indeterminate' };
        throw error;
      }
      const parsed = browserExecutionResultSchema.safeParse(value);
      return parsed.success && parsed.data.requestId === input.envelope.request.requestId
        ? { kind: 'response', result: parsed.data }
        : { kind: 'indeterminate' };
    },
  };
}

function request(input: RequestInput, tls: RemoteTlsClientOptions): Promise<RequestObservation> {
  return new Promise((resolve) => {
    let dispatched = false;
    const checker = tls.checkServerIdentity
      ?? createExactServerIdentityChecker(tls.expectedServerFingerprint256);
    const outgoing = httpsRequest({
      protocol: input.url.protocol, hostname: input.url.hostname,
      port: input.url.port || '443', path: input.url.pathname,
      method: input.method, headers: input.headers, cert: tls.cert, key: tls.key, ca: tls.ca,
      rejectUnauthorized: true, servername: tls.servername ?? input.url.hostname,
      checkServerIdentity: checker as (hostname: string, cert: PeerCertificate) => Error | undefined,
      signal: input.signal,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.on('end', () => resolve({ kind: 'response', response: {
        statusCode: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
      } }));
      incoming.on('error', () => resolve({ kind: 'error', dispatched }));
    });
    outgoing.once('error', () => resolve({ kind: 'error', dispatched }));
    outgoing.once('finish', () => { dispatched = true; });
    outgoing.end(input.body);
  });
}

function endpointUrl(configured: string, path: string): URL {
  const url = new URL(configured);
  if (url.protocol !== 'https:' || !isLoopbackBrowserTarget(configured)
    || url.username || url.password || url.search || url.hash) throw new BlroJmTransportConfigError();
  url.pathname = path; url.search = ''; url.hash = '';
  return url;
}

class BlroJmTransportConfigError extends Error {
  override readonly name = 'BlroJmTransportConfigError';
  constructor() { super('BLRO JM transport requires an HTTPS endpoint.'); }
}
