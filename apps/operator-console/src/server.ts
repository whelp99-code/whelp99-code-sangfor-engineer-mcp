import http from 'node:http';
import { URL } from 'node:url';
import { PRODUCTS } from '../../../packages/shared/src/index.js';
import { listSeedManuals, searchManuals } from '../../../packages/sangfor-knowledge/src/index.js';
import { listSeedWiki, searchWiki } from '../../../packages/sangfor-wiki/src/index.js';
import { exportRagIndexSummary } from '../../../packages/sangfor-rag/src/index.js';

const port = Number(process.env.PORT ?? 3500);
const RAG_INDEX = 'data/rag/index.json';

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sangfor Engineer Operator Console</title>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --accent:#38bdf8; --text:#e2e8f0; --muted:#94a3b8; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:Segoe UI,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:20px 28px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center; }
    h1 { margin:0; font-size:1.35rem; }
    .badge { background:#0369a1; padding:4px 10px; border-radius:999px; font-size:.75rem; }
    main { display:grid; grid-template-columns:220px 1fr; min-height:calc(100vh - 64px); }
    nav { padding:20px; border-right:1px solid #334155; }
    nav button { display:block; width:100%; text-align:left; margin:6px 0; padding:10px 12px; border:1px solid #334155; border-radius:8px; background:var(--card); color:var(--text); cursor:pointer; }
    nav button.active { border-color:var(--accent); background:#0c4a6e; }
    section { padding:24px 28px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
    .card { background:var(--card); border:1px solid #334155; border-radius:12px; padding:16px; }
    .card h3 { margin:0 0 8px; font-size:1rem; color:var(--accent); }
    .meta { color:var(--muted); font-size:.85rem; margin-bottom:8px; }
    .snippet { font-size:.9rem; line-height:1.45; max-height:4.5em; overflow:hidden; }
    .stats { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
    .stat { background:var(--card); border:1px solid #334155; border-radius:10px; padding:12px 18px; min-width:120px; }
    .stat strong { display:block; font-size:1.5rem; color:var(--accent); }
    a.link { color:var(--accent); }
    iframe { width:100%; height:420px; border:1px solid #334155; border-radius:12px; background:#fff; }
  </style>
</head>
<body>
  <header>
    <h1>Sangfor Engineer Operator Console</h1>
    <span class="badge">MVP Demo</span>
  </header>
  <main>
    <nav id="nav"></nav>
    <section>
      <div class="stats" id="stats"></div>
      <p class="meta">Mock console: <a class="link" href="http://localhost:3400" target="_blank">http://localhost:3400</a></p>
      <div id="mock-frame-wrap" style="margin-bottom:20px">
        <iframe src="http://localhost:3400" title="Mock Sangfor HCI Console"></iframe>
      </div>
      <h2 id="panel-title">Knowledge</h2>
      <div class="grid" id="content"></div>
    </section>
  </main>
  <script>
    const products = ${JSON.stringify(PRODUCTS.map(p => p.code))};
    let current = 'HCI';
    const nav = document.getElementById('nav');
    const content = document.getElementById('content');
    const stats = document.getElementById('stats');
    const panelTitle = document.getElementById('panel-title');

    products.forEach(p => {
      const b = document.createElement('button');
      b.textContent = p;
      b.onclick = () => { current = p; render(); };
      b.dataset.product = p;
      nav.appendChild(b);
    });

    async function loadSummary() {
      const r = await fetch('/api/summary');
      return r.json();
    }

    async function loadKnowledge(type) {
      const r = await fetch('/api/knowledge?product=' + current + '&type=' + type);
      return r.json();
    }

    async function render() {
      nav.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.product === current));
      const summary = await loadSummary();
      stats.innerHTML = [
        ['Manuals', summary.manualCount],
        ['Wiki', summary.wikiCount],
        ['RAG chunks', summary.rag.chunkCount || 0]
      ].map(([l,v]) => '<div class="stat"><span>'+l+'</span><strong>'+v+'</strong></div>').join('');

      const [manuals, wiki] = await Promise.all([
        loadKnowledge('manual'),
        loadKnowledge('wiki')
      ]);
      panelTitle.textContent = current + ' — Manuals & Wiki';
      const items = [...manuals.items, ...wiki.items];
      content.innerHTML = items.map(c => (
        '<article class="card"><h3>'+c.title+'</h3>'+
        '<div class="meta">'+c.sourceType+' · '+c.product+(c.section?' · '+c.section:'')+'</div>'+
        '<p class="snippet">'+c.text+'</p></article>'
      )).join('') || '<p class="meta">No chunks for this product.</p>';
    }
    render();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);

  if (url.pathname === '/api/summary') {
    const rag = exportRagIndexSummary(RAG_INDEX);
    return json(res, {
      manualCount: listSeedManuals().length,
      wikiCount: listSeedWiki().length,
      rag,
      products: PRODUCTS
    });
  }

  if (url.pathname === '/api/knowledge') {
    const product = url.searchParams.get('product') ?? 'HCI';
    const type = url.searchParams.get('type') ?? 'manual';
    const items = type === 'wiki'
      ? searchWiki({ product, query: ' ', limit: 20 })
      : searchManuals({ product, query: ' ', limit: 20 });
    return json(res, { product, type, items });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(port, () => console.log(`Operator Console listening on http://localhost:${port}`));
