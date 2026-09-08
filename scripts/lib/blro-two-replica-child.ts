import { createPrivateKey } from 'node:crypto';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';
import {
  PostgresRemoteJobStore,
  createBlroRemoteDispatcher,
  createNodeBlroJmTransport,
  createPostgresRemoteJobCompletionObserver,
  signJmAuthorityArtifact,
} from '../../packages/sangfor-authority/src/index.js';
import type { RemoteJobDispatch } from '../../packages/sangfor-browser-contracts/src/index.js';
import {
  parentMessageSchema,
  replicaConfigSchema,
  type ChildMessage,
  type ReplicaConfig,
} from './blro-two-replica-types.js';

function send(message: ChildMessage): void {
  if (!process.send) throw new ReplicaChildError('IPC_UNAVAILABLE');
  process.send(message);
}

export async function runReplicaChild(rawConfig: unknown): Promise<void> {
  const config = replicaConfigSchema.parse(rawConfig);
  const signingKey = createPrivateKey(config.signingPrivateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new ReplicaChildError('SIGNING_KEY_INVALID');
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const completion = createPostgresRemoteJobCompletionObserver(config.databaseUrl);
  await completion.ready();
  const releases = new Map<string, () => void>();
  const failpoints = new Map<string, { readonly id: string; readonly kind: 'pre_commit' | 'post_commit' }>();
  const commandIds = new Map<string, string[]>();
  const waitForRelease = (id: string): Promise<void> => new Promise((resolve) => { releases.set(id, resolve); });
  const store = new PostgresRemoteJobStore({
    database: prisma,
    scope: { tenantId: config.tenantId, projectId: config.projectId },
    capabilityPublicKey: config.capabilityPublicKey,
    trustedIssuerBundle: config.trustedIssuerBundle,
    completionObserver: completion,
    completionTimeoutMs: 30_000,
    reservationObserver: {
      prepared: async (reservation) => {
        if (reservation.kind !== 'dispatch') return;
        const requestId = reservation.dispatch.requestId;
        const id = commandIds.get(requestId)?.shift();
        if (id) send({ kind: 'lifecycle', id, event: 'reserved' });
        const failpoint = failpoints.get(requestId);
        if (failpoint?.kind === 'pre_commit') await waitForRelease(failpoint.id);
      },
      waiting: async (requestId) => {
        const id = commandIds.get(requestId)?.shift();
        if (id) send({ kind: 'lifecycle', id, event: 'waiting' });
      },
    },
  });
  const transport = createNodeBlroJmTransport({
    tls: {
      cert: config.clientCertificatePem,
      key: config.clientKeyPem,
      ca: config.caPem,
      expectedServerFingerprint256: config.serverFingerprint,
      servername: 'localhost',
    },
    timeoutMs: 5_000,
  });
  const dispatcher = createBlroRemoteDispatcher({
    authority: store,
    transport,
    executionPolicy: { allowRealExecution: true, allowProductionExecution: true },
    receiptSigner: {
      sign: (artifact) => signJmAuthorityArtifact(artifact, config.signingPrivateKey),
      keyId: config.keyId,
      keyDigest: config.keyDigest,
      clientCertificateFingerprintSha256: config.clientFingerprint,
      now: () => new Date(),
    },
    lifecycleObserver: {
      async dispatchBoundary(dispatch): Promise<void> {
        const failpoint = failpoints.get(dispatch.requestId);
        if (failpoint?.kind !== 'post_commit') return;
        send({ kind: 'lifecycle', id: failpoint.id, event: 'dispatch-boundary' });
        await waitForRelease(failpoint.id);
      },
      async resultRetained(dispatch): Promise<void> {
        const failpoint = failpoints.get(dispatch.requestId);
        if (failpoint) send({ kind: 'lifecycle', id: failpoint.id, event: 'result-retained' });
      },
    },
  });
  const server = createServer(async (_request, response) => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      if (!await transport.preflight(dispatchTarget(config))) throw new ReplicaChildError('JM_UNREADY');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        ok: true, identity: config.identity, pid: process.pid,
      }));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  send({ kind: 'ready', identity: config.identity, pid: process.pid, port: config.port });

  process.on('message', (raw: unknown) => {
    void handleMessage(raw, { config, dispatcher, failpoints, commandIds, releases,
      close: async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await Promise.all([completion.close(), prisma.$disconnect()]);
      } });
  });
}

type ChildContext = {
  readonly config: ReplicaConfig;
  readonly dispatcher: ReturnType<typeof createBlroRemoteDispatcher>;
  readonly failpoints: Map<string, { readonly id: string; readonly kind: 'pre_commit' | 'post_commit' }>;
  readonly commandIds: Map<string, string[]>;
  readonly releases: Map<string, () => void>;
  readonly close: () => Promise<void>;
};

async function handleMessage(raw: unknown, context: ChildContext): Promise<void> {
  const message = parentMessageSchema.parse(raw);
  switch (message.kind) {
    case 'release': context.releases.get(message.id)?.(); context.releases.delete(message.id); return;
    case 'stop': await context.close(); process.disconnect?.(); process.exitCode = 0; return;
    case 'submit': {
      const parsed: unknown = JSON.parse(message.bodyText);
      const requestId = requestIdFrom(parsed);
      if (requestId) {
        const ids = context.commandIds.get(requestId) ?? [];
        ids.push(message.id);
        context.commandIds.set(requestId, ids);
        if (message.failpoint !== 'none') {
          context.failpoints.set(requestId, { id: message.id, kind: message.failpoint });
        }
      }
      try {
        const result = await context.dispatcher.submit({
          purpose: message.purpose,
          bodyText: message.bodyText,
          target: dispatchTarget(context.config),
        });
        send({ kind: 'result', id: message.id, result });
      } catch (error) {
        send({ kind: 'failure', id: message.id, code: error instanceof Error ? error.name : 'UNKNOWN' });
      } finally {
        if (requestId) context.failpoints.delete(requestId);
      }
      return;
    }
    default: return assertNever(message);
  }
}

function dispatchTarget(config: ReplicaConfig) {
  return {
    tenantId: config.tenantId, projectId: config.projectId,
    installationId: config.installationId, clientIdentityId: config.clientIdentityId,
    deviceBindingDigest: config.deviceBindingDigest, origin: config.origin,
    certificate: { encoding: 'der-base64' as const, value: config.clientCertificate },
    endpointUrl: config.endpointUrl, environment: 'production' as const,
  };
}

function requestIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('request' in value)) return undefined;
  const request = value.request;
  if (!request || typeof request !== 'object' || !('requestId' in request)) return undefined;
  return typeof request.requestId === 'string' ? request.requestId : undefined;
}

function assertNever(value: never): never { throw new TypeError(JSON.stringify(value)); }
class ReplicaChildError extends Error { override readonly name = 'ReplicaChildError'; }
