import { TowerClient } from './tower-client.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';

export const playbookToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_playbook_list", {
    description: 'Read-only: list Control Tower playbooks with their active revision and last run status.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => new TowerClient().request('GET', '/api/playbooks')
  }],
  ["sangfor_playbook_get", {
    description: 'Read-only: get one playbook with all revisions and blocks.',
    inputSchema: { type: 'object', properties: { playbookId: { type: 'string' } }, required: ['playbookId'] },
    handler: ({ playbookId }: { playbookId: string }) =>
      new TowerClient().request('GET', `/api/playbooks/${encodeURIComponent(playbookId)}`)
  }],
  ["sangfor_playbook_run_status", {
    description: 'Read-only: get a playbook run — derived status, per-block run ids and submitted analyses.',
    inputSchema: { type: 'object', properties: { playbookRunId: { type: 'string' } }, required: ['playbookRunId'] },
    handler: ({ playbookRunId }: { playbookRunId: string }) =>
      new TowerClient().request('GET', `/api/playbook-runs/${encodeURIComponent(playbookRunId)}`)
  }],
  ["sangfor_playbook_agent_tasks", {
    description: 'Read-only: list the Control Tower agent task queue (assemble/revise/analyze requests raised from the UI). Poll this to pick up work.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'done', 'cancelled'], default: 'open' } } },
    handler: ({ status }: { status?: string }) =>
      new TowerClient().request('GET', `/api/agent-tasks?status=${encodeURIComponent(status ?? 'open')}`)
  }],
  ["sangfor_playbook_create", {
    description: 'Write (tower-local): create a playbook as revision 1 in draft. Blocks are tool blocks (toolId/args/deviceId) plus at most one report block; args may use {{blocks.<id>.result.<path>}} templates. A human must approve the revision in the tower UI before it can run. Running it requires explicit human approval in the tower UI.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, goal: { type: 'string' }, authoredBy: { type: 'string' },
        note: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object' }, description: '[{id,type:"tool"|"report",title?,toolId?,args?,deviceId?}]' },
      },
      required: ['name', 'goal', 'authoredBy', 'blocks'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request('POST', '/api/playbooks', {
      name: args.name, goal: args.goal, authoredBy: args.authoredBy, note: args.note, blocks: args.blocks,
    })
  }],
  ["sangfor_playbook_add_revision", {
    description: 'Write (tower-local): append a new draft revision to an existing playbook (the revise loop). Needs human approval before it becomes the active revision. Becoming active requires explicit human approval in the tower UI.',
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: { type: 'string' }, authoredBy: { type: 'string' }, note: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object' } },
      },
      required: ['playbookId', 'authoredBy', 'blocks'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request(
      'POST', `/api/playbooks/${encodeURIComponent(String(args.playbookId))}/revisions`,
      { authoredBy: args.authoredBy, note: args.note, blocks: args.blocks },
    )
  }],
  ["sangfor_playbook_execute", {
    description: 'Write: run the approved revision of a playbook block by block. Read-only blocks run immediately; the first write/destructive block stops the run as pending_approval in the tower queue (no device mutation without a separate human approval).',
    inputSchema: { type: 'object', properties: { playbookId: { type: 'string' } }, required: ['playbookId'] },
    handler: ({ playbookId }: { playbookId: string }) => new TowerClient().request(
      'POST', `/api/playbooks/${encodeURIComponent(playbookId)}/execute`, {}, 180_000,
    )
  }],
  ["sangfor_playbook_submit_analysis", {
    description: 'Write (tower-local): submit an append-only AI analysis for a playbook run — observations with evidence run ids plus follow-up proposals. The human accepts or dismisses each item in the UI.',
    inputSchema: {
      type: 'object',
      properties: {
        playbookRunId: { type: 'string' }, playbookId: { type: 'string' },
        summary: { type: 'string' }, authoredBy: { type: 'string' },
        improvements: { type: 'array', items: { type: 'object' }, description: '[{observation,recommendation,evidenceRunId?}]' },
        proposals: { type: 'array', items: { type: 'object' }, description: '[{action,rationale,linkedPlaybookId?}]' },
      },
      required: ['playbookRunId', 'playbookId', 'summary', 'authoredBy'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request(
      'POST', `/api/playbook-runs/${encodeURIComponent(String(args.playbookRunId))}/analysis`,
      {
        playbookId: args.playbookId, summary: args.summary, authoredBy: args.authoredBy,
        improvements: args.improvements ?? [], proposals: args.proposals ?? [],
      },
    )
  }],
  ["sangfor_playbook_close_agent_task", {
    description: 'Write (tower-local): close an agent task as done, recording what was produced (playbookId/rev/analysisId/note).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        result: { type: 'object', description: '{playbookId?,rev?,analysisId?,note?}' },
      },
      required: ['taskId'],
    },
    handler: (args: Record<string, unknown>) => new TowerClient().request(
      'PATCH', `/api/agent-tasks/${encodeURIComponent(String(args.taskId))}`,
      { result: args.result ?? {} },
    )
  }],
];
