import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

interface ToolInfo { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; category?: string }

let listTools: () => ToolInfo[];
let getToolHandler: (name: string) => ((args: Record<string, unknown>) => Promise<unknown> | unknown) | undefined;

// 스텁 타워: 받은 요청을 그대로 반사해 프록시 경로(메서드·경로·바디)를 고정한다.
let tower: http.Server;
const seen: Array<{ method: string; url: string; auth?: string; body: unknown }> = [];

beforeAll(async () => {
  const mod = await import('../apps/mcp-server/src/index.js');
  listTools = (mod as { listTools: typeof listTools }).listTools;
  getToolHandler = (mod as { getToolHandler: typeof getToolHandler }).getToolHandler;

  tower = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw.trim() ? JSON.parse(raw) : null;
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers['authorization'] as string | undefined, body });
    if (req.url === '/api/playbooks/pb_missing') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown playbook: pb_missing' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echo: { method: req.method, url: req.url, body } }));
  });
  await new Promise<void>((r) => tower.listen(0, '127.0.0.1', () => r()));
  process.env.SANGFOR_TOWER_URL = `http://127.0.0.1:${(tower.address() as AddressInfo).port}`;
  process.env.SANGFOR_API_TOKEN = 'tower-token';
});

afterAll(async () => {
  await new Promise<void>((r) => tower.close(() => r()));
  delete process.env.SANGFOR_TOWER_URL;
});

const READ_TOOLS = [
  'sangfor.playbook_list', 'sangfor.playbook_get',
  'sangfor.playbook_run_status', 'sangfor.playbook_agent_tasks',
];
const WRITE_TOOLS = [
  'sangfor.playbook_create', 'sangfor.playbook_add_revision', 'sangfor.playbook_execute',
  'sangfor.playbook_submit_analysis', 'sangfor.playbook_close_agent_task',
];

describe('MCP 플레이북 도구 — 등록·분류', () => {
  it('9개 도구가 playbook 카테고리로 등록된다', () => {
    const byName = new Map(listTools().map((t) => [t.name, t]));
    for (const n of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(byName.get(n), n).toBeTruthy();
      expect(byName.get(n)!.category, n).toBe('playbook');
    }
    expect(listTools().filter((t) => t.category === 'playbook')).toHaveLength(9);
  });

  it('읽기 도구는 readOnly, 쓰기 도구는 write이며 어느 것도 destructive가 아니다', () => {
    const byName = new Map(listTools().map((t) => [t.name, t]));
    for (const n of READ_TOOLS) {
      expect(byName.get(n)!.annotations.readOnlyHint, n).toBe(true);
      expect(byName.get(n)!.annotations.destructiveHint, n).toBe(false);
    }
    for (const n of WRITE_TOOLS) {
      expect(byName.get(n)!.annotations.readOnlyHint, n).toBe(false);
      expect(byName.get(n)!.annotations.destructiveHint, n).toBe(false);
    }
  });

  it('리비전 승인/반려는 MCP 표면에 없다 (승인은 UI의 사람 행위)', () => {
    const names = listTools().map((t) => t.name);
    expect(names.filter((n) => /playbook.*(approve|reject|review)/.test(n))).toEqual([]);
  });
});

describe('MCP 플레이북 도구 — 타워 프록시', () => {
  it('읽기 도구가 타워 GET 경로와 토큰 헤더를 그대로 사용한다', async () => {
    seen.length = 0;
    await getToolHandler('sangfor.playbook_list')!({});
    await getToolHandler('sangfor.playbook_get')!({ playbookId: 'pb_1' });
    await getToolHandler('sangfor.playbook_run_status')!({ playbookRunId: 'pbrun_1' });
    await getToolHandler('sangfor.playbook_agent_tasks')!({});
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/playbooks',
      'GET /api/playbooks/pb_1',
      'GET /api/playbook-runs/pbrun_1',
      'GET /api/agent-tasks?status=open',
    ]);
    expect(seen.every((s) => s.auth === 'Bearer tower-token')).toBe(true);
  });

  it('쓰기 도구가 타워 POST/PATCH 바디를 정확히 구성한다', async () => {
    seen.length = 0;
    const blocks = [{ id: 'b1', type: 'tool', toolId: 'sangfor.store_health', args: {} }, { id: 'r', type: 'report' }];
    await getToolHandler('sangfor.playbook_create')!({ name: 'n', goal: 'g', authoredBy: 'agent:claude', blocks });
    await getToolHandler('sangfor.playbook_add_revision')!({ playbookId: 'pb_1', authoredBy: 'agent:claude', blocks });
    await getToolHandler('sangfor.playbook_execute')!({ playbookId: 'pb_1' });
    await getToolHandler('sangfor.playbook_submit_analysis')!({ playbookRunId: 'pbrun_1', playbookId: 'pb_1', summary: 's', authoredBy: 'agent:claude' });
    await getToolHandler('sangfor.playbook_close_agent_task')!({ taskId: 'atask_1', result: { playbookId: 'pb_1' } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /api/playbooks',
      'POST /api/playbooks/pb_1/revisions',
      'POST /api/playbooks/pb_1/execute',
      'POST /api/playbook-runs/pbrun_1/analysis',
      'PATCH /api/agent-tasks/atask_1',
    ]);
    expect(seen[0].body).toMatchObject({ name: 'n', goal: 'g', authoredBy: 'agent:claude', blocks });
    expect(seen[3].body).toMatchObject({ playbookId: 'pb_1', summary: 's', improvements: [], proposals: [] });
    expect(seen[4].body).toMatchObject({ result: { playbookId: 'pb_1' } });
  });

  it('타워 4xx는 예외가 아니라 error 값으로 돌아온다', async () => {
    const out = await getToolHandler('sangfor.playbook_get')!({ playbookId: 'pb_missing' }) as { error?: string };
    expect(out.error).toContain('HTTP 404');
    expect(out.error).toContain('unknown playbook: pb_missing');
  });

  it('타워가 안 떠 있으면 실행 힌트를 담은 error 값을 반환한다', async () => {
    const saved = process.env.SANGFOR_TOWER_URL;
    process.env.SANGFOR_TOWER_URL = 'http://127.0.0.1:1';
    try {
      const out = await getToolHandler('sangfor.playbook_list')!({}) as { error?: string; hint?: string };
      expect(out.error).toContain('control tower unreachable');
      expect(out.hint).toContain('dev:control-tower');
    } finally {
      process.env.SANGFOR_TOWER_URL = saved;
    }
  });
});
