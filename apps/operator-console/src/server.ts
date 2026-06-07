import http from 'node:http';
import { URL } from 'node:url';
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { PRODUCTS } from '../../../packages/shared/src/index.js';
import {
  getSummary,
  getKnowledge,
  postAnalyzeProject,
  postGenerateConfigPlan,
  postRagSearch,
  postDiscoverConsole,
  postAnalyzeRequirements,
  postImportExcel,
  postFeedback,
  getStoreHealth,
  getEmbeddingHealth
} from './api.js';
import { dashboardHtml } from './ui.js';

loadEnvFile('.env');

const port = Number(process.env.PORT ?? process.env.OPERATOR_CONSOLE_PORT ?? 3500);

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && url.pathname === '/api/summary') {
      return json(res, getSummary());
    }

    if (method === 'GET' && url.pathname === '/api/products') {
      return json(res, { products: PRODUCTS });
    }

    if (method === 'GET' && url.pathname === '/api/knowledge') {
      const product = url.searchParams.get('product') ?? 'HCI';
      const type = url.searchParams.get('type') ?? 'manual';
      return json(res, getKnowledge(product, type));
    }

    if (method === 'GET' && url.pathname === '/api/health/store') {
      return json(res, await getStoreHealth());
    }

    if (method === 'GET' && url.pathname === '/api/health/embeddings') {
      return json(res, await getEmbeddingHealth());
    }

    if (method === 'POST' && url.pathname === '/api/analyze-project') {
      const body = await readJsonBody(req);
      if (!body.customerName) return error(res, 'customerName is required');
      return json(res, await postAnalyzeProject(body));
    }

    if (method === 'POST' && url.pathname === '/api/generate-config-plan') {
      const body = await readJsonBody(req);
      if (!body.customerName || !body.product) return error(res, 'customerName and product are required');
      return json(res, await postGenerateConfigPlan(body));
    }

    if (method === 'POST' && url.pathname === '/api/rag-search') {
      const body = await readJsonBody(req);
      return json(res, await postRagSearch(body as Parameters<typeof postRagSearch>[0]));
    }

    if (method === 'POST' && url.pathname === '/api/discover-console') {
      const body = await readJsonBody(req);
      return json(res, await postDiscoverConsole(body));
    }

    if (method === 'POST' && url.pathname === '/api/analyze-requirements') {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.requirements) || body.requirements.length === 0) {
        return error(res, 'requirements array is required');
      }
      return json(res, await postAnalyzeRequirements(body));
    }

    if (method === 'POST' && url.pathname === '/api/import-excel') {
      const body = await readJsonBody(req);
      return json(res, await postImportExcel(body as Parameters<typeof postImportExcel>[0]));
    }

    if (method === 'POST' && url.pathname === '/api/feedback') {
      const body = await readJsonBody(req);
      if (!body.product || !body.feedbackText) return error(res, 'product and feedbackText are required');
      return json(res, await postFeedback(body));
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml());
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    error(res, err instanceof Error ? err.message : String(err), 500);
  }
});

server.listen(port, () => {
  console.log(`Sangfor Engineer Web listening on http://localhost:${port}`);
  console.log('MCP stdio server: pnpm run dev:mcp (unchanged for Cursor)');
});
