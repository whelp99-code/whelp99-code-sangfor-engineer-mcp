import http from 'node:http';
import { PRODUCTS } from '../../../packages/shared/src/index.js';

const port = Number(process.env.PORT ?? 3500);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sangfor Operator Console</title><style>body{font-family:Arial;padding:32px}pre{background:#f3f3f3;padding:16px;border-radius:8px}</style></head><body><h1>Sangfor Operator Console MVP</h1><p>This is a minimal placeholder UI. Use MCP tools for actual MVP flow.</p><h2>Product Priority</h2><pre>${JSON.stringify(PRODUCTS, null, 2)}</pre><h2>Pages to implement next</h2><ul><li>/manuals</li><li>/projects</li><li>/plans</li><li>/sessions</li><li>/feedback</li><li>/wiki-review</li></ul></body></html>`;
http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); }).listen(port, () => console.log(`Operator Console listening on http://localhost:${port}`));
