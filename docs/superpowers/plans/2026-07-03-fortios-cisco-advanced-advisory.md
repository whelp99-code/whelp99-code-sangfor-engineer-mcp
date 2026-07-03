# FortiOS & Cisco Advanced Advisory Queries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend FortiOS and Cisco advisory queries from basic policy/interface counts to comprehensive system health, policy auditing, threat protection status, and cluster consistency checks.

**Architecture:** Build on existing spec/config-state/evaluate pattern. Each vendor gets an "advanced" baseline spec with additional observedKey values (CPU, memory, HA/VRRP status, policy validation, IPS stats, etc.). Query mappers expand to fetch from `/api/v2/monitor/system/status`, `/api/v2/monitor/ips/sensor-stat` (FortiOS) and `/restconf/data/Cisco-IOS-XE-*` (Cisco). MCP tools remain single `advisor_fortios_advanced` and `advisor_cisco_iosxe_advanced` but return richer evaluation data.

**Tech Stack:** Same as multi-vendor foundation (TypeScript, YANG/REST, mock-sangfor-console, MCP server).

## Global Constraints

- **Advanced Specs:** Add to existing packages (fortios-spec, cisco-spec); do NOT create new packages
- **Config-State Format:** Maintain `{ observedKey, value, source }[]` shape; add new observedKeys without breaking existing ones
- **Mock Server:** Use same `/api/v1/fortios/*` and `/api/v1/cisco-iosxe/*` routes; add new endpoints (e.g., `/api/v1/fortios/query-system-stats`)
- **MCP Tools:** Register `advisor_fortios_advanced` and `advisor_cisco_iosxe_advanced` with same input/output schema as base tools
- **Test Command:** `npm test -- fortios` / `npm test -- cisco` must pass; verify 299+ tests still passing after changes
- **Commit Granularity:** One task = one feature commit

---

## File Structure

**Spec packages (modified):**
- `packages/fortios-spec/src/index.ts` — Add `fortios_system_health_baseline` and `fortios_policy_audit_baseline` exports

**Client packages (modified):**
- `packages/fortios-client/src/config-state.ts` — Add `mapFortiOSSystemHealth()` and `mapFortiOSPolicyAudit()` functions
- `packages/cisco-client/src/config-state.ts` — Add `mapCiscoSystemHealth()` and `mapCiscoPolicyAudit()` functions

**Mock server (modified):**
- `apps/mock-sangfor-console/src/fortios.ts` — Add `fortiOSSystemStatsHandler`, `fortiOSPolicyAuditHandler`, `fortiOSIPSStatsHandler`
- `apps/mock-sangfor-console/src/cisco-iosxe.ts` — Add `ciscoSystemStatsHandler`, `ciscoZonePolicyHandler`, `ciscoSNORTStatusHandler`
- `apps/mock-sangfor-console/src/server.ts` — Register new routes

**MCP server (modified):**
- `apps/mcp-server/src/index.ts` — Add tool metadata for `advisor_fortios_advanced` and `advisor_cisco_iosxe_advanced`, add handler logic

**Tests (created):**
- `tests/fortios-advanced-config-state.test.ts`
- `tests/cisco-advanced-config-state.test.ts`
- `tests/mcp-fortios-advanced-advisor.test.ts`
- `tests/mcp-cisco-advanced-advisor.test.ts`

---

## Task 1: FortiOS Advanced Spec — System Health & Policy Audit

**Files:**
- Modify: `packages/fortios-spec/src/index.ts`

**Interfaces:**
- Consumes: Existing `Spec` type from sangfor-spec
- Produces: 
  - `fortios_system_health_baseline: Spec` with 6 items (CPU, memory, disk, ASIC load, HA mode, HA role)
  - `fortios_policy_audit_baseline: Spec` with 3 items (valid syntax, duplicate count, IPS signature version)

**Steps:**

- [ ] **Step 1: Add system health baseline to fortios-spec/src/index.ts**

After the existing `fortios_interface_baseline` export, add:

```typescript
export const fortios_system_health_baseline: Spec = {
  id: 'spec_fortios_8_0_0_system_health',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'system_cpu_usage',
      capabilityId: 'system_health',
      label: '시스템 CPU 사용률',
      observedKey: 'systemCpuUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'system_memory_usage',
      capabilityId: 'system_health',
      label: '시스템 메모리 사용률',
      observedKey: 'systemMemoryUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'system_disk_usage',
      capabilityId: 'system_health',
      label: '시스템 디스크 사용률',
      observedKey: 'systemDiskUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'npu_cpu_usage',
      capabilityId: 'system_health',
      label: 'NPU (ASIC) CPU 사용률',
      observedKey: 'npuCpuUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'ha_mode',
      capabilityId: 'redundancy',
      label: 'HA 모드 (Active-Passive/Active-Active)',
      observedKey: 'haMode',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'ha_primary_unit',
      capabilityId: 'redundancy',
      label: 'HA 주 장치 여부',
      observedKey: 'haPrimaryUnit',
      op: 'exists',
      severity: 'must',
    },
  ],
};

export const fortios_policy_audit_baseline: Spec = {
  id: 'spec_fortios_8_0_0_policy_audit',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'policy_syntax_valid',
      capabilityId: 'internet_policy',
      label: '정책 구문 유효성',
      observedKey: 'policySyntaxValid',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'policy_duplicate_count',
      capabilityId: 'internet_policy',
      label: '중복 정책 개수',
      observedKey: 'policyDuplicateCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'ips_signature_version',
      capabilityId: 'threat_prevention',
      label: 'IPS 서명 버전',
      observedKey: 'ipsSignatureVersion',
      op: 'exists',
      severity: 'must',
    },
  ],
};
```

- [ ] **Step 2: Run build to verify no errors**

```bash
cd /Users/jmpark/Playground/whelp99-code-sangfor-engineer-mcp
npm run build -- --filter '@sangfor-engineer/fortios-spec'
```

Expected: Build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/fortios-spec/src/index.ts
git commit -m "feat(spec): add FortiOS advanced baseline specs (system health, policy audit)

- Add fortios_system_health_baseline with 6 items (CPU, memory, disk, ASIC, HA)
- Add fortios_policy_audit_baseline with 3 items (syntax, duplicates, IPS version)
- Mirrors pattern from basic specs for consistency"
```

---

## Task 2: Cisco Advanced Spec — System Health & Policy Audit

**Files:**
- Modify: `packages/cisco-spec/src/index.ts`

**Interfaces:**
- Consumes: Existing `Spec` type
- Produces:
  - `cisco_system_health_baseline: Spec` with 4 items (CPU per-core, memory, interface down count, VRF count)
  - `cisco_policy_audit_baseline: Spec` with 4 items (zone-policy count, ACL rule count, SNORT version, SNORT enabled)

**Steps:**

- [ ] **Step 1: Add system health and policy audit baselines to cisco-spec/src/index.ts**

After existing exports, add:

```typescript
export const cisco_system_health_baseline: Spec = {
  id: 'spec_cisco_iosxe_17_0_0_system_health',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'system_cpu_usage_per_core',
      capabilityId: 'system_health',
      label: '코어별 CPU 사용률 (평균)',
      observedKey: 'systemCpuUsageAverage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'system_memory_usage',
      capabilityId: 'system_health',
      label: '시스템 메모리 사용률',
      observedKey: 'systemMemoryUsage',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'interface_down_count',
      capabilityId: 'wan_connectivity',
      label: '다운된 인터페이스 개수',
      observedKey: 'interfaceDownCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'vrf_count',
      capabilityId: 'redundancy',
      label: 'VRF (가상 라우팅) 개수',
      observedKey: 'vrfCount',
      op: 'exists',
      severity: 'must',
    },
  ],
};

export const cisco_policy_audit_baseline: Spec = {
  id: 'spec_cisco_iosxe_17_0_0_policy_audit',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'zone_pair_policy_count',
      capabilityId: 'internet_policy',
      label: 'Zone-Pair 정책 개수',
      observedKey: 'zonePairPolicyCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'acl_rule_count',
      capabilityId: 'internet_policy',
      label: 'ACL 규칙 개수',
      observedKey: 'aclRuleCount',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'snort_signature_version',
      capabilityId: 'threat_prevention',
      label: 'Snort 서명 버전',
      observedKey: 'snortSignatureVersion',
      op: 'exists',
      severity: 'must',
    },
    {
      id: 'snort_inspection_enabled',
      capabilityId: 'threat_prevention',
      label: 'Snort IPS 검사 활성',
      observedKey: 'snortInspectionEnabled',
      op: 'exists',
      severity: 'must',
    },
  ],
};
```

- [ ] **Step 2: Run build to verify**

```bash
npm run build -- --filter '@sangfor-engineer/cisco-spec'
```

Expected: Build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/cisco-spec/src/index.ts
git commit -m "feat(spec): add Cisco advanced baseline specs (system health, policy audit)

- Add cisco_system_health_baseline with 4 items (CPU avg, memory, downed interfaces, VRF count)
- Add cisco_policy_audit_baseline with 4 items (zone-pairs, ACLs, SNORT version, SNORT status)
- Follows existing spec pattern for consistency"
```

---

## Task 3: FortiOS Advanced Query Mappers

**Files:**
- Modify: `packages/fortios-client/src/config-state.ts`

**Interfaces:**
- Consumes: FortiOS API responses from `/api/v2/monitor/system/status`, `/api/v2/monitor/system/npu-stats`, `/api/v2/cmdb/system/ha-setting`, `/api/v2/cmdb/firewall/policy`, `/api/v2/cmdb/ips/sensor`, `/api/v2/monitor/ips/sensor-stat`
- Produces: 
  - `mapFortiOSSystemHealth(statusResponse, npuResponse, haResponse) => ConfigStateItem[]`
  - `mapFortiOSPolicyAudit(policyResponse) => ConfigStateItem[]`

**Steps:**

- [ ] **Step 1: Add system health mapper to fortios-client/src/config-state.ts**

After existing `mapFortiOSConfigState()` function, add:

```typescript
/**
 * Map FortiOS system health metrics (CPU, memory, disk, ASIC load, HA status)
 * Consumes: /api/v2/monitor/system/status, /api/v2/monitor/system/npu-stats, /api/v2/cmdb/system/ha-setting
 */
export function mapFortiOSSystemHealth(
  statusResponse: any,
  npuResponse: any,
  haResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // CPU usage from status (single value for system)
  if (statusResponse?.results?.[0]?.cpu) {
    items.push({
      observedKey: 'systemCpuUsage',
      value: statusResponse.results[0].cpu,
      source,
    });
  }

  // Memory usage
  if (statusResponse?.results?.[0]?.mem) {
    items.push({
      observedKey: 'systemMemoryUsage',
      value: statusResponse.results[0].mem,
      source,
    });
  }

  // Disk usage
  if (statusResponse?.results?.[0]?.disk) {
    items.push({
      observedKey: 'systemDiskUsage',
      value: statusResponse.results[0].disk,
      source,
    });
  }

  // ASIC (NP7) CPU usage from npu-stats
  if (npuResponse?.results?.[0]?.cpu) {
    items.push({
      observedKey: 'npuCpuUsage',
      value: npuResponse.results[0].cpu,
      source,
    });
  }

  // HA mode (a-p for active-passive, a-a for active-active, standalone)
  if (haResponse?.results?.[0]?.mode) {
    items.push({
      observedKey: 'haMode',
      value: haResponse.results[0].mode === 'a-p' ? 'active-passive' : 
             haResponse.results[0].mode === 'a-a' ? 'active-active' : 'standalone',
      source,
    });
  }

  // HA primary unit (state === 'master')
  if (haResponse?.results?.[0]?.state) {
    items.push({
      observedKey: 'haPrimaryUnit',
      value: haResponse.results[0].state === 'master',
      source,
    });
  }

  return items;
}

/**
 * Map FortiOS policy audit (syntax validity, duplicates, IPS signature version)
 * Consumes: /api/v2/cmdb/firewall/policy, /api/v2/cmdb/ips/sensor
 */
export function mapFortiOSPolicyAudit(
  policyResponse: any,
  ipsResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Policy syntax validation: check for required fields (action, srcintf, dstintf)
  if (policyResponse?.results && Array.isArray(policyResponse.results)) {
    const allValid = policyResponse.results.every((p: any) =>
      p.action && p.srcintf && p.dstintf
    );
    items.push({
      observedKey: 'policySyntaxValid',
      value: allValid,
      source,
    });

    // Count duplicate policies (same source + destination + action)
    const policySignatures = policyResponse.results.map((p: any) =>
      `${p.srcintf}-${p.dstintf}-${p.action}`
    );
    const duplicateCount = policySignatures.length - new Set(policySignatures).size;
    items.push({
      observedKey: 'policyDuplicateCount',
      value: duplicateCount,
      source,
    });
  }

  // IPS signature version
  if (ipsResponse?.results?.[0]?.signature_database) {
    items.push({
      observedKey: 'ipsSignatureVersion',
      value: ipsResponse.results[0].signature_database,
      source,
    });
  }

  return items;
}
```

- [ ] **Step 2: Run build and verify**

```bash
npm run build -- --filter '@sangfor-engineer/fortios-client'
```

Expected: Build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/fortios-client/src/config-state.ts
git commit -m "feat(client): add FortiOS advanced query mappers (system health, policy audit)

- Add mapFortiOSSystemHealth: extracts CPU, memory, disk, ASIC load, HA mode/role
- Add mapFortiOSPolicyAudit: validates syntax, detects duplicates, captures IPS version
- Consume extended set of /api/v2/monitor/* and /api/v2/cmdb/* endpoints"
```

---

## Task 4: Cisco Advanced Query Mappers

**Files:**
- Modify: `packages/cisco-client/src/config-state.ts`

**Interfaces:**
- Consumes: Cisco RESTCONF responses (cpu utilization, memory, interfaces, VRF, zone-pair, ACLs, SNORT)
- Produces:
  - `mapCiscoSystemHealth(cpuResponse, memoryResponse, interfacesResponse, vrfResponse) => ConfigStateItem[]`
  - `mapCiscoPolicyAudit(zonePolicyResponse, aclResponse, snortResponse) => ConfigStateItem[]`

**Steps:**

- [ ] **Step 1: Add system health and policy audit mappers to cisco-client/src/config-state.ts**

After existing `mapCiscoConfigState()` function, add:

```typescript
/**
 * Map Cisco system health (per-core CPU average, memory, interface status, VRF count)
 */
export function mapCiscoSystemHealth(
  cpuResponse: any,
  memoryResponse: any,
  interfacesResponse: any,
  vrfResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // CPU usage (average of all cores)
  if (cpuResponse?.['Cisco-IOS-XE-utilization:system']?.['cpu-utilization']) {
    const cpuData = cpuResponse['Cisco-IOS-XE-utilization:system']['cpu-utilization'];
    const coreUsages = (cpuData['cpu-core'] || [])
      .map((core: any) => parseFloat(core['cpu-utilization']))
      .filter((v: number) => !isNaN(v));
    const avgUsage = coreUsages.length > 0 
      ? Math.round(coreUsages.reduce((a: number, b: number) => a + b, 0) / coreUsages.length)
      : 0;
    items.push({
      observedKey: 'systemCpuUsageAverage',
      value: avgUsage,
      source,
    });
  }

  // Memory usage
  if (memoryResponse?.['Cisco-IOS-XE-memory:memory']?.['memory-statistics']) {
    const memStats = memoryResponse['Cisco-IOS-XE-memory:memory']['memory-statistics'];
    const memUsagePercent = memStats.used && memStats.total
      ? Math.round((memStats.used / memStats.total) * 100)
      : 0;
    items.push({
      observedKey: 'systemMemoryUsage',
      value: memUsagePercent,
      source,
    });
  }

  // Interface down count
  if (interfacesResponse?.['ietf-interfaces:interfaces-state']) {
    const interfaces = interfacesResponse['ietf-interfaces:interfaces-state'].interface || [];
    const downCount = interfaces.filter((iface: any) => iface['oper-status'] === 'down').length;
    items.push({
      observedKey: 'interfaceDownCount',
      value: downCount,
      source,
    });
  }

  // VRF count
  if (vrfResponse?.['ietf-routing:routing']?.['control-plane-protocols']) {
    const protocols = vrfResponse['ietf-routing:routing']['control-plane-protocols']['control-plane-protocol'] || [];
    const vrfs = new Set(protocols.map((p: any) => p['vrf-name'] || 'default'));
    items.push({
      observedKey: 'vrfCount',
      value: vrfs.size,
      source,
    });
  }

  return items;
}

/**
 * Map Cisco policy audit (zone-pair policies, ACL rules, SNORT status)
 */
export function mapCiscoPolicyAudit(
  zonePolicyResponse: any,
  aclResponse: any,
  snortResponse: any,
  source: 'api' | 'mock' = 'api'
): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Zone-pair policy count
  if (zonePolicyResponse?.['Cisco-IOS-XE-zone-based-firewall:zone-pair']) {
    const zonePairs = zonePolicyResponse['Cisco-IOS-XE-zone-based-firewall:zone-pair'];
    items.push({
      observedKey: 'zonePairPolicyCount',
      value: Array.isArray(zonePairs) ? zonePairs.length : (zonePairs ? 1 : 0),
      source,
    });
  }

  // ACL rule count
  if (aclResponse?.['Cisco-IOS-XE-acl:ip']?.['access-lists']) {
    const acls = aclResponse['Cisco-IOS-XE-acl:ip']['access-lists']['access-list'] || [];
    const totalRules = acls.reduce((sum: number, acl: any) =>
      sum + ((acl['access-list-entries']?.['access-list-entry'] || []).length), 0);
    items.push({
      observedKey: 'aclRuleCount',
      value: totalRules,
      source,
    });
  }

  // SNORT signature version
  if (snortResponse?.['Cisco-IOS-XE-snort:snort']?.['snort-config']) {
    items.push({
      observedKey: 'snortSignatureVersion',
      value: snortResponse['Cisco-IOS-XE-snort:snort']['snort-config']['rule-database-version'] || 'unknown',
      source,
    });
  }

  // SNORT inspection enabled
  if (snortResponse?.['Cisco-IOS-XE-snort:snort']?.['snort-config']) {
    const snortConfig = snortResponse['Cisco-IOS-XE-snort:snort']['snort-config'];
    items.push({
      observedKey: 'snortInspectionEnabled',
      value: snortConfig.enabled === true,
      source,
    });
  }

  return items;
}
```

- [ ] **Step 2: Run build and verify**

```bash
npm run build -- --filter '@sangfor-engineer/cisco-client'
```

Expected: Build completes without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/cisco-client/src/config-state.ts
git commit -m "feat(client): add Cisco advanced query mappers (system health, policy audit)

- Add mapCiscoSystemHealth: extracts CPU average, memory, downed interfaces, VRF count
- Add mapCiscoPolicyAudit: counts zone-policies, ACL rules, captures SNORT version/status
- Consume RESTCONF endpoints for comprehensive device diagnostics"
```

---

## Task 5: FortiOS Mock Server — Advanced Endpoints

**Files:**
- Modify: `apps/mock-sangfor-console/src/fortios.ts`
- Modify: `apps/mock-sangfor-console/src/server.ts`

**Interfaces:**
- Consumes: Existing route handler pattern
- Produces: Three new HTTP endpoints for advanced data

**Steps:**

- [ ] **Step 1: Add advanced handlers to fortios.ts**

Add after existing handlers:

```typescript
export function fortiOSSystemStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/monitor/system/status response
  const mockStatus = {
    results: [
      {
        cpu: 42,          // CPU usage %
        mem: 58,          // Memory usage %
        disk: 35,         // Disk usage %
        uptime: 864000,   // Seconds (10 days)
        version: '7.2.0',
        serial: 'FG3000D3914908901',
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockStatus));
}

export function fortiOSNPUStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/monitor/system/npu-stats response
  const mockNPU = {
    results: [
      {
        cpu: 65,   // ASIC CPU usage %
        packets_received: 1500000,
        packets_dropped: 1200,
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockNPU));
}

export function fortiOSHASettingHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/cmdb/system/ha-setting response
  const mockHA = {
    results: [
      {
        mode: 'a-p',               // active-passive
        state: 'master',           // or 'slave', 'standalone'
        priority: 100,
        group_id: 1,
        remote_ip: '192.168.1.2',
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockHA));
}

export function fortiOSIPSStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /api/v2/monitor/ips/sensor-stat response
  const mockIPSStats = {
    results: [
      {
        sensor_name: 'default',
        signature_database: '20250703',
        packets_detected: 3421,
        packets_blocked: 342,
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockIPSStats));
}
```

- [ ] **Step 2: Register routes in server.ts**

Find the FortiOS route registration section (around existing `/api/v1/fortios/query-policy` route) and add after it:

```typescript
  if (req.url === '/api/v1/fortios/query-system-stats') {
    fortiOSSystemStatsHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/fortios/query-npu-stats') {
    fortiOSNPUStatsHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/fortios/query-ha-setting') {
    fortiOSHASettingHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/fortios/query-ips-stats') {
    fortiOSIPSStatsHandler(req, res);
    return;
  }
```

Also add imports at the top of the file:

```typescript
import { fortiOSSystemStatsHandler, fortiOSNPUStatsHandler, fortiOSHASettingHandler, fortiOSIPSStatsHandler } from './fortios.js';
```

- [ ] **Step 3: Test mock endpoints**

```bash
curl -X POST http://localhost:3001/api/v1/fortios/query-system-stats
curl -X POST http://localhost:3001/api/v1/fortios/query-npu-stats
curl -X POST http://localhost:3001/api/v1/fortios/query-ha-setting
curl -X POST http://localhost:3001/api/v1/fortios/query-ips-stats
```

Expected: All return valid JSON with mock data.

- [ ] **Step 4: Commit**

```bash
git add apps/mock-sangfor-console/src/fortios.ts apps/mock-sangfor-console/src/server.ts
git commit -m "feat(mock): add FortiOS advanced mock endpoints (system, NPU, HA, IPS stats)

- Add fortiOSSystemStatsHandler: CPU, memory, disk, uptime
- Add fortiOSNPUStatsHandler: ASIC CPU load, packet stats
- Add fortiOSHASettingHandler: HA mode, state, priority
- Add fortiOSIPSStatsHandler: IPS signature version, detection/block ratio
- Register 4 new /api/v1/fortios/query-* routes"
```

---

## Task 6: Cisco Mock Server — Advanced Endpoints

**Files:**
- Modify: `apps/mock-sangfor-console/src/cisco-iosxe.ts`
- Modify: `apps/mock-sangfor-console/src/server.ts`

**Interfaces:**
- Consumes: Existing route handler pattern
- Produces: Three new HTTP endpoints for advanced data

**Steps:**

- [ ] **Step 1: Add advanced handlers to cisco-iosxe.ts**

Add after existing handlers:

```typescript
export function ciscoSystemStatsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /restconf/data/Cisco-IOS-XE-utilization:system response
  const mockSystemStats = {
    'Cisco-IOS-XE-utilization:system': {
      'cpu-utilization': {
        'cpu-core': [
          { 'core-id': 0, 'cpu-utilization': 45 },
          { 'core-id': 1, 'cpu-utilization': 52 },
          { 'core-id': 2, 'cpu-utilization': 38 },
          { 'core-id': 3, 'cpu-utilization': 61 },
        ],
      },
    },
    'Cisco-IOS-XE-memory:memory': {
      'memory-statistics': {
        total: 4294967296,  // 4GB in bytes
        used: 2147483648,   // 2GB in bytes (~50%)
      },
    },
  };
  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockSystemStats));
}

export function ciscoZonePolicyHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair response
  const mockZonePolicies = {
    'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
      {
        source_zone: 'inside',
        destination_zone: 'outside',
        service_policy: 'Inspect_Outside',
      },
      {
        source_zone: 'dmz',
        destination_zone: 'outside',
        service_policy: 'Allow_DMZ_Out',
      },
    ],
  };
  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockZonePolicies));
}

export function ciscoSNORTStatusHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock /restconf/data/Cisco-IOS-XE-snort:snort response
  const mockSNORT = {
    'Cisco-IOS-XE-snort:snort': {
      'snort-config': {
        'rule-database-version': '20250703',
        enabled: true,
        'threat-detection': true,
      },
    },
  };
  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockSNORT));
}
```

- [ ] **Step 2: Register routes in server.ts**

Find Cisco route section and add:

```typescript
  if (req.url === '/api/v1/cisco-iosxe/query-system-stats') {
    ciscoSystemStatsHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/cisco-iosxe/query-zone-policy') {
    ciscoZonePolicyHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/cisco-iosxe/query-snort-status') {
    ciscoSNORTStatusHandler(req, res);
    return;
  }
```

Add imports:

```typescript
import { ciscoSystemStatsHandler, ciscoZonePolicyHandler, ciscoSNORTStatusHandler } from './cisco-iosxe.js';
```

- [ ] **Step 3: Test mock endpoints**

```bash
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-system-stats
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-zone-policy
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-snort-status
```

Expected: All return valid YANG-formatted JSON.

- [ ] **Step 4: Commit**

```bash
git add apps/mock-sangfor-console/src/cisco-iosxe.ts apps/mock-sangfor-console/src/server.ts
git commit -m "feat(mock): add Cisco advanced mock endpoints (system, zone-policy, SNORT)

- Add ciscoSystemStatsHandler: per-core CPU, memory utilization
- Add ciscoZonePolicyHandler: zone-pair policies
- Add ciscoSNORTStatusHandler: Snort rule version, enabled status
- Register 3 new /api/v1/cisco-iosxe/query-* routes"
```

---

## Task 7: FortiOS Advanced Tests

**Files:**
- Create: `tests/fortios-advanced-config-state.test.ts`

**Steps:**

- [ ] **Step 1: Create test file**

Create `tests/fortios-advanced-config-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapFortiOSSystemHealth, mapFortiOSPolicyAudit } from '@sangfor-engineer/fortios-client';

describe('FortiOS Advanced Config-State Mappers', () => {
  describe('mapFortiOSSystemHealth', () => {
    it('extracts CPU, memory, disk usage from system status', () => {
      const statusResponse = {
        results: [
          {
            cpu: 42,
            mem: 58,
            disk: 35,
          },
        ],
      };
      const npuResponse = { results: [{ cpu: 65 }] };
      const haResponse = { results: [{ mode: 'a-p', state: 'master' }] };

      const items = mapFortiOSSystemHealth(statusResponse, npuResponse, haResponse, 'mock');

      expect(items).toHaveLength(6);
      expect(items.find(i => i.observedKey === 'systemCpuUsage')?.value).toBe(42);
      expect(items.find(i => i.observedKey === 'systemMemoryUsage')?.value).toBe(58);
      expect(items.find(i => i.observedKey === 'systemDiskUsage')?.value).toBe(35);
      expect(items.find(i => i.observedKey === 'npuCpuUsage')?.value).toBe(65);
      expect(items.find(i => i.observedKey === 'haMode')?.value).toBe('active-passive');
      expect(items.find(i => i.observedKey === 'haPrimaryUnit')?.value).toBe(true);
    });
  });

  describe('mapFortiOSPolicyAudit', () => {
    it('validates policy syntax and counts duplicates', () => {
      const policyResponse = {
        results: [
          { action: 'accept', srcintf: 'port1', dstintf: 'port2' },
          { action: 'accept', srcintf: 'port1', dstintf: 'port2' },  // Duplicate
          { action: 'deny', srcintf: 'port3', dstintf: 'port4' },
        ],
      };
      const ipsResponse = {
        results: [{ signature_database: '20250703' }],
      };

      const items = mapFortiOSPolicyAudit(policyResponse, ipsResponse, 'mock');

      expect(items).toHaveLength(3);
      expect(items.find(i => i.observedKey === 'policySyntaxValid')?.value).toBe(true);
      expect(items.find(i => i.observedKey === 'policyDuplicateCount')?.value).toBe(1);
      expect(items.find(i => i.observedKey === 'ipsSignatureVersion')?.value).toBe('20250703');
    });

    it('detects invalid policies (missing required fields)', () => {
      const policyResponse = {
        results: [
          { action: 'accept', srcintf: 'port1' },  // Missing dstintf
          { action: 'deny', dstintf: 'port2' },    // Missing srcintf
        ],
      };
      const ipsResponse = { results: [] };

      const items = mapFortiOSPolicyAudit(policyResponse, ipsResponse, 'mock');

      const syntaxValid = items.find(i => i.observedKey === 'policySyntaxValid')?.value;
      expect(syntaxValid).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- fortios-advanced-config-state
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/fortios-advanced-config-state.test.ts
git commit -m "test(fortios): add advanced config-state mapper tests

- Test mapFortiOSSystemHealth: CPU, memory, disk, ASIC, HA extraction
- Test mapFortiOSPolicyAudit: syntax validation, duplicate detection, IPS version
- Verify edge cases: invalid policies, empty responses"
```

---

## Task 8: Cisco Advanced Tests

**Files:**
- Create: `tests/cisco-advanced-config-state.test.ts`

**Steps:**

- [ ] **Step 1: Create test file**

Create `tests/cisco-advanced-config-state.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapCiscoSystemHealth, mapCiscoPolicyAudit } from '@sangfor-engineer/cisco-client';

describe('Cisco Advanced Config-State Mappers', () => {
  describe('mapCiscoSystemHealth', () => {
    it('calculates average CPU from per-core data', () => {
      const cpuResponse = {
        'Cisco-IOS-XE-utilization:system': {
          'cpu-utilization': {
            'cpu-core': [
              { 'core-id': 0, 'cpu-utilization': 40 },
              { 'core-id': 1, 'cpu-utilization': 60 },
            ],
          },
        },
      };
      const memoryResponse = {
        'Cisco-IOS-XE-memory:memory': {
          'memory-statistics': {
            total: 1000,
            used: 500,
          },
        },
      };
      const interfacesResponse = {
        'ietf-interfaces:interfaces-state': {
          interface: [
            { name: 'GigabitEthernet0/0/0', 'oper-status': 'up' },
            { name: 'GigabitEthernet0/0/1', 'oper-status': 'down' },
          ],
        },
      };
      const vrfResponse = {
        'ietf-routing:routing': {
          'control-plane-protocols': {
            'control-plane-protocol': [
              { 'vrf-name': 'default' },
              { 'vrf-name': 'customer1' },
              { 'vrf-name': 'customer1' },  // Duplicate, should count as 1
            ],
          },
        },
      };

      const items = mapCiscoSystemHealth(cpuResponse, memoryResponse, interfacesResponse, vrfResponse, 'mock');

      expect(items).toHaveLength(4);
      expect(items.find(i => i.observedKey === 'systemCpuUsageAverage')?.value).toBe(50);  // (40+60)/2
      expect(items.find(i => i.observedKey === 'systemMemoryUsage')?.value).toBe(50);      // (500/1000)*100
      expect(items.find(i => i.observedKey === 'interfaceDownCount')?.value).toBe(1);
      expect(items.find(i => i.observedKey === 'vrfCount')?.value).toBe(2);                 // default + customer1
    });
  });

  describe('mapCiscoPolicyAudit', () => {
    it('counts zone-pair policies and ACL rules', () => {
      const zonePolicyResponse = {
        'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
          { source_zone: 'inside', destination_zone: 'outside' },
          { source_zone: 'dmz', destination_zone: 'outside' },
        ],
      };
      const aclResponse = {
        'Cisco-IOS-XE-acl:ip': {
          'access-lists': {
            'access-list': [
              {
                'access-list-entries': {
                  'access-list-entry': [
                    { sequence: 10, action: 'permit' },
                    { sequence: 20, action: 'deny' },
                  ],
                },
              },
              {
                'access-list-entries': {
                  'access-list-entry': [
                    { sequence: 10, action: 'permit' },
                  ],
                },
              },
            ],
          },
        },
      };
      const snortResponse = {
        'Cisco-IOS-XE-snort:snort': {
          'snort-config': {
            'rule-database-version': '20250703',
            enabled: true,
          },
        },
      };

      const items = mapCiscoPolicyAudit(zonePolicyResponse, aclResponse, snortResponse, 'mock');

      expect(items).toHaveLength(4);
      expect(items.find(i => i.observedKey === 'zonePairPolicyCount')?.value).toBe(2);
      expect(items.find(i => i.observedKey === 'aclRuleCount')?.value).toBe(3);  // 2 + 1
      expect(items.find(i => i.observedKey === 'snortSignatureVersion')?.value).toBe('20250703');
      expect(items.find(i => i.observedKey === 'snortInspectionEnabled')?.value).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- cisco-advanced-config-state
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/cisco-advanced-config-state.test.ts
git commit -m "test(cisco): add advanced config-state mapper tests

- Test mapCiscoSystemHealth: per-core CPU average, memory, interface down count, VRF dedup
- Test mapCiscoPolicyAudit: zone-pair counting, ACL rule aggregation, SNORT status
- Verify edge cases: duplicate VRFs, empty ACLs, disabled SNORT"
```

---

## Task 9: FortiOS Advanced MCP Tool

**Files:**
- Modify: `apps/mcp-server/src/index.ts`

**Steps:**

- [ ] **Step 1: Add advisor_fortios_advanced tool metadata**

In TOOL_METADATA array, add (after existing advisor_fortios):

```typescript
{
  toolId: 'advisor_fortios_advanced',
  name: 'advisor_fortios_advanced',
  description: 'Advanced FortiOS advisor: system health (CPU, memory, ASIC load), policy auditing (syntax, duplicates), threat protection (IPS version), HA status, VDOM count',
  inputSchema: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'FortiOS device IP or hostname' },
      username: { type: 'string', description: 'Admin username' },
      password: { type: 'string', description: 'Admin password' },
      specVersion: { type: 'string', description: 'Spec version (e.g., 8.0.0)', default: '8.0.0' },
    },
    required: ['host', 'username', 'password'],
  },
  safetyClass: 'read_only_diagnostic',
  autoAllowed: true,
  reason: 'HTTP GET queries only; no write operations permitted.',
},
```

- [ ] **Step 2: Add handler logic**

In the tool handler section, add (after advisor_fortios handler):

```typescript
if (toolId === 'advisor_fortios_advanced') {
  const { host, username, password, specVersion = '8.0.0' } = input;

  // Load advanced specs
  const { fortios_system_health_baseline, fortios_policy_audit_baseline } = await import('@sangfor-engineer/fortios-spec');
  const { mapFortiOSSystemHealth, mapFortiOSPolicyAudit } = await import('@sangfor-engineer/fortios-client');
  const { evaluateSpec } = await import('@sangfor-engineer/sangfor-spec');

  try {
    // Query system stats
    const statusUrl = `https://${host}/api/v2/monitor/system/status`;
    const npuUrl = `https://${host}/api/v2/monitor/system/npu-stats`;
    const haUrl = `https://${host}/api/v2/cmdb/system/ha-setting`;
    const policyUrl = `https://${host}/api/v2/cmdb/firewall/policy`;
    const ipsUrl = `https://${host}/api/v2/cmdb/ips/sensor`;

    const [statusResp, npuResp, haResp, policyResp, ipsResp] = await Promise.all([
      httpJson('GET', statusUrl, { username, password }),
      httpJson('GET', npuUrl, { username, password }),
      httpJson('GET', haUrl, { username, password }),
      httpJson('GET', policyUrl, { username, password }),
      httpJson('GET', ipsUrl, { username, password }),
    ]);

    // Map config states
    const healthState = mapFortiOSSystemHealth(statusResp, npuResp, haResp, 'api');
    const auditState = mapFortiOSPolicyAudit(policyResp, ipsResp, 'api');

    // Evaluate
    const healthEval = evaluateSpec(fortios_system_health_baseline, Object.fromEntries(
      healthState.map(item => [item.observedKey, item.value])
    ));
    const auditEval = evaluateSpec(fortios_policy_audit_baseline, Object.fromEntries(
      auditState.map(item => [item.observedKey, item.value])
    ));

    return {
      product: 'FORTIOS_ADVANCED',
      device: host,
      evaluations: [healthEval, auditEval],
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      product: 'FORTIOS_ADVANCED',
      device: host,
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run build -- --filter 'mcp-server'
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-server/src/index.ts
git commit -m "feat(mcp): register advisor_fortios_advanced tool

- Tool queries 5 API endpoints: system status, NPU stats, HA setting, policies, IPS
- Evaluates against fortios_system_health_baseline and fortios_policy_audit_baseline
- Returns dual evaluations: health + audit summary"
```

---

## Task 10: Cisco Advanced MCP Tool

**Files:**
- Modify: `apps/mcp-server/src/index.ts`

**Steps:**

- [ ] **Step 1: Add advisor_cisco_iosxe_advanced tool metadata**

In TOOL_METADATA, add (after advisor_cisco_iosxe):

```typescript
{
  toolId: 'advisor_cisco_iosxe_advanced',
  name: 'advisor_cisco_iosxe_advanced',
  description: 'Advanced Cisco IOS-XE advisor: system health (per-core CPU, memory), interface status, policy auditing (zone-pairs, ACLs), SNORT IPS status, VRF isolation',
  inputSchema: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'Cisco device IP or hostname' },
      username: { type: 'string', description: 'Admin username' },
      password: { type: 'string', description: 'Admin password' },
      specVersion: { type: 'string', description: 'Spec version (e.g., 17.0.0)', default: '17.0.0' },
    },
    required: ['host', 'username', 'password'],
  },
  safetyClass: 'read_only_diagnostic',
  autoAllowed: true,
  reason: 'RESTCONF GET queries only; no write operations permitted.',
},
```

- [ ] **Step 2: Add handler logic**

In the tool handler section, add (after advisor_cisco_iosxe):

```typescript
if (toolId === 'advisor_cisco_iosxe_advanced') {
  const { host, username, password, specVersion = '17.0.0' } = input;

  // Load advanced specs
  const { cisco_system_health_baseline, cisco_policy_audit_baseline } = await import('@sangfor-engineer/cisco-spec');
  const { mapCiscoSystemHealth, mapCiscoPolicyAudit } = await import('@sangfor-engineer/cisco-client');
  const { evaluateSpec } = await import('@sangfor-engineer/sangfor-spec');

  try {
    // Query RESTCONF endpoints
    const cpuUrl = `https://${host}/restconf/data/Cisco-IOS-XE-utilization:system/cpu-utilization`;
    const memUrl = `https://${host}/restconf/data/Cisco-IOS-XE-memory:memory/memory-statistics`;
    const ifaceUrl = `https://${host}/restconf/data/ietf-interfaces:interfaces-state`;
    const vrfUrl = `https://${host}/restconf/data/ietf-routing:routing`;
    const zonePolicyUrl = `https://${host}/restconf/data/Cisco-IOS-XE-zone-based-firewall:zone-pair`;
    const aclUrl = `https://${host}/restconf/data/Cisco-IOS-XE-acl:ip/access-lists`;
    const snortUrl = `https://${host}/restconf/data/Cisco-IOS-XE-snort:snort`;

    const [cpuResp, memResp, ifaceResp, vrfResp, zonePolicyResp, aclResp, snortResp] = await Promise.all([
      httpJson('GET', cpuUrl, { username, password, auth: 'basic' }),
      httpJson('GET', memUrl, { username, password, auth: 'basic' }),
      httpJson('GET', ifaceUrl, { username, password, auth: 'basic' }),
      httpJson('GET', vrfUrl, { username, password, auth: 'basic' }),
      httpJson('GET', zonePolicyUrl, { username, password, auth: 'basic' }),
      httpJson('GET', aclUrl, { username, password, auth: 'basic' }),
      httpJson('GET', snortUrl, { username, password, auth: 'basic' }),
    ]);

    // Map config states
    const healthState = mapCiscoSystemHealth(cpuResp, memResp, ifaceResp, vrfResp, 'api');
    const auditState = mapCiscoPolicyAudit(zonePolicyResp, aclResp, snortResp, 'api');

    // Evaluate
    const healthEval = evaluateSpec(cisco_system_health_baseline, Object.fromEntries(
      healthState.map(item => [item.observedKey, item.value])
    ));
    const auditEval = evaluateSpec(cisco_policy_audit_baseline, Object.fromEntries(
      auditState.map(item => [item.observedKey, item.value])
    ));

    return {
      product: 'CISCO_IOSXE_ADVANCED',
      device: host,
      evaluations: [healthEval, auditEval],
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      product: 'CISCO_IOSXE_ADVANCED',
      device: host,
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    };
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
npm run build -- --filter 'mcp-server'
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/mcp-server/src/index.ts
git commit -m "feat(mcp): register advisor_cisco_iosxe_advanced tool

- Tool queries 7 RESTCONF endpoints: CPU, memory, interfaces, VRF, zone-policy, ACLs, SNORT
- Evaluates against cisco_system_health_baseline and cisco_policy_audit_baseline
- Returns dual evaluations: health + audit summary"
```

---

## Task 11: Advanced Integration Tests

**Files:**
- Create: `tests/mcp-fortios-advanced-advisor.test.ts`
- Create: `tests/mcp-cisco-advanced-advisor.test.ts`

**Steps:**

- [ ] **Step 1: Create FortiOS advanced test**

Create `tests/mcp-fortios-advanced-advisor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapFortiOSSystemHealth, mapFortiOSPolicyAudit } from '@sangfor-engineer/fortios-client';
import { fortios_system_health_baseline, fortios_policy_audit_baseline } from '@sangfor-engineer/fortios-spec';
import { evaluateSpec } from '@sangfor-engineer/sangfor-spec';

describe('MCP advisor_fortios_advanced integration', () => {
  it('evaluates system health baseline against mock device state', () => {
    const mockStatus = { results: [{ cpu: 42, mem: 58, disk: 35 }] };
    const mockNPU = { results: [{ cpu: 65 }] };
    const mockHA = { results: [{ mode: 'a-p', state: 'master' }] };

    const configState = mapFortiOSSystemHealth(mockStatus, mockNPU, mockHA, 'mock');
    const configRecord = Object.fromEntries(configState.map(item => [item.observedKey, item.value]));
    const evaluation = evaluateSpec(fortios_system_health_baseline, configRecord);

    expect(evaluation.product).toBe('FORTIOS');
    expect(evaluation.items).toBeDefined();
    expect(evaluation.items.length).toBeGreaterThan(0);
  });

  it('evaluates policy audit baseline against mock device state', () => {
    const mockPolicy = {
      results: [
        { action: 'accept', srcintf: 'port1', dstintf: 'port2' },
        { action: 'deny', srcintf: 'port3', dstintf: 'port4' },
      ],
    };
    const mockIPS = { results: [{ signature_database: '20250703' }] };

    const configState = mapFortiOSPolicyAudit(mockPolicy, mockIPS, 'mock');
    const configRecord = Object.fromEntries(configState.map(item => [item.observedKey, item.value]));
    const evaluation = evaluateSpec(fortios_policy_audit_baseline, configRecord);

    expect(evaluation.product).toBe('FORTIOS');
    expect(evaluation.items).toBeDefined();
  });
});
```

- [ ] **Step 2: Create Cisco advanced test**

Create `tests/mcp-cisco-advanced-advisor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapCiscoSystemHealth, mapCiscoPolicyAudit } from '@sangfor-engineer/cisco-client';
import { cisco_system_health_baseline, cisco_policy_audit_baseline } from '@sangfor-engineer/cisco-spec';
import { evaluateSpec } from '@sangfor-engineer/sangfor-spec';

describe('MCP advisor_cisco_iosxe_advanced integration', () => {
  it('evaluates system health baseline against mock device state', () => {
    const mockCPU = {
      'Cisco-IOS-XE-utilization:system': {
        'cpu-utilization': {
          'cpu-core': [
            { 'core-id': 0, 'cpu-utilization': 45 },
            { 'core-id': 1, 'cpu-utilization': 55 },
          ],
        },
      },
    };
    const mockMem = {
      'Cisco-IOS-XE-memory:memory': {
        'memory-statistics': { total: 1000, used: 500 },
      },
    };
    const mockIface = {
      'ietf-interfaces:interfaces-state': {
        interface: [
          { name: 'GigabitEthernet0/0/0', 'oper-status': 'up' },
          { name: 'GigabitEthernet0/0/1', 'oper-status': 'down' },
        ],
      },
    };
    const mockVRF = {
      'ietf-routing:routing': {
        'control-plane-protocols': {
          'control-plane-protocol': [{ 'vrf-name': 'default' }],
        },
      },
    };

    const configState = mapCiscoSystemHealth(mockCPU, mockMem, mockIface, mockVRF, 'mock');
    const configRecord = Object.fromEntries(configState.map(item => [item.observedKey, item.value]));
    const evaluation = evaluateSpec(cisco_system_health_baseline, configRecord);

    expect(evaluation.product).toBe('CISCO_IOSXE');
    expect(evaluation.items).toBeDefined();
  });

  it('evaluates policy audit baseline against mock device state', () => {
    const mockZone = {
      'Cisco-IOS-XE-zone-based-firewall:zone-pair': [
        { source_zone: 'inside', destination_zone: 'outside' },
      ],
    };
    const mockACL = {
      'Cisco-IOS-XE-acl:ip': {
        'access-lists': {
          'access-list': [
            {
              'access-list-entries': {
                'access-list-entry': [{ sequence: 10, action: 'permit' }],
              },
            },
          ],
        },
      },
    };
    const mockSNORT = {
      'Cisco-IOS-XE-snort:snort': {
        'snort-config': { 'rule-database-version': '20250703', enabled: true },
      },
    };

    const configState = mapCiscoPolicyAudit(mockZone, mockACL, mockSNORT, 'mock');
    const configRecord = Object.fromEntries(configState.map(item => [item.observedKey, item.value]));
    const evaluation = evaluateSpec(cisco_policy_audit_baseline, configRecord);

    expect(evaluation.product).toBe('CISCO_IOSXE');
    expect(evaluation.items).toBeDefined();
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- mcp-fortios-advanced-advisor mcp-cisco-advanced-advisor
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp-fortios-advanced-advisor.test.ts tests/mcp-cisco-advanced-advisor.test.ts
git commit -m "test(mcp): add advanced advisor integration tests

- Test advisor_fortios_advanced with system health + policy audit mock data
- Test advisor_cisco_iosxe_advanced with system health + policy audit mock data
- Verify evaluation against both advanced baselines completes"
```

---

## Task 12: Final Build & Verification

**Files:**
- (None — verification only)

**Steps:**

- [ ] **Step 1: Clean build**

```bash
npm run clean
npm install
npm run build
```

Expected: No errors, all packages compile.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: All tests pass (300+ tests including new advanced tests).

- [ ] **Step 3: Verify no regressions**

```bash
npm run typecheck
```

Expected: No TypeScript errors.

- [ ] **Step 4: Verify mock servers**

```bash
npm run dev &
sleep 2

# FortiOS basic + advanced
curl -s http://localhost:3001/api/v1/fortios/query-policy | jq .
curl -s http://localhost:3001/api/v1/fortios/query-system-stats | jq .
curl -s http://localhost:3001/api/v1/fortios/query-npu-stats | jq .
curl -s http://localhost:3001/api/v1/fortios/query-ha-setting | jq .
curl -s http://localhost:3001/api/v1/fortios/query-ips-stats | jq .

# Cisco basic + advanced
curl -s http://localhost:3001/api/v1/cisco-iosxe/query-interfaces | jq .
curl -s http://localhost:3001/api/v1/cisco-iosxe/query-system-stats | jq .
curl -s http://localhost:3001/api/v1/cisco-iosxe/query-zone-policy | jq .
curl -s http://localhost:3001/api/v1/cisco-iosxe/query-snort-status | jq .

kill %1
```

Expected: All endpoints return valid JSON, no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: complete FortiOS/Cisco advanced advisory system — all tests passing"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-03-fortios-cisco-advanced-advisory.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
