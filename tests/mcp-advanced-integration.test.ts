import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';

// Importing the MCP server module must NOT start the stdio readline loop.
process.env.MCP_NO_SERVE = '1';

// ─── Mock device backend on :3001 ──────────────────────────────────────────
// A single in-process HTTP server plays the role of "mock-sangfor-console":
// it answers the exact FortiOS (`/api/v2/...`) and Cisco RESTCONF
// (`/restconf/data/...`) paths that `sangfor.advisor_fortios_advanced` /
// `sangfor.advisor_cisco_iosxe_advanced` query in apps/mcp-server/src/index.ts.
// (The apps/mock-sangfor-console package's own `/api/v1/fortios/*` and
// `/api/v1/cisco-iosxe/*` routes are a separate, non-overlapping URL scheme
// used by scripts/device-collect.ts fixtures — not what the deployed advisor
// tools call — so reusing that server here would 404 every request. This
// mismatch is the same one flagged in task-9-advanced-report.md /
// task-10-advanced-report.md for this plan.)
type Scenario = 'happy' | 'missingField' | 'error';

const FORTIOS_FIXTURES: Record<Exclude<Scenario, 'error'>, Record<string, unknown>> = {
  happy: {
    '/api/v2/monitor/system/status': { results: [{ cpu: 42, mem: 58, disk: 35 }] },
    '/api/v2/monitor/system/npu-stats': { results: [{ cpu: 65 }] },
    '/api/v2/cmdb/system/ha-setting': { results: [{ mode: 'a-p', state: 'master' }] },
    '/api/v2/cmdb/firewall/policy': {
      results: [
        { action: 'accept', srcintf: 'port1', dstintf: 'port2' },
        { action: 'accept', srcintf: 'port1', dstintf: 'port2' }, // duplicate
        { action: 'deny', srcintf: 'port3', dstintf: 'port4' },
      ],
    },
    '/api/v2/cmdb/ips/sensor': { results: [{ signature_database: '20250703' }] },
  },
  missingField: {
    '/api/v2/monitor/system/status': { results: [{ cpu: 42 }] }, // mem, disk absent
    '/api/v2/monitor/system/npu-stats': { results: [{}] }, // cpu absent
    '/api/v2/cmdb/system/ha-setting': { results: [{ mode: 'a-p' }] }, // state absent
    '/api/v2/cmdb/firewall/policy': { results: [{ action: 'accept', srcintf: 'port1' }] }, // dstintf absent
    '/api/v2/cmdb/ips/sensor': { results: [] }, // signature_database absent
  },
};

const CISCO_FIXTURES: Record<Exclude<Scenario, 'error'>, Record<string, unknown>> = {
  happy: {
    '/restconf/data/Cisco-IOS-XE-utilization:system': {
      'Cisco-IOS-XE-utilization:system': {
        'cpu-utilization': {
          'cpu-core': [
            { 'core-id': 0, 'cpu-utilization': 45 },
            { 'core-id': 1, 'cpu-utilization': 55 },
          ],
        },
      },
    },
    '/restconf/data/Cisco-IOS-XE-memory:memory': {
      'Cisco-IOS-XE-memory:memory': { 'memory-statistics': { total: 1000, used: 500 } },
    },
    '/restconf/data/ietf-interfaces:interfaces-state': {
      'ietf-interfaces:interfaces-state': {
        interface: [
          { name: 'GigabitEthernet0/0/0', 'oper-status': 'up' },
          { name: 'GigabitEthernet0/0/1', 'oper-status': 'down' },
        ],
      },
    },
    '/restconf/data/ietf-routing:routing': {
      'ietf-routing:routing': {
        'control-plane-protocols': {
          'control-plane-protocol': [{ 'vrf-name': 'default' }, { 'vrf-name': 'customer1' }],
        },
      },
    },
    '/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair': {
      'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
        { source_zone: 'inside', destination_zone: 'outside' },
        { source_zone: 'dmz', destination_zone: 'outside' },
      ],
    },
    '/restconf/data/Cisco-IOS-XE-acl:ip': {
      'Cisco-IOS-XE-acl:ip': {
        'access-lists': {
          'access-list': [
            { 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }, { sequence: 20, action: 'deny' }] } },
            { 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }] } },
          ],
        },
      },
    },
    '/restconf/data/Cisco-IOS-XE-snort:snort': {
      'Cisco-IOS-XE-snort:snort': { 'snort-config': { 'rule-database-version': '20250703', enabled: true } },
    },
  },
  missingField: {
    '/restconf/data/Cisco-IOS-XE-utilization:system': {}, // no 'Cisco-IOS-XE-utilization:system' key
    '/restconf/data/Cisco-IOS-XE-memory:memory': {
      'Cisco-IOS-XE-memory:memory': { 'memory-statistics': { total: 1000, used: 500 } },
    },
    '/restconf/data/ietf-interfaces:interfaces-state': {}, // no 'ietf-interfaces:interfaces-state' key
    '/restconf/data/ietf-routing:routing': {
      'ietf-routing:routing': {
        'control-plane-protocols': { 'control-plane-protocol': [{ 'vrf-name': 'default' }] },
      },
    },
    '/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair': {}, // no zone-pair key
    '/restconf/data/Cisco-IOS-XE-acl:ip': {
      'Cisco-IOS-XE-acl:ip': {
        'access-lists': { 'access-list': [{ 'access-list-entries': { 'access-list-entry': [{ sequence: 10, action: 'permit' }] } }] },
      },
    },
    '/restconf/data/Cisco-IOS-XE-snort:snort': {}, // no snort key
  },
};

describe('MCP advanced advisor tools — end-to-end integration (mock device backend on :3001)', () => {
  let mockServer: http.Server;
  const base = 'http://127.0.0.1:3001';
  let fortiosScenario: Scenario = 'happy';
  let ciscoScenario: Scenario = 'happy';
  let getToolHandler: typeof import('../apps/mcp-server/src/index.js')['getToolHandler'];

  beforeAll(async () => {
    ({ getToolHandler } = await import('../apps/mcp-server/src/index.js'));

    mockServer = http.createServer((req, res) => {
      const url = req.url ?? '';
      const respondJson = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (Object.prototype.hasOwnProperty.call(FORTIOS_FIXTURES.happy, url)) {
        if (fortiosScenario === 'error') {
          res.writeHead(500, { 'Content-Type': 'text/plain' }).end('mock FortiOS internal error');
          return;
        }
        respondJson(FORTIOS_FIXTURES[fortiosScenario][url]);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(CISCO_FIXTURES.happy, url)) {
        if (ciscoScenario === 'error') {
          res.writeHead(500, { 'Content-Type': 'text/plain' }).end('mock Cisco RESTCONF internal error');
          return;
        }
        respondJson(CISCO_FIXTURES[ciscoScenario][url]);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(3001, '127.0.0.1', resolve));
  });

  afterAll(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));

  describe('FortiOS advanced advisor (sangfor.advisor_fortios_advanced)', () => {
    it('happy path: queries all 5 endpoints, maps config-state, evaluates both baselines, returns a complete result', async () => {
      fortiosScenario = 'happy';
      const handler = getToolHandler('sangfor.advisor_fortios_advanced');
      expect(handler).toBeDefined();

      const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

      expect(result.error).toBeUndefined();
      expect(result.product).toBe('FORTIOS_ADVANCED');
      expect(result.device).toBe(base);
      expect(result.timestamp).toBeTruthy();
      expect(result.evaluations).toHaveLength(2);

      const [healthEval, auditEval] = result.evaluations;

      // System health: all 6 spec keys observed (cpu/mem/disk/npu/haMode/haPrimaryUnit).
      expect(healthEval.items).toHaveLength(6);
      expect(healthEval.coverage.specifiedTotal).toBe(6);
      expect(healthEval.coverage.observedTotal).toBe(6);
      expect(healthEval.coverage.unobservedItems).toHaveLength(0);

      // Policy audit: all 3 spec keys observed (syntax/duplicates/IPS version).
      expect(auditEval.items).toHaveLength(3);
      expect(auditEval.coverage.specifiedTotal).toBe(3);
      expect(auditEval.coverage.observedTotal).toBe(3);
      expect(auditEval.coverage.unobservedItems).toHaveLength(0);
    });

    it('missing-field handling: incomplete endpoint responses are mapped and evaluated without throwing', async () => {
      fortiosScenario = 'missingField';
      const handler = getToolHandler('sangfor.advisor_fortios_advanced');

      const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

      expect(result.error).toBeUndefined();
      expect(result.product).toBe('FORTIOS_ADVANCED');
      expect(result.evaluations).toHaveLength(2);

      const [healthEval, auditEval] = result.evaluations;

      // Only cpu (status) and haMode survive; mem/disk/npu/haPrimaryUnit are absent from the mock responses.
      expect(healthEval.coverage.specifiedTotal).toBe(6);
      expect(healthEval.coverage.observedTotal).toBe(2);
      expect(healthEval.coverage.unobservedItems.sort()).toEqual(
        ['ha_primary_unit', 'npu_cpu_usage', 'system_disk_usage', 'system_memory_usage'].sort()
      );

      // Policy syntax + duplicate count still compute (from the one partial policy record);
      // IPS signature version is absent because the mock ips endpoint returned no results.
      expect(auditEval.coverage.specifiedTotal).toBe(3);
      expect(auditEval.coverage.observedTotal).toBe(2);
      expect(auditEval.coverage.unobservedItems).toEqual(['ips_signature_version']);
    });

    it('error case: a non-2xx response from any endpoint is caught and returned as a structured error', async () => {
      fortiosScenario = 'error';
      const handler = getToolHandler('sangfor.advisor_fortios_advanced');

      const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

      expect(result.product).toBe('FORTIOS_ADVANCED');
      expect(result.device).toBe(base);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/HTTP 500/);
      expect(result.evaluations).toBeUndefined();
    });
  });

  describe('Cisco IOS-XE advanced advisor (sangfor.advisor_cisco_iosxe_advanced)', () => {
    it('happy path: queries all 7 endpoints, maps config-state, evaluates both baselines, returns a complete result', async () => {
      ciscoScenario = 'happy';
      const handler = getToolHandler('sangfor.advisor_cisco_iosxe_advanced');
      expect(handler).toBeDefined();

      const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

      expect(result.error).toBeUndefined();
      expect(result.product).toBe('CISCO_IOSXE_ADVANCED');
      expect(result.device).toBe(base);
      expect(result.timestamp).toBeTruthy();
      expect(result.evaluations).toHaveLength(2);

      const [healthEval, auditEval] = result.evaluations;

      // System health: per-core CPU average, memory %, down-interface count, VRF count — all 4 observed.
      expect(healthEval.items).toHaveLength(4);
      expect(healthEval.coverage.specifiedTotal).toBe(4);
      expect(healthEval.coverage.observedTotal).toBe(4);
      expect(healthEval.coverage.unobservedItems).toHaveLength(0);

      // Policy audit: zone-pairs, ACL rules, SNORT version + enabled — all 4 observed.
      expect(auditEval.items).toHaveLength(4);
      expect(auditEval.coverage.specifiedTotal).toBe(4);
      expect(auditEval.coverage.observedTotal).toBe(4);
      expect(auditEval.coverage.unobservedItems).toHaveLength(0);
    });

    it('missing-field handling: incomplete RESTCONF responses are mapped and evaluated without throwing', async () => {
      ciscoScenario = 'missingField';
      const handler = getToolHandler('sangfor.advisor_cisco_iosxe_advanced');

      const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

      expect(result.error).toBeUndefined();
      expect(result.product).toBe('CISCO_IOSXE_ADVANCED');
      expect(result.evaluations).toHaveLength(2);

      const [healthEval, auditEval] = result.evaluations;

      // Only memory usage and VRF count survive; CPU-utilization and interfaces-state containers are absent.
      expect(healthEval.coverage.specifiedTotal).toBe(4);
      expect(healthEval.coverage.observedTotal).toBe(2);
      expect(healthEval.coverage.unobservedItems.sort()).toEqual(
        ['interface_down_count', 'system_cpu_usage_per_core'].sort()
      );

      // Only the ACL rule count survives; zone-pair and snort containers are absent.
      expect(auditEval.coverage.specifiedTotal).toBe(4);
      expect(auditEval.coverage.observedTotal).toBe(1);
      expect(auditEval.coverage.unobservedItems.sort()).toEqual(
        ['snort_inspection_enabled', 'snort_signature_version', 'zone_pair_policy_count'].sort()
      );
    });

    it('error case: a non-2xx response from any RESTCONF endpoint is caught and returned as a structured error', async () => {
      ciscoScenario = 'error';
      const handler = getToolHandler('sangfor.advisor_cisco_iosxe_advanced');

      const result: any = await handler!({ host: base, username: 'admin', password: 'password' });

      expect(result.product).toBe('CISCO_IOSXE_ADVANCED');
      expect(result.device).toBe(base);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/HTTP 500/);
      expect(result.evaluations).toBeUndefined();
    });
  });
});
