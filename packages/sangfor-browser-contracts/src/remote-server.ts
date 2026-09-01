import {
  createServer as createHttpsServer,
  type Server,
} from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import {
  REMOTE_BROWSER_JOB_PATH,
  REMOTE_EXECUTION_DEADLINE_HEADER,
  REMOTE_JOB_BODY_MAX_BYTES,
  REMOTE_TRANSPORT_ERROR_CODES,
  errorBody,
  jsonHeaders,
  peerIdentityFromCertificate,
  type RemoteHandlerResponse,
} from './remote-protocol.js';
import {
  createRemoteBrowserJobHandler,
  type RemoteBrowserJobHandlerOptions,
} from './remote-handler.js';

export { createRemoteBrowserJobHandler } from './remote-handler.js';

export interface RemoteBrowserJobServerOptions extends RemoteBrowserJobHandlerOptions {
  readonly tls: {
    readonly cert: string | Buffer;
    readonly key: string | Buffer;
    readonly ca: string | Buffer | Array<string | Buffer>;
    readonly rejectUnauthorized?: boolean;
  };
  readonly host?: string;
  readonly port?: number;
  readonly server?: Server;
  readonly createServer?: typeof createHttpsServer;
}

async function readBoundedRequestBody(
  request: IncomingMessage,
): Promise<string | null> {
  const contentLength = request.headers['content-length'];
  if (
    typeof contentLength === 'string'
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > REMOTE_JOB_BODY_MAX_BYTES
  ) {
    return null;
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    if (chunk.length > REMOTE_JOB_BODY_MAX_BYTES - receivedBytes) {
      return null;
    }
    chunks.push(chunk);
    receivedBytes += chunk.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function refuseWithoutBody(
  request: IncomingMessage,
  response: ServerResponse,
  output: RemoteHandlerResponse,
): void {
  response.writeHead(output.statusCode, { ...output.headers, connection: 'close' });
  response.end(output.bodyText, () => request.destroy());
}

export function createRemoteBrowserJobRequestListener(
  handler: ReturnType<typeof createRemoteBrowserJobHandler>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => {
      if (!response.writableFinished) controller.abort();
    });
    void (async () => {
      try {
        const socket = request.socket as TLSSocket;
        const certificate = socket.getPeerCertificate();
        const metadata = {
          client: peerIdentityFromCertificate(certificate, socket.authorized),
          method: request.method ?? 'GET',
          urlPath: request.url ?? '/',
          headers: request.headers,
        };
        const authorization = handler.preflight(metadata);
        if ('statusCode' in authorization) {
          refuseWithoutBody(request, response, authorization);
          return;
        }
        const bodyText = await readBoundedRequestBody(request);
        if (bodyText === null) {
          refuseWithoutBody(request, response, {
            statusCode: 413,
            headers: jsonHeaders(),
            bodyText: errorBody(
              REMOTE_TRANSPORT_ERROR_CODES.BODY_TOO_LARGE,
              `Remote job envelope exceeds ${REMOTE_JOB_BODY_MAX_BYTES} bytes.`,
            ),
          });
          return;
        }
        const deadlineHeader = request.headers[REMOTE_EXECUTION_DEADLINE_HEADER];
        const deadline = typeof deadlineHeader === 'string'
          && Number.isFinite(Date.parse(deadlineHeader))
          ? new Date(deadlineHeader).toISOString()
          : undefined;
        const output = await handler.handleAuthorized(authorization, {
          bodyText,
          ...(deadline === undefined
            ? {}
            : { executionContext: { signal: controller.signal, deadline } }),
        });
        response.writeHead(output.statusCode, output.headers);
        response.end(output.bodyText);
      } catch (error) {
        response.writeHead(500, jsonHeaders());
        response.end(errorBody(
          REMOTE_TRANSPORT_ERROR_CODES.BAD_RESPONSE,
          error instanceof Error ? error.message : String(error),
        ));
      }
    })();
  };
}

export async function createRemoteBrowserJobServer(
  options: RemoteBrowserJobServerOptions,
) {
  const handler = createRemoteBrowserJobHandler(options);
  const listener = createRemoteBrowserJobRequestListener(handler);
  const server = options.server ?? (options.createServer ?? createHttpsServer)({
    cert: options.tls.cert,
    key: options.tls.key,
    ca: options.tls.ca,
    requestCert: true,
    rejectUnauthorized: options.tls.rejectUnauthorized ?? true,
    minVersion: 'TLSv1.2',
  }, listener);
  if (options.server) server.on('request', listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Remote browser server failed to bind.');
  }
  return {
    server,
    host: address.address,
    port: address.port,
    baseUrl:
      `https://${address.address}:${address.port}${options.path ?? REMOTE_BROWSER_JOB_PATH}`,
    handler,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
