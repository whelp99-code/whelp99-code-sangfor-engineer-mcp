import http, { type IncomingMessage } from 'node:http';
import { z } from 'zod';
import { createOpenStackMock } from './openstack.js';
import { fortiOSPolicyHandler, fortiOSInterfaceHandler, fortiOSSystemStatsHandler, fortiOSNPUStatsHandler, fortiOSHASettingHandler, fortiOSIPSStatsHandler } from './fortios.js';
import { ciscoInterfaceHandler, ciscoRoutingHandler, ciscoSystemStatsHandler, ciscoZonePolicyHandler, ciscoSNORTStatusHandler } from './cisco-iosxe.js';
import { VENDOR_PATH_RESPONSES } from './vendor-paths.js';

const port = Number(process.env.PORT ?? 3400);

const iagExceptionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('URL_DOMAIN_EXCEPTION'),
    value: z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u),
    effect: z.literal('ALLOW'),
  }).strict(),
  z.object({
    kind: z.literal('APPLICATION_EXCEPTION'),
    applicationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/u),
    effect: z.literal('ALLOW'),
  }).strict(),
]);
type IagException = z.infer<typeof iagExceptionSchema>;

export interface MockIagScope {
  readonly origin: string;
  readonly deviceIdentityDigest: string;
  readonly policyTaskId: string;
  readonly firmwareTruthDigest: string;
  readonly implementation: {
    readonly recipeDigest: string;
    readonly toolDigest: string;
    readonly runtimeDigest: string;
  };
}

export interface MockConsoleServerOptions {
  readonly iagInitialEntries?: readonly IagException[];
  readonly iagMutationMode?: 'persist' | 'silent-noop';
  readonly iagPolicyStatus?: 'READY' | 'MISSING' | 'UNREADY';
  readonly iagScope?: MockIagScope;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 8_192) throw new RangeError('MOCK_REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function page(product: string, configurationName: string, iagEntries: readonly IagException[]) {
  const iagList = iagEntries.map((entry) => {
    const value = entry.kind === 'URL_DOMAIN_EXCEPTION' ? entry.value : entry.applicationId;
    return `<li>${escapeHtmlAttribute(value)} — ALLOW</li>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Sangfor ${product} Console</title>
<style>body{font-family:Arial;margin:0;background:#f6f8fb}.layout{display:flex}.side{width:240px;background:#10243e;color:white;height:100vh;padding:24px}.side a{display:block;color:white;padding:4px 0}.main{padding:32px;flex:1}.card{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin-bottom:16px}button{padding:10px 16px;margin:4px;border-radius:8px;border:1px solid #777}.danger{background:#ffe8e8}.ok{background:#e9fff0}</style></head>
<body><div class="layout"><aside class="side"><h2>Sangfor ${product}</h2><nav><a href="#dashboard">Dashboard</a><a href="#network">Network</a><a href="#policy">Policy</a>${product === 'IAG' ? '<a href="#access-control">Access Control</a>' : ''}<a href="#reports">Reports</a></nav></aside><main class="main"><h1>Mock ${product} Console</h1><div class="card"><h3>Status</h3><p id="save-status" class="ok">This is a mock console. No real device is connected.</p></div><div class="card"><h3>Configuration Draft</h3><label>Cluster/Policy Name <input id="config-name" aria-label="config-name" value="${escapeHtmlAttribute(configurationName)}" /></label><br/><button>Export</button><button class="danger">Save</button><button id="apply-config" class="danger">Apply</button></div>${product === 'IAG' ? `<div class="card" id="access-control"><h3>Internet Policy Exceptions</h3><label>URL Domain Exception <input aria-label="URL Domain Exception" id="iag-url-exception" /></label><button id="add-iag-exception" class="danger">Add Exception</button><ul>${iagList}</ul></div>` : ''}</main></div>
<script>
document.getElementById('apply-config').addEventListener('click', async () => {
  const name = document.getElementById('config-name').value;
  const response = await fetch('/api/v1/mock-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  document.getElementById('save-status').textContent = response.ok ? 'Saved' : 'Save failed';
});
const addException = document.getElementById('add-iag-exception');
if (addException) addException.addEventListener('click', async () => {
  const value = document.getElementById('iag-url-exception').value;
  const response = await fetch('/api/v1/iag/internet-policy/exception', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'URL_DOMAIN_EXCEPTION', value, effect: 'ALLOW' }),
  });
  document.getElementById('save-status').textContent = response.ok ? 'Exception submitted' : 'Exception failed';
});
</script></body></html>`;
}

export function createMockConsoleServer(options: MockConsoleServerOptions = {}): http.Server {
  const openstack = createOpenStackMock(port);
  let configurationName = 'demo-hci';
  let iagEntries = [...(options.iagInitialEntries ?? [])];
  return http.createServer(async (req, res) => {
    if (req.url === '/api/v1/mock-config') {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: configurationName }));
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > 8_192) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(bytes);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
        const name = input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>).name
          : undefined;
        if (typeof name !== 'string' || name.length < 1 || name.length > 80 || /[<>"\u0000-\u001f]/u.test(name)) {
          res.writeHead(400).end();
          return;
        }
        configurationName = name;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: configurationName }));
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/api/v1/iag/internet-policy' && req.method === 'GET') {
      const zeroDigest = '0'.repeat(64);
      const scope = options.iagScope ?? {
        origin: `http://${req.headers.host ?? '127.0.0.1'}`,
        deviceIdentityDigest: zeroDigest,
        policyTaskId: 'task-mock-iag',
        firmwareTruthDigest: zeroDigest,
        implementation: { recipeDigest: zeroDigest, toolDigest: zeroDigest, runtimeDigest: zeroDigest },
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        status: options.iagPolicyStatus ?? 'READY',
        scope,
        entries: iagEntries.map((entry) => (
          entry.kind === 'URL_DOMAIN_EXCEPTION'
            ? { kind: 'URL_DOMAIN_EXCEPTION_PRESENT', value: entry.value, effect: entry.effect }
            : { kind: 'APPLICATION_EXCEPTION_PRESENT', applicationId: entry.applicationId, effect: entry.effect }
        )),
      }));
      return;
    }
    if (req.url === '/api/v1/iag/internet-policy/exception' && ['PUT', 'DELETE'].includes(req.method ?? '')) {
      try {
        const entry = iagExceptionSchema.parse(await readJsonBody(req));
        if (req.method === 'PUT' && options.iagMutationMode !== 'silent-noop') {
          const encoded = JSON.stringify(entry);
          if (!iagEntries.some((candidate) => JSON.stringify(candidate) === encoded)) iagEntries = [...iagEntries, entry];
        }
        if (req.method === 'DELETE') {
          const encoded = JSON.stringify(entry);
          iagEntries = iagEntries.filter((candidate) => JSON.stringify(candidate) !== encoded);
          res.writeHead(204).end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ accepted: true }));
      } catch (error) {
        res.writeHead(error instanceof RangeError ? 413 : 400).end();
      }
      return;
    }
    // Register FortiOS routes
    if (req.url?.startsWith('/api/v1/fortios/')) {
      if (req.url === '/api/v1/fortios/query-policy') {
        fortiOSPolicyHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/fortios/query-interface') {
        fortiOSInterfaceHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/fortios/query-system-stats') {
        fortiOSSystemStatsHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/fortios/query-npu-stats') {
        fortiOSNPUStatsHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/fortios/query-ha-setting') {
        fortiOSHASettingHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/fortios/query-ips-stats') {
        fortiOSIPSStatsHandler(req, res);
        return;
      }
    }
    // Register Cisco IOS-XE routes
    if (req.url?.startsWith('/api/v1/cisco-iosxe/')) {
      if (req.url === '/api/v1/cisco-iosxe/query-interfaces') {
        ciscoInterfaceHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/cisco-iosxe/query-routing') {
        ciscoRoutingHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/cisco-iosxe/query-system-stats') {
        ciscoSystemStatsHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/cisco-iosxe/query-zone-policy') {
        ciscoZonePolicyHandler(req, res);
        return;
      }
      if (req.url === '/api/v1/cisco-iosxe/query-snort-status') {
        ciscoSNORTStatusHandler(req, res);
        return;
      }
    }
    // Vendor-native advisor paths (additive aliases; existing routes unchanged)
    if (req.url && Object.prototype.hasOwnProperty.call(VENDOR_PATH_RESPONSES, req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(VENDOR_PATH_RESPONSES[req.url]));
      return;
    }
    if (await openstack.handle(req, res)) return;
    const url = req.url ?? '/';
    if (url === '/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, elements: ['Dashboard', 'Network', 'Policy', 'Export', 'Save', 'Apply'] }));
      return;
    }
    const product = url.includes('iag') ? 'IAG' : url.includes('endpoint') ? 'Endpoint Secure' : url.includes('cyber') ? 'Cyber Command' : 'HCI';
    res.setHeader('content-type', 'text/html');
    res.end(page(product, configurationName, iagEntries));
  });
}

// Auto-start only when run as a process (not when imported by tests).
if (process.env.MOCK_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  createMockConsoleServer().listen(port, () => console.log(`Mock Sangfor Console listening on http://localhost:${port}`));
}
