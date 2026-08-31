import http from 'node:http';
import { URL } from 'node:url';
import { ZodError } from 'zod';
import { checkAuth } from '../../../packages/shared/src/index.js';
import { RequestBodyTooLargeError } from '../../../packages/shared/src/runtime-body-cap.js';
import { RuntimeSchemaError } from '../../../packages/shared/src/runtime-schema.js';
import { createApi, ApiError, type TowerOptions } from './api.js';
import { loadEnvFile } from '../../../packages/sangfor-collector/src/load-env.js';
import { buildLoopStatus } from '../../../packages/sangfor-loop/src/index.js';
import type { AuthorityRuntimePort } from './authority-runtime.js';
import { routeAuthorityEnrollment } from './authority-enrollment-routes.js';
import { routeAuthorityRemoteJob } from './authority-remote-job-routes.js';
import {
  readJsonBody,
  refuseUnreadyAuthorityApi,
  routeProcessShell,
  sendJson as json,
} from './health-routes.js';
import { seedLegacyApi } from './legacy-seed.js';
import { startTowerProcess } from './tower-process.js';
import {
  parseAgentTaskStatusQuery,
  parseRunStatusQuery,
} from './request-boundaries.js';

loadEnvFile('.env');

export interface TowerServerOptions extends TowerOptions {
  apiToken?: string;
  seedOnStart?: boolean;   // 기동 시 기본 플레이북 시드 (멱등). 테스트는 기본 false.
  authorityRuntime?: AuthorityRuntimePort;
}

export function createTowerServer(opts: TowerServerOptions = {}): http.Server {
  const api = createApi(opts);
  const apiToken = opts.apiToken ?? process.env.SANGFOR_API_TOKEN;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    try {
      const authorityRoute = { method, path, response: res, authorityRuntime: opts.authorityRuntime };
      if (await routeProcessShell(authorityRoute)) return;
      if (path.startsWith('/api/')) {
        const auth = checkAuth(req.headers['authorization'], apiToken);
        if (!auth.ok) return json(res, { error: 'unauthorized' }, auth.status ?? 401);
      }
      if (await refuseUnreadyAuthorityApi(authorityRoute)) return;
      if (await routeAuthorityEnrollment({
        method, path, request: req, response: res,
        authorityRuntime: opts.authorityRuntime, apiToken,
      })) return;
      if (await routeAuthorityRemoteJob({
        method, path, request: req, response: res,
        authorityRuntime: opts.authorityRuntime,
      })) return;
      if (path.startsWith('/api/') && !api) return json(res, { error: 'BLRO authority API is not exposed' }, 404);
      if (!api) return json(res, { error: 'Not found' }, 404);
      if (method === 'GET' && path === '/api/overview') return json(res, await api.overview());
      if (method === 'GET' && path === '/api/tools') return json(res, await api.toolGroups());
      if (method === 'GET' && path === '/api/health') return json(res, await api.health());
      if (method === 'GET' && path === '/api/loop/status') {
        const tailRaw = Number(url.searchParams.get('tail') ?? '');
        return json(res, buildLoopStatus({ tail: Number.isInteger(tailRaw) && tailRaw > 0 ? tailRaw : undefined }));
      }
      if (method === 'GET' && path === '/api/devices') return json(res, api.listDevices());
      if (method === 'POST' && path === '/api/devices') {
        const b = await readJsonBody(req, 'device-create');
        return json(res, await api.createDevice({
          name: b.name ?? '',
          product: b.product ?? '',
          host: b.host ?? '',
          tags: b.tags ?? [],
          credentialEnv: b.credentialEnv,
        }));
      }
      const deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
      if (method === 'PUT' && deviceMatch) {
        const b = await readJsonBody(req, 'device-update');
        return json(res, await api.updateDevice(deviceMatch[1], b));
      }
      if (method === 'DELETE' && deviceMatch) return json(res, await api.deleteDevice(deviceMatch[1]));
      if (method === 'POST' && path === '/api/sweep') {
        const b = await readJsonBody(req, 'sweep');
        return json(res, await api.sweep(b));
      }
      if (method === 'POST' && path === '/api/approvals/mint') {
        const b = await readJsonBody(req, 'approval-mint');
        return json(res, api.mint(b));
      }
      if (method === 'POST' && path === '/api/runs') {
        const b = await readJsonBody(req, 'run-create');
        return json(res, await api.createRun({
          toolId: b.toolId ?? '',
          args: b.args ?? {},
          deviceId: b.deviceId,
        }));
      }
      if (method === 'GET' && path === '/api/runs') {
        const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v));
        return json(res, {
          runs: api.listRuns({
            status: parseRunStatusQuery(url.searchParams.get('status') ?? undefined),
            toolId: url.searchParams.get('toolId') ?? undefined,
            deviceId: url.searchParams.get('deviceId') ?? undefined,
            sweepId: url.searchParams.get('sweepId') ?? undefined,
            playbookRunId: url.searchParams.get('playbookRunId') ?? undefined,
            sinceDays: num(url.searchParams.get('sinceDays')),
            limit: num(url.searchParams.get('limit')),
          }),
        });
      }
      // ── 플레이북 라우트 (§5.4) ──
      if (method === 'GET' && path === '/api/playbooks') return json(res, api.listPlaybooks());
      if (method === 'POST' && path === '/api/playbooks/seed') {
        const b = await readJsonBody(req, 'playbook-seed');
        return json(res, await api.seedPlaybooks(b));
      }
      if (method === 'POST' && path === '/api/playbooks') {
        const b = await readJsonBody(req, 'playbook-create');
        return json(res, await api.createPlaybook({
          name: b.name ?? '', goal: b.goal ?? '', authoredBy: b.authoredBy ?? '',
          note: b.note,
          blocks: b.blocks ?? [],
        }));
      }
      const pbRevApprove = path.match(/^\/api\/playbooks\/([^/]+)\/revisions\/(\d+)\/approve$/);
      if (method === 'POST' && pbRevApprove) {
        const b = await readJsonBody(req, 'revision-review');
        return json(res, await api.reviewPlaybookRevision(pbRevApprove[1], Number(pbRevApprove[2]), { approve: true, reviewedBy: b.reviewedBy ?? '' }));
      }
      const pbRevReject = path.match(/^\/api\/playbooks\/([^/]+)\/revisions\/(\d+)\/reject$/);
      if (method === 'POST' && pbRevReject) {
        const b = await readJsonBody(req, 'revision-review');
        return json(res, await api.reviewPlaybookRevision(pbRevReject[1], Number(pbRevReject[2]), { approve: false, reviewedBy: b.reviewedBy ?? '', rejectReason: b.reason }));
      }
      const pbRevisions = path.match(/^\/api\/playbooks\/([^/]+)\/revisions$/);
      if (method === 'POST' && pbRevisions) {
        const b = await readJsonBody(req, 'revision-create');
        return json(res, await api.addPlaybookRevision(pbRevisions[1], {
          authoredBy: b.authoredBy ?? '', note: b.note,
          blocks: b.blocks ?? [],
        }));
      }
      const pbExecute = path.match(/^\/api\/playbooks\/([^/]+)\/execute$/);
      if (method === 'POST' && pbExecute) return json(res, await api.executePlaybook(pbExecute[1]));
      const pbGet = path.match(/^\/api\/playbooks\/([^/]+)$/);
      if (method === 'GET' && pbGet) return json(res, api.getPlaybook(pbGet[1]));

      const pbRunAnalysis = path.match(/^\/api\/playbook-runs\/([^/]+)\/analysis$/);
      if (method === 'POST' && pbRunAnalysis) {
        const b = await readJsonBody(req, 'analysis-submit');
        return json(res, await api.submitAnalysis(pbRunAnalysis[1], {
          playbookId: b.playbookId ?? '', playbookRunId: pbRunAnalysis[1],
          summary: b.summary ?? '', authoredBy: b.authoredBy ?? '',
          improvements: b.improvements ?? [],
          proposals: b.proposals ?? [],
        }));
      }
      const pbRunGet = path.match(/^\/api\/playbook-runs\/([^/]+)$/);
      if (method === 'GET' && pbRunGet) return json(res, api.getPlaybookRun(pbRunGet[1]));

      const anlVerdict = path.match(/^\/api\/analyses\/([^/]+)\/verdict$/);
      if (method === 'POST' && anlVerdict) {
        const b = await readJsonBody(req, 'analysis-verdict');
        return json(res, await api.setAnalysisVerdict(anlVerdict[1], {
          part: b.part ?? 'improvements',
          index: b.index ?? Number.NaN, verdict: b.verdict ?? 'accepted',
          reviewedBy: b.reviewedBy ?? '', linkedPlaybookId: b.linkedPlaybookId,
        }));
      }

      if (method === 'GET' && path === '/api/agent-tasks') {
        const status = url.searchParams.get('status') ?? undefined;
        return json(res, api.listAgentTasks(parseAgentTaskStatusQuery(status)));
      }
      if (method === 'POST' && path === '/api/agent-tasks') {
        const b = await readJsonBody(req, 'agent-task-create');
        return json(res, await api.createAgentTask(b));
      }
      const ataskPatch = path.match(/^\/api\/agent-tasks\/([^/]+)$/);
      if (method === 'PATCH' && ataskPatch) {
        const b = await readJsonBody(req, 'agent-task-close');
        if (b.cancel === true) return json(res, await api.cancelAgentTask(ataskPatch[1]));
        return json(res, await api.closeAgentTask(ataskPatch[1], b.result ?? {}));
      }

      const approveMatch = path.match(/^\/api\/runs\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const b = await readJsonBody(req, 'run-approve');
        return json(res, await api.approveRun(approveMatch[1], {
          approvedBy: b.approvedBy ?? '',
          changeTicketId: b.changeTicketId,
          rollbackPlanId: b.rollbackPlanId,
        }));
      }
      const rejectMatch = path.match(/^\/api\/runs\/([^/]+)\/reject$/);
      if (method === 'POST' && rejectMatch) {
        const b = await readJsonBody(req, 'run-reject');
        return json(res, await api.rejectRun(rejectMatch[1], b));
      }
      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (method === 'GET' && runMatch) return json(res, api.getRun(runMatch[1]));

      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json(res, { error: error.message }, error.status);
      if (error instanceof RequestBodyTooLargeError) {
        return json(res, { error: 'request body too large' }, 413);
      }
      if (error instanceof ZodError || (error instanceof RuntimeSchemaError && error.policy === 'deny')) {
        return json(res, { error: 'invalid JSON request body' }, 400);
      }
      return json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  (server as http.Server & { startup?: () => Promise<void> }).startup = () => seedLegacyApi(api, opts.seedOnStart);
  return server;
}

// Auto-start only when run as a process (not when imported by tests).
if (process.env.MCP_NO_SERVE !== '1' && process.env.VITEST === undefined) {
  void startTowerProcess({ createServer: createTowerServer }).catch(() => { // no-excuse-ok: catch
    console.error('Control Tower startup failed.');
    process.exitCode = 1;
  });
}
