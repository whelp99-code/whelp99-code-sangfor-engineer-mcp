import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createRemoteBrowserExecutionPort,
  mintJobCapability,
  type BrowserExecutionPort,
  type BrowserExecutionRequest,
} from '../../../packages/sangfor-browser-contracts/src/index.js';

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`REMOTE_BROWSER_CONFIG_MISSING: ${key}`);
  return value;
}

function readRequiredFile(env: Environment, key: string): string {
  return readFileSync(required(env, key), 'utf8');
}

export function createRemoteBrowserExecutionPortFromEnv(
  env: Environment = process.env,
): BrowserExecutionPort | undefined {
  const endpointUrl = env.SANGFOR_REMOTE_BROWSER_URL?.trim();
  if (!endpointUrl) return undefined;
  const tenantId = required(env, 'SANGFOR_TENANT_ID');
  const projectId = required(env, 'SANGFOR_PROJECT_ID');
  const installationId = required(env, 'SANGFOR_REMOTE_BROWSER_INSTALLATION_ID');
  const clientIdentityId = required(env, 'SANGFOR_REMOTE_BROWSER_CLIENT_IDENTITY_ID');
  const privateKey = readRequiredFile(
    env,
    'SANGFOR_REMOTE_BROWSER_CAPABILITY_PRIVATE_KEY_PATH',
  );
  return createRemoteBrowserExecutionPort({
    endpointUrl,
    tls: {
      cert: readRequiredFile(env, 'SANGFOR_REMOTE_BROWSER_CLIENT_CERT_PATH'),
      key: readRequiredFile(env, 'SANGFOR_REMOTE_BROWSER_CLIENT_KEY_PATH'),
      ca: readRequiredFile(env, 'SANGFOR_REMOTE_BROWSER_CA_CERT_PATH'),
      expectedServerFingerprint256: required(
        env,
        'SANGFOR_REMOTE_BROWSER_SERVER_FINGERPRINT_SHA256',
      ),
      ...(env.SANGFOR_REMOTE_BROWSER_SERVER_NAME?.trim()
        ? { servername: env.SANGFOR_REMOTE_BROWSER_SERVER_NAME.trim() }
        : {}),
    },
    envelope: {
      tenantId,
      projectId,
      runId: (request) => request.sessionId,
      stepId: (request) => request.requestId,
      jobId: (request) => request.requestId,
      capability: capabilityFactory({
        tenantId,
        projectId,
        installationId,
        clientIdentityId,
        privateKey,
      }),
    },
  });
}

function capabilityFactory(scope: {
  readonly tenantId: string;
  readonly projectId: string;
  readonly installationId: string;
  readonly clientIdentityId: string;
  readonly privateKey: string;
}) {
  return (input: {
    readonly request: BrowserExecutionRequest;
    readonly runId: string;
    readonly stepId: string;
    readonly jobId: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
  }): string => mintJobCapability({
    ...scope,
    ...input,
    jti: randomUUID(),
  });
}
