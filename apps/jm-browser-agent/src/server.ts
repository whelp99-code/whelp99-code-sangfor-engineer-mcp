import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import {
  createRemoteBrowserJobHandler,
  createRemoteBrowserJobRequestListener,
  REMOTE_BROWSER_JOB_PATH,
} from '../../../packages/sangfor-browser-contracts/src/index.js';
import {
  InFlightJobs,
  RECEIPT_HEADER,
  RECEIPT_ID_HEADER,
} from '../../../packages/sangfor-jm-agent/src/index.js';
import type { JmAgentComposition } from './composition.js';
import { errorBody, refuseUnreadyJob, routeHealth, sendJson } from './routes.js';

export type JmAgentServer = {
  readonly server: Server;
  readonly inFlight: InFlightJobs;
  listen(): Promise<number>;
  close(): Promise<void>;
};

export function createJmAgentServer(composition: JmAgentComposition): JmAgentServer {
  const { config, runtime } = composition;
  const inFlight = new InFlightJobs();
  let listening = false;
  const jobListener = createRemoteBrowserJobRequestListener(createRemoteBrowserJobHandler({
    executor: composition.executor,
    authorizeClient: runtime.authorizeClient,
    jobStore: runtime.jobStore,
  }));

  /**
   * Captures the per-request receipt and the LIVE mTLS peer fingerprint keyed by
   * the job, so the store verifies the receipt against this call's peer rather
   * than anything ambient.
   */
  function dispatch(request: IncomingMessage, response: ServerResponse): void {
    const release = inFlight.enter();
    const header = request.headers[RECEIPT_HEADER];
    const idHeader = request.headers[RECEIPT_ID_HEADER];
    const jobHeader = request.headers['x-sangfor-job-id'];
    const key = typeof jobHeader === 'string' ? jobHeader : '*';
    composition.dispatchContexts.set(key, {
      receipt: typeof header === 'string' ? header : undefined,
      // Announced out of band so the receiptId check cannot be self-satisfied.
      receiptId: typeof idHeader === 'string' ? idHeader : undefined,
      clientFingerprint: (request.socket as TLSSocket)
        .getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase(),
    });
    response.once('close', () => {
      composition.dispatchContexts.delete(key);
      release();
    });
    jobListener(request, response);
  }

  const server = createServer({
    cert: readFileSync(config.tlsCertPath),
    key: readFileSync(config.tlsKeyPath),
    ca: readFileSync(config.tlsClientCaPath),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, (request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (routeHealth(request.method ?? 'GET', path, response, runtime)) return;
    if (path === REMOTE_BROWSER_JOB_PATH) {
      if (refuseUnreadyJob(response, runtime)) return;
      dispatch(request, response);
      return;
    }
    sendJson(response, errorBody('REMOTE_PATH_NOT_FOUND', 'No handler for the path.'), 404);
  });

  return {
    server,
    inFlight,
    listen: (): Promise<number> => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.bindHost, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('JM agent failed to bind.'));
          return;
        }
        listening = true;
        resolve(address.port);
      });
    }),
    // Idempotent: closing a server that never listened, or twice, is a no-op.
    close: (): Promise<void> => {
      if (!listening) return Promise.resolve();
      listening = false;
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
