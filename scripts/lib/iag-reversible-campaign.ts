import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { z } from 'zod';

const exceptionSchema = z.object({
  kind: z.enum(['URL_DOMAIN_EXCEPTION_PRESENT', 'APPLICATION_EXCEPTION_PRESENT']),
  value: z.string().optional(),
  applicationId: z.string().optional(),
  effect: z.literal('ALLOW'),
}).strict();
const policySchema = z.object({
  status: z.enum(['READY', 'MISSING', 'UNREADY']),
  scope: z.object({
    origin: z.string(), deviceIdentityDigest: z.string(), policyTaskId: z.string(),
    firmwareTruthDigest: z.string(),
    implementation: z.object({ recipeDigest: z.string(), toolDigest: z.string(), runtimeDigest: z.string() }).strict(),
  }).strict(),
  entries: z.array(exceptionSchema),
}).strict();

export type MockIagCampaignCycle = {
  readonly cycleId: string;
  readonly deviceIdentityDigest: string;
  readonly windowIdentityDigest: string;
  readonly beforeReadBack: 'pass';
  readonly applyReadBack: 'pass';
  readonly restoreReadBack: 'pass';
  readonly mutationCount: 2;
  readonly retryCount: 0;
  readonly collateralMutationCount: 0;
};

export type MockIagCampaignReport = {
  readonly evidenceClass: 'mock';
  readonly maturity: 'tested_mock';
  readonly promotionEligible: false;
  readonly cycleCount: 3;
  readonly deviceCount: 2;
  readonly windowCount: 2;
  readonly readBackCount: 9;
  readonly readBackPassCount: 9;
  readonly restoredCount: 3;
  readonly mutationCount: 6;
  readonly retryCount: 0;
  readonly collateralMutationCount: 0;
  readonly cycles: readonly MockIagCampaignCycle[];
};

type CampaignInput = {
  readonly baseUrl: string;
  readonly exception: string;
  readonly restore: boolean;
};

export class IagMockCampaignError extends Error {
  readonly name = 'IagMockCampaignError';
  constructor(readonly code: string, options?: ErrorOptions) { super(code, options); }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertLoopback(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch (error) {
    throw new IagMockCampaignError('IAG_MOCK_BASE_URL_INVALID', { cause: error });
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new IagMockCampaignError('IAG_MOCK_LOOPBACK_REQUIRED');
  }
  return url;
}

function httpJson(url: URL, method: 'GET' | 'PUT' | 'DELETE', body?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      signal: AbortSignal.timeout(5_000),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new IagMockCampaignError('IAG_MOCK_HTTP_REFUSED'));
          return;
        }
        const source = Buffer.concat(chunks).toString('utf8');
        if (source.length === 0) { resolve(null); return; }
        try { resolve(JSON.parse(source)); } catch (error) {
          reject(new IagMockCampaignError('IAG_MOCK_RESPONSE_INVALID', { cause: error }));
        }
      });
    });
    outgoing.on('error', (error) => reject(new IagMockCampaignError('IAG_MOCK_REQUEST_FAILED', { cause: error })));
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

function hasException(policy: z.infer<typeof policySchema>, exception: string): boolean {
  return policy.entries.some((entry) => entry.kind === 'URL_DOMAIN_EXCEPTION_PRESENT' && entry.value === exception);
}

async function readPolicy(url: URL): Promise<z.infer<typeof policySchema>> {
  const parsed = policySchema.safeParse(await httpJson(new URL('/api/v1/iag/internet-policy', url), 'GET'));
  if (!parsed.success || parsed.data.status !== 'READY') throw new IagMockCampaignError('IAG_MOCK_READ_BACK_INDETERMINATE');
  return parsed.data;
}

async function runCycle(input: {
  readonly url: URL;
  readonly exception: string;
  readonly cycleId: string;
  readonly deviceIdentityDigest: string;
  readonly windowIdentityDigest: string;
}): Promise<MockIagCampaignCycle> {
  const mutationUrl = new URL('/api/v1/iag/internet-policy/exception', input.url);
  const body = JSON.stringify({ kind: 'URL_DOMAIN_EXCEPTION', value: input.exception, effect: 'ALLOW' });
  if (hasException(await readPolicy(input.url), input.exception)) throw new IagMockCampaignError('IAG_MOCK_PREEXISTING_EXCEPTION');
  await httpJson(mutationUrl, 'PUT', body);
  if (!hasException(await readPolicy(input.url), input.exception)) throw new IagMockCampaignError('IAG_MOCK_APPLY_READ_BACK_FAILED');
  await httpJson(mutationUrl, 'DELETE', body);
  if (hasException(await readPolicy(input.url), input.exception)) throw new IagMockCampaignError('IAG_MOCK_RESTORE_READ_BACK_FAILED');
  return {
    cycleId: input.cycleId, deviceIdentityDigest: input.deviceIdentityDigest,
    windowIdentityDigest: input.windowIdentityDigest, beforeReadBack: 'pass',
    applyReadBack: 'pass', restoreReadBack: 'pass', mutationCount: 2,
    retryCount: 0, collateralMutationCount: 0,
  };
}

export async function runMockIagCampaign(input: CampaignInput): Promise<MockIagCampaignReport> {
  const url = assertLoopback(input.baseUrl);
  if (!input.restore) throw new IagMockCampaignError('IAG_MOCK_EXPLICIT_RESTORE_REQUIRED');
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(input.exception)) throw new IagMockCampaignError('IAG_MOCK_EXCEPTION_INVALID');
  const deviceDigests = [digest('mock-iag-device-a'), digest('mock-iag-device-b')] as const;
  const windowDigests = [digest('mock-window-a'), digest('mock-window-b')] as const;
  const identities = [
    [deviceDigests[0], windowDigests[0]], [deviceDigests[1], windowDigests[1]], [deviceDigests[0], windowDigests[1]],
  ] as const;
  const cycles: MockIagCampaignCycle[] = [];
  for (const [index, identity] of identities.entries()) {
    cycles.push(await runCycle({
      url, exception: input.exception, cycleId: `mock-cycle-${index + 1}`,
      deviceIdentityDigest: identity[0], windowIdentityDigest: identity[1],
    }));
  }
  return {
    evidenceClass: 'mock', maturity: 'tested_mock', promotionEligible: false,
    cycleCount: 3, deviceCount: 2, windowCount: 2, readBackCount: 9,
    readBackPassCount: 9, restoredCount: 3, mutationCount: 6,
    retryCount: 0, collateralMutationCount: 0, cycles,
  };
}
