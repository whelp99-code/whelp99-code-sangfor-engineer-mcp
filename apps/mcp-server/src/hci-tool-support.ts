import { HciClient, KeystoneV2TokenProvider } from '../../../packages/sangfor-hci-client/src/index.js';
export function hciConnection(args: Record<string, unknown> = {}) {
  const identityBaseUrl = String(args.identityBaseUrl ?? process.env.SANGFOR_HCI_IDENTITY_URL ?? 'http://127.0.0.1:3400/openstack/identity/v2.0');
  return {
    identityBaseUrl,
    tenantName: String(args.tenantName ?? process.env.SANGFOR_HCI_TENANT ?? 'lab'),
    username: String(args.username ?? process.env.SANGFOR_HCI_USER ?? 'admin'),
    password: String(args.password ?? process.env.SANGFOR_HCI_PASSWORD ?? 'mock-password'),
    tlsSkipVerify: true,
    host: new URL(identityBaseUrl).hostname,
  };
}

export function hciClientFor(args: Record<string, unknown> = {}) {
  const cfg = hciConnection(args);
  return { client: new HciClient(new KeystoneV2TokenProvider(cfg), { tlsSkipVerify: cfg.tlsSkipVerify }), cfg };
}

export function hciAuthorityReferences() {
  const manifestPath = process.env.SANGFOR_CAPABILITY_EVIDENCE_MANIFEST;
  const validationContextPath = process.env.SANGFOR_CAPABILITY_EVIDENCE_CONTEXT;
  const evidenceRoot = process.env.SANGFOR_CAPABILITY_EVIDENCE_ROOT;
  const ledgerPath = process.env.SANGFOR_CAPABILITY_PROMOTION_LEDGER_PATH;
  if (!manifestPath || !validationContextPath || !evidenceRoot || !ledgerPath) return undefined;
  return { manifestPath, validationContextPath, evidenceRoot, ledgerPath };
}
