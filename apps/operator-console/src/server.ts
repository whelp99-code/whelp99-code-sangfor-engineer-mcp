import http from 'node:http';
import { URL } from 'node:url';
import { ZodError } from 'zod';
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { PRODUCTS, resolveBindHost, checkAuth, assertBindSafety } from '../../../packages/shared/src/index.js';
import {
  MAX_REQUEST_BODY_BYTES,
  RequestBodyTooLargeError,
  readCappedRequestBody,
} from '../../../packages/shared/src/runtime-body-cap.js';
import { RuntimeSchemaError } from '../../../packages/shared/src/runtime-schema.js';
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
  getEmbeddingHealth,
  getFieldEngineerCoverage,
  getSpecCoverage,
  getDiagnoses
} from './api.js';
import { postCaseResolution } from './case-resolution.js';
import { dashboardHtml } from './ui.js';
import {
  decodeOperatorRequestBody,
  parseBoundaryOperatorRequestBodyV1,
  type OperatorRequestBody,
  type OperatorRequestRoute,
} from './runtime-boundaries.js';

loadEnvFile('.env');

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

async function readJsonBody<TRoute extends OperatorRequestRoute>(
  req: http.IncomingMessage,
  route: TRoute,
): Promise<OperatorRequestBody<TRoute>> {
  const raw = await readCappedRequestBody(req, MAX_REQUEST_BODY_BYTES);
  const body = parseBoundaryOperatorRequestBodyV1(raw.trim() ? raw : '{}');
  return decodeOperatorRequestBody(body, route);
}

export function createOperatorServer(): http.Server {
  const apiToken = process.env.SANGFOR_API_TOKEN;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    // Shared-secret gate for API routes (no-op when SANGFOR_API_TOKEN is unset).
    if (url.pathname.startsWith('/api/')) {
      const auth = checkAuth(req.headers['authorization'], apiToken);
      if (!auth.ok) return error(res, 'unauthorized', auth.status ?? 401);
    }

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

      if (method === 'GET' && url.pathname === '/api/coverage') {
        return json(res, await getFieldEngineerCoverage());
      }

      if (method === 'GET' && url.pathname === '/api/spec-coverage') {
        return json(res, getSpecCoverage());
      }

      if (method === 'GET' && url.pathname === '/api/diagnoses') {
        return json(res, getDiagnoses());
      }

      if (method === 'GET' && url.pathname === '/api/health/store') {
        return json(res, await getStoreHealth());
      }

      if (method === 'GET' && url.pathname === '/api/health/embeddings') {
        return json(res, await getEmbeddingHealth());
      }

      if (method === 'POST' && url.pathname === '/api/analyze-project') {
        const body = await readJsonBody(req, 'analyze-project');
        return json(res, await postAnalyzeProject(body));
      }

      if (method === 'POST' && url.pathname === '/api/generate-config-plan') {
        const body = await readJsonBody(req, 'generate-config-plan');
        return json(res, await postGenerateConfigPlan(body));
      }

      if (method === 'POST' && url.pathname === '/api/rag-search') {
        const body = await readJsonBody(req, 'rag-search');
        if (!body.query.trim()) return error(res, 'query is required');
        return json(res, await postRagSearch(body));
      }

      if (method === 'POST' && url.pathname === '/api/case-resolution') {
        const body = await readJsonBody(req, 'case-resolution');
        return json(res, await postCaseResolution(body));
      }

      if (method === 'POST' && url.pathname === '/api/discover-console') {
        const body = await readJsonBody(req, 'discover-console');
        return json(res, await postDiscoverConsole(body));
      }

      if (method === 'POST' && url.pathname === '/api/analyze-requirements') {
        const body = await readJsonBody(req, 'analyze-requirements');
        return json(res, await postAnalyzeRequirements(body));
      }

      if (method === 'POST' && url.pathname === '/api/import-excel') {
        const body = await readJsonBody(req, 'import-excel');
        return json(res, await postImportExcel(body));
      }

      if (method === 'POST' && url.pathname === '/api/feedback') {
        const body = await readJsonBody(req, 'feedback');
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
      if (err instanceof RequestBodyTooLargeError) {
        error(res, 'request body too large', 413);
        return;
      }
      if (err instanceof ZodError || (err instanceof RuntimeSchemaError && err.policy === 'deny')) {
        error(res, 'invalid JSON request body', 400);
        return;
      }
      error(res, err instanceof Error ? err.message : String(err), 500);
    }
  });
}

if (process.env.MCP_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  const port = Number(process.env.PORT ?? process.env.OPERATOR_CONSOLE_PORT ?? 3502);
  const bindHost = resolveBindHost();
  const apiToken = process.env.SANGFOR_API_TOKEN;
  assertBindSafety(bindHost, apiToken); // fail closed: no public bind without a token
  createOperatorServer().listen(port, bindHost, () => {
    console.log(`Sangfor Engineer Web listening on http://${bindHost}:${port}${apiToken ? ' (token-gated)' : ''}`);
    console.log('MCP stdio server: pnpm run dev:mcp (unchanged for Cursor)');
  });
}
