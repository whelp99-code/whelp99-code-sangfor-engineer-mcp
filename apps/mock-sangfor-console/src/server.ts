import http from 'node:http';

const port = Number(process.env.PORT ?? 3400);

function page(product: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Sangfor ${product} Console</title>
<style>body{font-family:Arial;margin:0;background:#f6f8fb}.layout{display:flex}.side{width:240px;background:#10243e;color:white;height:100vh;padding:24px}.main{padding:32px;flex:1}.card{background:white;border:1px solid #ddd;border-radius:12px;padding:20px;margin-bottom:16px}button{padding:10px 16px;margin:4px;border-radius:8px;border:1px solid #777}.danger{background:#ffe8e8}.ok{background:#e9fff0}</style></head>
<body><div class="layout"><aside class="side"><h2>Sangfor ${product}</h2><nav><p>Dashboard</p><p>Network</p><p>Policy</p><p>Reports</p></nav></aside><main class="main"><h1>Mock ${product} Console</h1><div class="card"><h3>Status</h3><p class="ok">This is a mock console. No real device is connected.</p></div><div class="card"><h3>Configuration Draft</h3><label>Cluster/Policy Name <input aria-label="config-name" value="demo-${product.toLowerCase()}" /></label><br/><button>Export</button><button class="danger">Save</button><button class="danger">Apply</button></div></main></div></body></html>`;
}

const server = http.createServer((req, res) => {
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

server.listen(port, () => console.log(`Mock Sangfor Console listening on http://localhost:${port}`));
