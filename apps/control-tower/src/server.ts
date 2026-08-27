import http from 'node:http';
import { URL } from 'node:url';
import { checkAuth } from '../../../packages/shared/src/index.js';
import type { RunStatus } from '../../../packages/sangfor-runs/src/index.js';
import type { PlaybookBlock, AgentTask } from './playbook-store.js';
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
      if (await refuseUnreadyAuthorityApi(authorityRoute)) return;
      if (path.startsWith('/api/')) {
        const auth = checkAuth(req.headers['authorization'], apiToken);
        if (!auth.ok) return json(res, { error: 'unauthorized' }, auth.status ?? 401);
      }
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
        const b = await readJsonBody(req);
        return json(res, await api.createDevice({
          name: String(b.name ?? ''),
          product: String(b.product ?? ''),
          host: String(b.host ?? ''),
          tags: Array.isArray(b.tags) ? b.tags.map(String) : [],
          credentialEnv: b.credentialEnv && typeof b.credentialEnv === 'object'
            ? (b.credentialEnv as Record<string, string>) : undefined,
        }));
      }
      const deviceMatch = path.match(/^\/api\/devices\/([^/]+)$/);
      if (method === 'PUT' && deviceMatch) {
        const b = await readJsonBody(req);
        return json(res, await api.updateDevice(deviceMatch[1], b as Record<string, never>));
      }
      if (method === 'DELETE' && deviceMatch) return json(res, await api.deleteDevice(deviceMatch[1]));
      if (method === 'POST' && path === '/api/sweep') {
        const b = await readJsonBody(req);
        return json(res, await api.sweep({
          deviceIds: Array.isArray(b.deviceIds) ? b.deviceIds.map(String) : undefined,
        }));
      }
      if (method === 'POST' && path === '/api/approvals/mint') {
        const b = await readJsonBody(req);
        return json(res, api.mint(b as Parameters<typeof api.mint>[0]));
      }
      if (method === 'POST' && path === '/api/runs') {
        const b = await readJsonBody(req);
        return json(res, await api.createRun({
          toolId: String(b.toolId ?? ''),
          args: (b.args && typeof b.args === 'object' ? b.args : {}) as Record<string, unknown>,
          deviceId: typeof b.deviceId === 'string' ? b.deviceId : undefined,
        }));
      }
      if (method === 'GET' && path === '/api/runs') {
        const num = (v: string | null) => (v === null || v === '' ? undefined : Number(v));
        return json(res, {
          runs: api.listRuns({
            status: (url.searchParams.get('status') ?? undefined) as RunStatus | undefined,
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
        const b = await readJsonBody(req);
        return json(res, await api.seedPlaybooks({ authoredBy: typeof b.authoredBy === 'string' ? b.authoredBy : undefined }));
      }
      if (method === 'POST' && path === '/api/playbooks') {
        const b = await readJsonBody(req);
        return json(res, await api.createPlaybook({
          name: String(b.name ?? ''), goal: String(b.goal ?? ''), authoredBy: String(b.authoredBy ?? ''),
          note: typeof b.note === 'string' ? b.note : undefined,
          blocks: Array.isArray(b.blocks) ? (b.blocks as PlaybookBlock[]) : [],
        }));
      }
      const pbRevApprove = path.match(/^\/api\/playbooks\/([^/]+)\/revisions\/(\d+)\/approve$/);
      if (method === 'POST' && pbRevApprove) {
        const b = await readJsonBody(req);
        return json(res, await api.reviewPlaybookRevision(pbRevApprove[1], Number(pbRevApprove[2]), { approve: true, reviewedBy: String(b.reviewedBy ?? '') }));
      }
      const pbRevReject = path.match(/^\/api\/playbooks\/([^/]+)\/revisions\/(\d+)\/reject$/);
      if (method === 'POST' && pbRevReject) {
        const b = await readJsonBody(req);
        return json(res, await api.reviewPlaybookRevision(pbRevReject[1], Number(pbRevReject[2]), { approve: false, reviewedBy: String(b.reviewedBy ?? ''), rejectReason: typeof b.reason === 'string' ? b.reason : undefined }));
      }
      const pbRevisions = path.match(/^\/api\/playbooks\/([^/]+)\/revisions$/);
      if (method === 'POST' && pbRevisions) {
        const b = await readJsonBody(req);
        return json(res, await api.addPlaybookRevision(pbRevisions[1], {
          authoredBy: String(b.authoredBy ?? ''), note: typeof b.note === 'string' ? b.note : undefined,
          blocks: Array.isArray(b.blocks) ? (b.blocks as PlaybookBlock[]) : [],
        }));
      }
      const pbExecute = path.match(/^\/api\/playbooks\/([^/]+)\/execute$/);
      if (method === 'POST' && pbExecute) return json(res, await api.executePlaybook(pbExecute[1]));
      const pbGet = path.match(/^\/api\/playbooks\/([^/]+)$/);
      if (method === 'GET' && pbGet) return json(res, api.getPlaybook(pbGet[1]));

      const pbRunAnalysis = path.match(/^\/api\/playbook-runs\/([^/]+)\/analysis$/);
      if (method === 'POST' && pbRunAnalysis) {
        const b = await readJsonBody(req);
        return json(res, await api.submitAnalysis(pbRunAnalysis[1], {
          playbookId: String(b.playbookId ?? ''), playbookRunId: pbRunAnalysis[1],
          summary: String(b.summary ?? ''), authoredBy: String(b.authoredBy ?? ''),
          improvements: Array.isArray(b.improvements) ? (b.improvements as never[]) : [],
          proposals: Array.isArray(b.proposals) ? (b.proposals as never[]) : [],
        }));
      }
      const pbRunGet = path.match(/^\/api\/playbook-runs\/([^/]+)$/);
      if (method === 'GET' && pbRunGet) return json(res, api.getPlaybookRun(pbRunGet[1]));

      const anlVerdict = path.match(/^\/api\/analyses\/([^/]+)\/verdict$/);
      if (method === 'POST' && anlVerdict) {
        const b = await readJsonBody(req);
        return json(res, await api.setAnalysisVerdict(anlVerdict[1], {
          part: b.part === 'proposals' ? 'proposals' : 'improvements',
          index: Number(b.index), verdict: b.verdict === 'dismissed' ? 'dismissed' : 'accepted',
          reviewedBy: String(b.reviewedBy ?? ''), linkedPlaybookId: typeof b.linkedPlaybookId === 'string' ? b.linkedPlaybookId : undefined,
        }));
      }

      if (method === 'GET' && path === '/api/agent-tasks') {
        const status = url.searchParams.get('status');
        return json(res, api.listAgentTasks(status ? (status as AgentTask['status']) : undefined));
      }
      if (method === 'POST' && path === '/api/agent-tasks') {
        const b = await readJsonBody(req);
        return json(res, await api.createAgentTask({ kind: b.kind as AgentTask['kind'], payload: (b.payload && typeof b.payload === 'object' ? b.payload : {}) as AgentTask['payload'] }));
      }
      const ataskPatch = path.match(/^\/api\/agent-tasks\/([^/]+)$/);
      if (method === 'PATCH' && ataskPatch) {
        const b = await readJsonBody(req);
        if (b.cancel === true) return json(res, await api.cancelAgentTask(ataskPatch[1]));
        return json(res, await api.closeAgentTask(ataskPatch[1], (b.result && typeof b.result === 'object' ? b.result : {}) as AgentTask['result']));
      }

      const approveMatch = path.match(/^\/api\/runs\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) {
        const b = await readJsonBody(req);
        return json(res, await api.approveRun(approveMatch[1], {
          approvedBy: String(b.approvedBy ?? ''),
          changeTicketId: typeof b.changeTicketId === 'string' ? b.changeTicketId : undefined,
          rollbackPlanId: typeof b.rollbackPlanId === 'string' ? b.rollbackPlanId : undefined,
        }));
      }
      const rejectMatch = path.match(/^\/api\/runs\/([^/]+)\/reject$/);
      if (method === 'POST' && rejectMatch) {
        const b = await readJsonBody(req);
        return json(res, await api.rejectRun(rejectMatch[1], {
          reason: typeof b.reason === 'string' ? b.reason : undefined,
        }));
      }
      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (method === 'GET' && runMatch) return json(res, api.getRun(runMatch[1]));

      return json(res, { error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof ApiError) return json(res, { error: error.message }, error.status);
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
