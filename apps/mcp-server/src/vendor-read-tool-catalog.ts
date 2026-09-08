import { httpJson } from '../../../packages/sangfor-hci-client/src/index.js';
import { mapFortiOSConfigState, mapFortiOSSystemHealth, mapFortiOSPolicyAudit } from '../../../packages/fortios-client/src/index.js';
import { evaluateSpec, loadSpec, listSpecCoverage, renderAdvisoryReport, renderAdvisoryReportDocx } from '../../../packages/sangfor-spec/src/index.js';
import { fortios_policy_baseline, fortios_system_health_baseline, fortios_policy_audit_baseline } from '../../../packages/fortios-spec/src/index.js';
import { mapCiscoConfigState, mapCiscoSystemHealth, mapCiscoPolicyAudit } from '../../../packages/cisco-client/src/index.js';
import { cisco_interface_baseline, cisco_system_health_baseline, cisco_policy_audit_baseline } from '../../../packages/cisco-spec/src/index.js';
import { normalizeProduct } from '../../../packages/shared/src/index.js';
import { readFileSync } from 'node:fs';
import { mapEppPoolToConfigState, mapCcPoolToConfigState } from '../../../packages/sangfor-config-state/src/index.js';
import type { ToolCatalogEntry } from './mcp-contracts.js';
import { apiBaseUrl, toObservedRecord } from './vendor-advisor-support.js';

export const vendorReadToolCatalog: readonly ToolCatalogEntry[] = [
  ["sangfor_advisor_fortios", {
    description: 'Read-only self-assessment advisor for FortiOS firewalls (policies, interfaces, routing). HTTP GET only against the REST API; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'FortiOS device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 8.0.0)', default: '8.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const { status, json, text } = await httpJson(`${apiBaseUrl(args.host)}/api/v2/firewall/policy`, {
          headers: { Authorization: `Basic ${auth}` },
          tlsSkipVerify: true,
        });
        if (status < 200 || status >= 300) throw new Error(`FortiOS API returned HTTP ${status}: ${text.slice(0, 200)}`);
        const configState = mapFortiOSConfigState(json, 'api');
        const evaluation = evaluateSpec(fortios_policy_baseline, toObservedRecord(configState));
        return { product: 'FORTIOS', device: args.host, evaluation, timestamp };
      } catch (err) {
        return { product: 'FORTIOS', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  }],
  ["sangfor_advisor_fortios_advanced", {
    description: 'Advanced read-only FortiOS advisor: system health (CPU/memory/disk usage, ASIC/NPU load, HA mode and primary-unit status) plus policy audit (syntax validity, duplicate policies, IPS signature version). HTTP GET only across 5 endpoints; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'FortiOS device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 8.0.0)', default: '8.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const base = apiBaseUrl(args.host);
        const get = (path: string) => httpJson(`${base}${path}`, { headers: { Authorization: `Basic ${auth}` }, tlsSkipVerify: true });
        const [statusRes, npuRes, haRes, policyRes, ipsRes] = await Promise.all([
          get('/api/v2/monitor/system/status'),
          get('/api/v2/monitor/system/npu-stats'),
          get('/api/v2/cmdb/system/ha-setting'),
          get('/api/v2/cmdb/firewall/policy'),
          get('/api/v2/cmdb/ips/sensor'),
        ]);
        for (const r of [statusRes, npuRes, haRes, policyRes, ipsRes]) {
          if (r.status < 200 || r.status >= 300) throw new Error(`FortiOS API returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        }
        const healthState = mapFortiOSSystemHealth(statusRes.json, npuRes.json, haRes.json, 'api');
        const auditState = mapFortiOSPolicyAudit(policyRes.json, ipsRes.json, 'api');
        const healthEvaluation = evaluateSpec(fortios_system_health_baseline, toObservedRecord(healthState));
        const auditEvaluation = evaluateSpec(fortios_policy_audit_baseline, toObservedRecord(auditState));
        return { product: 'FORTIOS_ADVANCED', device: args.host, evaluations: [healthEvaluation, auditEvaluation], timestamp };
      } catch (err) {
        return { product: 'FORTIOS_ADVANCED', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  }],
  ["sangfor_advisor_cisco_iosxe", {
    description: 'Read-only self-assessment advisor for Cisco IOS-XE routers/switches (interfaces, routing, ACLs). RESTCONF GET only; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Cisco device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 17.0.0)', default: '17.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const { status, json, text } = await httpJson(`${apiBaseUrl(args.host)}/restconf/data/ietf-interfaces:interfaces`, {
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/yang-data+json' },
          tlsSkipVerify: true,
        });
        if (status < 200 || status >= 300) throw new Error(`Cisco RESTCONF API returned HTTP ${status}: ${text.slice(0, 200)}`);
        const configState = mapCiscoConfigState(json, 'api');
        const evaluation = evaluateSpec(cisco_interface_baseline, toObservedRecord(configState));
        return { product: 'CISCO_IOSXE', device: args.host, evaluation, timestamp };
      } catch (err) {
        return { product: 'CISCO_IOSXE', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  }],
  ["sangfor_advisor_cisco_iosxe_advanced", {
    description: 'Advanced read-only Cisco IOS-XE advisor: system health (per-core CPU average, memory usage, interface down count, VRF count) plus policy audit (zone-pair policy count, ACL rule count, SNORT signature version/inspection status). RESTCONF GET only across 7 endpoints; never mutates the device.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Cisco device IP or hostname (or a full base URL for testing, e.g. http://127.0.0.1:9999)' },
        username: { type: 'string', description: 'Admin username' },
        password: { type: 'string', description: 'Admin password' },
        specVersion: { type: 'string', description: 'Spec version (e.g., 17.0.0)', default: '17.0.0' },
      },
      required: ['host', 'username', 'password'],
    },
    handler: async (args: { host: string; username: string; password: string; specVersion?: string }) => {
      const timestamp = new Date().toISOString();
      try {
        const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
        const base = apiBaseUrl(args.host);
        const get = (path: string) => httpJson(`${base}${path}`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/yang-data+json' }, tlsSkipVerify: true });
        const [cpuRes, memRes, ifaceRes, vrfRes, zonePolicyRes, aclRes, snortRes] = await Promise.all([
          get('/restconf/data/Cisco-IOS-XE-utilization:system'),
          get('/restconf/data/Cisco-IOS-XE-memory:memory'),
          get('/restconf/data/ietf-interfaces:interfaces-state'),
          get('/restconf/data/ietf-routing:routing'),
          get('/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair'),
          get('/restconf/data/Cisco-IOS-XE-acl:ip'),
          get('/restconf/data/Cisco-IOS-XE-snort:snort'),
        ]);
        for (const r of [cpuRes, memRes, ifaceRes, vrfRes, zonePolicyRes, aclRes, snortRes]) {
          if (r.status < 200 || r.status >= 300) throw new Error(`Cisco RESTCONF API returned HTTP ${r.status}: ${r.text.slice(0, 200)}`);
        }
        const healthState = mapCiscoSystemHealth(cpuRes.json, memRes.json, ifaceRes.json, vrfRes.json, 'api');
        const auditState = mapCiscoPolicyAudit(zonePolicyRes.json, aclRes.json, snortRes.json, 'api');
        const healthEvaluation = evaluateSpec(cisco_system_health_baseline, toObservedRecord(healthState));
        const auditEvaluation = evaluateSpec(cisco_policy_audit_baseline, toObservedRecord(auditState));
        return { product: 'CISCO_IOSXE_ADVANCED', device: args.host, evaluations: [healthEvaluation, auditEvaluation], timestamp };
      } catch (err) {
        return { product: 'CISCO_IOSXE_ADVANCED', device: args.host, error: `device query failed: ${String(err instanceof Error ? err.message : err)}`, timestamp };
      }
    }
  }],
  ["sangfor_collect_device_config", {
    description: 'Advisory: map a captured device XHR pool file (from scripts/device-collect.ts) into a provenance-carrying ConfigState, evaluate it against the IntendedSpec, and render the Korean advisory report. Read-only; live capture is NOT performed here (VPN + interactive session required — see docs/DEVICE_DIAGNOSIS_RUNBOOK.md).',
    inputSchema: { type: 'object', properties: { product: { type: 'string' }, version: { type: 'string' }, poolPath: { type: 'string' }, docxPath: { type: 'string' }, live: { type: 'boolean' } }, required: ['product', 'version', 'poolPath'] },
    handler: (args: { product: string; version: string; poolPath: string; docxPath?: string; live?: boolean }) => {
      if (args.live) return { error: 'live capture is not available from this tool: it needs VPN + an interactive browser session. Run scripts/device-collect.ts per docs/DEVICE_DIAGNOSIS_RUNBOOK.md, then pass the pool file here.' };
      const norm = normalizeProduct(args.product);
      if (norm !== 'ENDPOINT_SECURE' && norm !== 'CYBER_COMMAND') {
        return { error: `no pool mapper for ${args.product} yet (EPP and CC only). IAG mappers land with the M3 campaign — fabricating one without captured data is forbidden.` };
      }
      // A5 (issue #23): record the load this collection run put on the device —
      // the envelope rides the tool result into the run ledger on every mapped
      // outcome, refusals included, so collection cost is never invisible.
      const collectStartedAt = Date.now();
      const pool = JSON.parse(readFileSync(args.poolPath, 'utf8'));
      // Issue #23 step 2/3: the call site owns the collection context, so it stamps
      // the firmware version into every fact's provenance envelope here.
      const mapperOptions = { firmwareVersion: args.version };
      const mapped = norm === 'ENDPOINT_SECURE' ? mapEppPoolToConfigState(pool, mapperOptions) : mapCcPoolToConfigState(pool, mapperOptions);
      const collectionLoad = { apiCallCount: mapped.endpointsCaptured, collectDurationMs: Date.now() - collectStartedAt };
      const spec = loadSpec(norm, args.version);
      if (!spec) return { error: `no IntendedSpec for ${norm} ${args.version}. Coverage: ${JSON.stringify(listSpecCoverage())}`, collectionLoad };
      const result = evaluateSpec(spec, mapped.observed);
      const report = renderAdvisoryReport(spec, result);
      const docx = args.docxPath ? renderAdvisoryReportDocx(spec, result, args.docxPath) : undefined;
      return { mapped: { endpointsCaptured: mapped.endpointsCaptured, mappedKeys: mapped.mappedKeys }, collectionLoad, result, report, ...(docx ? { docx } : {}) };
    }
  }],
];
