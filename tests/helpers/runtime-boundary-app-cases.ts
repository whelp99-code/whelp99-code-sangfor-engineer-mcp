import {
  deviceRegistryCodec,
  parseBoundaryControlTowerAgentTasksV1,
  parseBoundaryControlTowerAnalysisLineV1,
  parseBoundaryControlTowerPlaybooksV1,
  parseBoundaryControlTowerRegistryV1,
  parseBoundaryControlTowerRequestBodyV1,
} from '../../apps/control-tower/src/runtime-boundaries.js';
import {
  parseBoundaryHttpBridgeRequestBodyV1,
  parseBoundaryHttpBridgeResponseV1,
} from '../../apps/http-bridge/src/runtime-boundaries.js';
import {
  parseBoundaryMcpSearchGapLineV1,
  parseBoundaryMcpStdioRequestV1,
} from '../../apps/mcp-server/src/runtime-boundaries.js';
import { parseBoundaryOperatorRequestBodyV1 } from '../../apps/operator-console/src/runtime-boundaries.js';
import {
  REJECTED_RUNTIME_SECRET,
  type RuntimeBoundaryCase,
} from './runtime-boundary-case.js';

const playbook = {
  id: 'pb-1',
  name: 'baseline',
  goal: 'read only',
  revisions: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};
const analysis = {
  schemaVersion: 1,
  id: 'analysis-1',
  playbookId: 'pb-1',
  playbookRunId: 'run-1',
  summary: 'valid',
  improvements: [],
  proposals: [],
  authoredBy: 'engineer',
  createdAt: '2026-08-27T00:00:00.000Z',
};
const agentTask = {
  id: 'task-1',
  kind: 'assemble',
  payload: { goal: 'valid' },
  status: 'open',
  createdAt: '2026-08-27T00:00:00.000Z',
};
const device = {
  id: 'device-1',
  name: 'loopback fixture',
  product: 'HCI_SCP',
  host: '127.0.0.1',
  tags: [],
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

export const runtimeBoundaryAppCases: readonly RuntimeBoundaryCase[] = [
  {
    id: 'CT_PLAYBOOKS', policy: 'freeze', schemaName: 'control-tower.playbooks.v1',
    parse: parseBoundaryControlTowerPlaybooksV1,
    valid: [playbook], invalid: [{ ...playbook, token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'CT_ANALYSIS_LINE', policy: 'invalid_report', schemaName: 'control-tower.playbook-analysis.v1',
    parse: parseBoundaryControlTowerAnalysisLineV1,
    valid: analysis, invalid: { ...analysis, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'CT_AGENT_TASKS', policy: 'freeze', schemaName: 'control-tower.agent-tasks.v1',
    parse: parseBoundaryControlTowerAgentTasksV1,
    valid: [agentTask], invalid: [{ ...agentTask, token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'CT_REGISTRY', policy: 'freeze', schemaName: 'control-tower.registry.v1',
    parse: (source) => parseBoundaryControlTowerRegistryV1(source, deviceRegistryCodec),
    valid: [device], invalid: [{ ...device, token: REJECTED_RUNTIME_SECRET }],
  },
  {
    id: 'CT_REQUEST_BODY', policy: 'deny', schemaName: 'control-tower.request-body.v1',
    parse: parseBoundaryControlTowerRequestBodyV1,
    valid: { toolId: 'read-tool', args: {} },
    invalid: { toolId: 'read-tool', unexpected: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'HTTP_BRIDGE_RESPONSE', policy: 'INDETERMINATE', schemaName: 'http-bridge.json-rpc-response.v1',
    parse: parseBoundaryHttpBridgeResponseV1,
    valid: { jsonrpc: '2.0', id: 1, result: { ok: true } },
    invalid: { jsonrpc: '2.0', id: 1, result: {}, token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'HTTP_BRIDGE_REQUEST_BODY', policy: 'deny', schemaName: 'http-bridge.request-body.v1',
    parse: parseBoundaryHttpBridgeRequestBodyV1,
    valid: { name: 'read-tool' }, invalid: [REJECTED_RUNTIME_SECRET],
  },
  {
    id: 'MCP_STDIO_REQUEST', policy: 'deny', schemaName: 'mcp-server.json-rpc-request.v1',
    parse: parseBoundaryMcpStdioRequestV1,
    valid: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    invalid: { jsonrpc: '2.0', id: 1, method: 'tools/list', token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'MCP_SEARCH_GAP_LINE', policy: 'freeze', schemaName: 'mcp-server.search-gap-event.v1',
    parse: parseBoundaryMcpSearchGapLineV1,
    valid: { id: 'gap-1', ts: '2026-08-27T00:00:00.000Z', query: 'HCI', hitCount: 0, reason: 'no_hits' },
    invalid: { id: 'gap-1', ts: '2026-08-27T00:00:00.000Z', query: 'HCI', hitCount: 0, reason: 'no_hits', token: REJECTED_RUNTIME_SECRET },
  },
  {
    id: 'OPERATOR_REQUEST_BODY', policy: 'deny', schemaName: 'operator-console.request-body.v1',
    parse: parseBoundaryOperatorRequestBodyV1,
    valid: { query: 'read only' }, invalid: [REJECTED_RUNTIME_SECRET],
  },
];
