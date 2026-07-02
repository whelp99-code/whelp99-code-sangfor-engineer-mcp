import { httpJson } from './http.js';

// Keystone v2.0 password auth exactly as documented in the official HCI OpenAPI
// guide (auth.tenantName + passwordCredentials -> access.token + serviceCatalog).
// This is a DOC CONTRACT: it has not been verified against a real device yet.
// M4 captures the real handshake and either confirms this or forces a fix.
export const HCI_AUTH_CONTRACT_STATUS = 'doc_contract_unverified_on_real_device';

export interface HciConnectionConfig {
  identityBaseUrl: string;   // e.g. https://{acmp_ip}/openstack/identity/v2.0
  tenantName: string;
  username: string;
  password: string;
  tlsSkipVerify?: boolean;
}

export interface ServiceCatalogEntry { type: string; name: string; publicURL: string; }
export interface TokenState { tokenId: string; tenantId: string; expiresAt: string; serviceCatalog: ServiceCatalogEntry[]; }
export interface TokenProvider { getToken(force?: boolean): Promise<TokenState>; }

const REFRESH_MARGIN_MS = 60_000;

export class KeystoneV2TokenProvider implements TokenProvider {
  private cached: TokenState | null = null;
  constructor(private readonly config: HciConnectionConfig) {}

  async getToken(force = false): Promise<TokenState> {
    if (!force && this.cached) {
      const remaining = new Date(this.cached.expiresAt).getTime() - Date.now();
      if (Number.isFinite(remaining) && remaining > REFRESH_MARGIN_MS) return this.cached;
    }
    const res = await httpJson(`${this.config.identityBaseUrl.replace(/\/$/, '')}/tokens`, {
      method: 'POST',
      tlsSkipVerify: this.config.tlsSkipVerify,
      body: { auth: { tenantName: this.config.tenantName, passwordCredentials: { username: this.config.username, password: this.config.password } } },
    });
    if (res.status !== 200) throw new Error(`Keystone auth failed: HTTP ${res.status}`);
    const access = (res.json as { access?: any })?.access;
    const tokenId = access?.token?.id;
    const tenantId = access?.token?.tenant?.id;
    if (typeof tokenId !== 'string' || typeof tenantId !== 'string') {
      throw new Error('Keystone auth response missing token/tenant id (refusing to guess).');
    }
    const serviceCatalog: ServiceCatalogEntry[] = Array.isArray(access?.serviceCatalog)
      ? access.serviceCatalog.flatMap((s: any) =>
          Array.isArray(s?.endpoints) && typeof s.endpoints[0]?.publicURL === 'string'
            ? [{ type: String(s.type), name: String(s.name), publicURL: String(s.endpoints[0].publicURL) }]
            : [])
      : [];
    this.cached = { tokenId, tenantId, expiresAt: String(access?.token?.expires ?? ''), serviceCatalog };
    return this.cached;
  }
}
