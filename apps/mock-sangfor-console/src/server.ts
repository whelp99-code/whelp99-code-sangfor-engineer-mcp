import http from 'node:http';
import { createOpenStackMock } from './openstack.js';
import { fortiOSPolicyHandler, fortiOSInterfaceHandler, fortiOSSystemStatsHandler, fortiOSNPUStatsHandler, fortiOSHASettingHandler, fortiOSIPSStatsHandler } from './fortios.js';
import { ciscoInterfaceHandler, ciscoRoutingHandler, ciscoSystemStatsHandler, ciscoZonePolicyHandler, ciscoSNORTStatusHandler } from './cisco-iosxe.js';
import { VENDOR_PATH_RESPONSES } from './vendor-paths.js';

const port = Number(process.env.PORT ?? 3400);

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function page(product: string, configurationName: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Sangfor ${product} Console</title>
<style>body{font-family:Arial;margin:0;background:#f6f8fb}.layout{display:flex}.side{width:240px;background:#10243e;color:white;height:100vh;padding:24px}.side a{display:block;color:white;padding:4px 0}.main{padding:32px;flex:1}.card{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin-bottom:16px}button{padding:10px 16px;margin:4px;border-radius:8px;border:1px solid #777}.danger{background:#ffe8e8}.ok{background:#e9fff0}</style></head>
<body><div class="layout"><aside class="side"><h2>Sangfor ${product}</h2><nav><a href="#dashboard">Dashboard</a><a href="#network">Network</a><a href="#policy">Policy</a><a href="#reports">Reports</a></nav></aside><main class="main"><h1>Mock ${product} Console</h1><div class="card"><h3>Status</h3><p id="save-status" class="ok">This is a mock console. No real device is connected.</p></div><div class="card"><h3>Configuration Draft</h3><label>Cluster/Policy Name <input id="config-name" aria-label="config-name" value="${escapeHtmlAttribute(configurationName)}" /></label><br/><button>Export</button><button class="danger">Save</button><button id="apply-config" class="danger">Apply</button></div></main></div>
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
</script></body></html>`;
}

export function createMockConsoleServer(): http.Server {
  const openstack = createOpenStackMock(port);
  let configurationName = 'demo-hci';
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
    res.end(page(product, configurationName));
  });
}

// Auto-start only when run as a process (not when imported by tests).
if (process.env.MOCK_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  createMockConsoleServer().listen(port, () => console.log(`Mock Sangfor Console listening on http://localhost:${port}`));
}
