/** Read-only HCI/SCP OpenAPI smoke against a real device. Credentials come from
 *  env only (never hard-coded / committed). Proves the client + inventory + health
 *  chain works on a live aCMP/SCP. Usage:
 *    SANGFOR_HCI_IDENTITY_URL=https://{scp_ip}:{port}/openstack/identity/v2.0 \
 *    SANGFOR_HCI_TENANT=admin SANGFOR_HCI_USER=admin SANGFOR_HCI_PASSWORD=*** \
 *    pnpm exec tsx scripts/hci-real-smoke.ts
 */
import { HciClient, KeystoneV2TokenProvider, collectInventory, summarizeHciHealth, renderHciHealthReport } from '../packages/sangfor-hci-client/src/index.js';

const identityBaseUrl = process.env.SANGFOR_HCI_IDENTITY_URL;
const username = process.env.SANGFOR_HCI_USER;
const password = process.env.SANGFOR_HCI_PASSWORD;
if (!identityBaseUrl || !username || !password) {
  console.error('Set SANGFOR_HCI_IDENTITY_URL, SANGFOR_HCI_USER, SANGFOR_HCI_PASSWORD (read-only smoke).');
  process.exit(1);
}

const client = new HciClient(
  new KeystoneV2TokenProvider({
    identityBaseUrl,
    tenantName: process.env.SANGFOR_HCI_TENANT ?? 'admin',
    username,
    password,
    tlsSkipVerify: true,
  }),
  { tlsSkipVerify: true },
);

const inv = await collectInventory(client);
console.log(`servers=${inv.servers.length} images=${inv.images.length} volumes=${inv.volumes.length} volumeServiceAvailable=${inv.volumeServiceAvailable}`);
const summary = summarizeHciHealth(inv);
console.log(renderHciHealthReport(summary, { host: new URL(identityBaseUrl).host, collectedAt: new Date().toISOString() }));
