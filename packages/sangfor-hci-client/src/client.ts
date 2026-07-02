import { httpJson, type HttpJsonResult } from './http.js';
import type { TokenProvider } from './token-provider.js';

export type HciServiceType = 'identity' | 'volume' | 'compute' | 'image';

// The logical 'volume' service resolves to the real device's catalog type
// 'volumev2' (cinderv2), verified against the live SCP on 2026-07-02.
// 'volume' is kept as a fallback for older/other catalogs that use it verbatim.
function catalogTypesFor(serviceType: HciServiceType): string[] {
  return serviceType === 'volume' ? ['volumev2', 'volume'] : [serviceType];
}

export class HciClient {
  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly opts: { tlsSkipVerify?: boolean } = {},
  ) {}

  async endpointFor(serviceType: HciServiceType): Promise<string> {
    const token = await this.tokenProvider.getToken();
    const wanted = catalogTypesFor(serviceType);
    const entry = token.serviceCatalog.find((s) => wanted.includes(s.type));
    if (!entry) throw new Error(`service '${serviceType}' not present in the Keystone serviceCatalog (fail-closed).`);
    return entry.publicURL.replace(/\/$/, '');
  }

  async request(
    serviceType: HciServiceType,
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpJsonResult> {
    const doRequest = async (force: boolean): Promise<HttpJsonResult> => {
      const token = await this.tokenProvider.getToken(force);
      const wanted = catalogTypesFor(serviceType);
      const entry = token.serviceCatalog.find((s) => wanted.includes(s.type));
      if (!entry) throw new Error(`service '${serviceType}' not present in the Keystone serviceCatalog (fail-closed).`);
      return httpJson(`${entry.publicURL.replace(/\/$/, '')}${path}`, {
        method: init.method ?? 'GET',
        body: init.body,
        tlsSkipVerify: this.opts.tlsSkipVerify,
        headers: { 'x-auth-token': token.tokenId, ...init.headers },
      });
    };
    const first = await doRequest(false);
    if (first.status !== 401) return first;
    return doRequest(true); // exactly one forced re-auth on 401
  }
}
