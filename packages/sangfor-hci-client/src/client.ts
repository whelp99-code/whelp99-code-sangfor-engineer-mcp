import { httpJson, type HttpJsonResult } from './http.js';
import type { TokenProvider } from './token-provider.js';

export type HciServiceType = 'identity' | 'volume' | 'compute' | 'image';

export class HciClient {
  constructor(
    private readonly tokenProvider: TokenProvider,
    private readonly opts: { tlsSkipVerify?: boolean } = {},
  ) {}

  async endpointFor(serviceType: HciServiceType): Promise<string> {
    const token = await this.tokenProvider.getToken();
    const entry = token.serviceCatalog.find((s) => s.type === serviceType);
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
      const entry = token.serviceCatalog.find((s) => s.type === serviceType);
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
