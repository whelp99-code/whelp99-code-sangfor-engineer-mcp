import {
  extractOfficialJanusHostExtrasFromPages,
  janusExtrasLiveCollectRefusal,
  OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
  SCP_JANUS_EXTRAS_COLLECT_STATUS,
  type HciInventoryOriginalPresentSurface,
} from './collect-extras.js';

/**
 * Child adapter for official SCP Janus hosts extras.
 *
 * This is not Keystone and is not added to `HciServiceType`. It does not
 * implement `/janus/v2/public-key` or `/janus/v2/login`. Production
 * `collectInventory` omits the capture grant, so it never GETs Janus.
 * A future authorized read may pass an explicit grant with an injected
 * client (test double or a later captured session).
 */
export const JANUS_HOSTS_PATH = '/janus/20180725/hosts' as const;

export type JanusHostsCaptureRequest = {
  readonly method: 'GET';
  readonly endpoint: typeof OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT;
  readonly path: typeof JANUS_HOSTS_PATH;
};

export type JanusHostsCaptureClient = {
  getOfficialHosts(request: JanusHostsCaptureRequest): Promise<{
    readonly status: number;
    readonly json: unknown;
    readonly latencyMs?: number;
  }>;
};

/** Code-level grant. Not an env flag and not `SANGFOR_ALLOW_REAL_EXECUTION`. */
export type JanusHostsCaptureGrant = {
  readonly kind: 'explicit_janus_hosts_capture';
  readonly client: JanusHostsCaptureClient;
};

export type JanusHostsCollectReport =
  | {
      readonly status: typeof SCP_JANUS_EXTRAS_COLLECT_STATUS;
      readonly getCount: 0;
      readonly reason: 'JANUS_CAPTURE_GATED';
      readonly endpoint: typeof OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT;
    }
  | {
      readonly status: 'captured';
      readonly getCount: number;
      readonly endpoint: typeof OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT;
    };

const CAPTURE_REQUEST: JanusHostsCaptureRequest = {
  method: 'GET',
  endpoint: OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
  path: JANUS_HOSTS_PATH,
};

export function isJanusHostsCaptureGrant(value: unknown): value is JanusHostsCaptureGrant {
  if (typeof value !== 'object' || value === null) return false;
  const grant = value as Partial<JanusHostsCaptureGrant>;
  return grant.kind === 'explicit_janus_hosts_capture'
    && typeof grant.client?.getOfficialHosts === 'function';
}

export function janusHostsCollectRefusal(): Extract<JanusHostsCollectReport, { status: 'capture_gated' }> {
  return { ...janusExtrasLiveCollectRefusal(), getCount: 0 };
}

/**
 * GET official hosts only when an explicit capture grant is present.
 * Missing/invalid grant → capture_gated, getCount 0, no client call.
 * `hosts.length !== 1` stays empty extras (no cluster sum).
 */
export async function collectOfficialJanusHostExtras(input: {
  readonly grant?: unknown;
  readonly collectedAt: string;
}): Promise<{
  readonly extras: readonly HciInventoryOriginalPresentSurface[];
  readonly report: JanusHostsCollectReport;
}> {
  if (!isJanusHostsCaptureGrant(input.grant)) {
    return { extras: [], report: janusHostsCollectRefusal() };
  }

  const result = await input.grant.client.getOfficialHosts(CAPTURE_REQUEST);
  const extras = result.status === 200
    ? extractOfficialJanusHostExtrasFromPages([{
        endpoint: OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
        payload: result.json,
        latencyMs: typeof result.latencyMs === 'number' && result.latencyMs > 0 ? result.latencyMs : 0,
        collectedAt: input.collectedAt,
      }])
    : [];

  return {
    extras,
    report: {
      status: 'captured',
      getCount: 1,
      endpoint: OFFICIAL_SCP_JANUS_HOSTS_ENDPOINT,
    },
  };
}
