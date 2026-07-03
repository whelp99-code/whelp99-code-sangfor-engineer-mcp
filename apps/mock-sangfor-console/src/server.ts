import http from 'node:http';
import { createOpenStackMock } from './openstack.js';
import { fortiOSPolicyHandler, fortiOSInterfaceHandler, fortiOSSystemStatsHandler, fortiOSNPUStatsHandler, fortiOSHASettingHandler, fortiOSIPSStatsHandler } from './fortios.js';
import { ciscoInterfaceHandler, ciscoRoutingHandler } from './cisco-iosxe.js';

const port = Number(process.env.PORT ?? 3400);

function page(product: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Sangfor ${product} Console</title>
<style>body{font-family:Arial;margin:0;background:#f6f8fb}.layout{display:flex}.side{width:240px;background:#10243e;color:white;height:100vh;padding:24px}.main{padding:32px;flex:1}.card{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin-bottom:16px}button{padding:10px 16px;margin:4px;border-radius:8px;border:1px solid #777}.danger{background:#ffe8e8}.ok{background:#e9fff0}</style></head>
<body><div class="layout"><aside class="side"><h2>Sangfor ${product}</h2><nav><p>Dashboard</p><p>Network</p><p>Policy</p><p>Reports</p></nav></aside><main class="main"><h1>Mock ${product} Console</h1><div class="card"><h3>Status</h3><p class="ok">This is a mock console. No real device is connected.</p></div><div class="card"><h3>Configuration Draft</h3><label>Cluster/Policy Name <input aria-label="config-name" value="demo-${product.toLowerCase()}" /></label><br/><button>Export</button><button class="danger">Save</button><button class="danger">Apply</button></div></main></div></body></html>`;
}

export function createMockConsoleServer(): http.Server {
  const openstack = createOpenStackMock(port);
  return http.createServer(async (req, res) => {
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
    res.end(page(product));
  });
}

// Auto-start only when run as a process (not when imported by tests).
if (process.env.MOCK_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  createMockConsoleServer().listen(port, () => console.log(`Mock Sangfor Console listening on http://localhost:${port}`));
}
