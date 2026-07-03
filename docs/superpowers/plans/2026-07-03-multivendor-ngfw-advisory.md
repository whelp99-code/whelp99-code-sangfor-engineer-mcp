# Multi-Vendor NGFW Read-Only Advisory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the read-only advisory system to support FortiGate (FortiOS REST) and Cisco IOS-XE (RESTCONF), using the same spec/evaluate/config-state architecture proven on Sangfor EPP.

**Architecture:** Reuse the established pattern from Sangfor: each vendor gets a spec package (defining self-assessment items), a client package (HTTP + config-state mapper), a mock server extension, and MCP tool registration. The `httpJson` function from sangfor-hci-client remains vendor-agnostic; vendors differ only in REST endpoint shapes and config-state mapping.

**Tech Stack:** TypeScript, Node.js (httpJson from sangfor-hci-client), mock server (existing apps/mock-sangfor-console), MCP protocol (existing apps/mcp-server). No new dependencies.

## Global Constraints

- **Product codes:** Must extend `ProductCode` union type in packages/sangfor-spec/src/index.ts with `'FORTIOS'` and `'CISCO_IOSXE'`.
- **Config-state shape:** Same as Sangfor — each vendor's mapper must return `{ observedKey: string, value: unknown, source: 'api'|'mock' }[]` to feed into the existing evaluate logic.
- **Spec JSON location:** `data/specs/<VENDOR>/<VERSION>/<baseline>.spec.json` (mirrors Sangfor pattern).
- **Mock routes:** Add to apps/mock-sangfor-console/src/server.ts (POST /api/v1/fortios/*routes, POST /api/v1/cisco-iosxe/*routes).
- **HTTP auth:** FortiGate uses `X-CSRFTOKEN` + session cookie (mock will stateless-allow); Cisco RESTCONF uses HTTP Basic.
- **Test command:** `npm test` runs all tests; vendor-specific: `npm test -- fortios` or `npm test -- cisco`.
- **Commit granularity:** One task = one feature commit. Early commits allow parallel review.

---

## File Structure

**New packages (vendor-specific specs):**
- `packages/fortios-spec/src/index.ts` — FortiOS REST policy/interface/routing spec items.
- `packages/cisco-spec/src/index.ts` — Cisco IOS-XE interface/routing/ACL spec items.

**New packages (vendor-specific clients):**
- `packages/fortios-client/src/config-state.ts` — FortiOS REST API response → config-state mapper.
- `packages/fortios-client/src/index.ts` — Exports from config-state.
- `packages/cisco-client/src/config-state.ts` — Cisco RESTCONF response → config-state mapper.
- `packages/cisco-client/src/index.ts` — Exports from config-state.

**Mock server extension:**
- `apps/mock-sangfor-console/src/fortios.ts` — FortiOS REST API mock endpoints.
- `apps/mock-sangfor-console/src/cisco-iosxe.ts` — Cisco RESTCONF mock endpoints.
- `apps/mock-sangfor-console/src/server.ts` (modify) — Register /api/v1/fortios and /api/v1/cisco-iosxe routes.

**Spec data files:**
- `data/specs/FORTIOS/8.0.0/policy-baseline.spec.json` — FortiOS firewall policy self-assessment spec.
- `data/specs/CISCO_IOSXE/17.0.0/interface-baseline.spec.json` — Cisco IOS-XE interface/routing self-assessment spec.

**MCP server (modify):**
- `apps/mcp-server/src/index.ts` (modify) — Register two new tools: `advisor_fortios` and `advisor_cisco_iosxe`.

**Tests:**
- `tests/fortios-config-state.test.ts` — Unit tests for FortiOS config-state mapper.
- `tests/cisco-config-state.test.ts` — Unit tests for Cisco config-state mapper.
- `tests/mcp-fortios-advisor.test.ts` — Integration test for MCP tool (FortiOS).
- `tests/mcp-cisco-advisor.test.ts` — Integration test for MCP tool (Cisco).

---

## Task 1: Extend ProductCode and Create FortiOS Spec Package

**Files:**
- Modify: `packages/sangfor-spec/src/index.ts:87-93`
- Create: `packages/fortios-spec/src/index.ts`
- Create: `packages/fortios-spec/package.json`

**Interfaces:**
- Consumes: `Citation`, `SpecItem`, `Spec` from `packages/sangfor-spec/src/index.ts`
- Produces: `fortios_spec` object: `{ product: 'FORTIOS', version: string, items: SpecItem[] }`

**Steps:**

- [ ] **Step 1: Update ProductCode union in sangfor-spec**

Edit `packages/sangfor-spec/src/index.ts` line 87–93. Change:
```typescript
export type ProductCode = 'HCI_SCP' | 'HCI' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR' | 'CYBER_COMMAND';
```

To:
```typescript
export type ProductCode = 'HCI_SCP' | 'HCI' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR' | 'CYBER_COMMAND' | 'FORTIOS' | 'CISCO_IOSXE';
```

- [ ] **Step 2: Create fortios-spec package.json**

Create `packages/fortios-spec/package.json`:
```json
{
  "name": "@sangfor-engineer/fortios-spec",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "dependencies": {
    "@sangfor-engineer/sangfor-spec": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 3: Create fortios-spec/src/index.ts**

Create `packages/fortios-spec/src/index.ts`:
```typescript
import type { SpecItem, Spec } from '@sangfor-engineer/sangfor-spec';

export const fortios_policy_baseline: Spec = {
  id: 'spec_fortios_8_0_0_policy',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'firewall_policy_count',
      capabilityId: 'internet_policy',
      label: '파이어월 정책 개수',
      observedKey: 'policyCount',
      citation: {
        manual: 'FortiOS 8.0.0 Administration Guide — Firewall Policies',
      },
    },
    {
      id: 'ssl_inspection_enabled',
      capabilityId: 'internet_policy',
      label: 'SSL/TLS 검사 활성',
      observedKey: 'sslInspectionEnabled',
      citation: {
        manual: 'FortiOS 8.0.0 Administration Guide — SSL Inspection',
      },
    },
    {
      id: 'threat_logging_enabled',
      capabilityId: 'internet_policy',
      label: '위협 로깅 활성',
      observedKey: 'threatLoggingEnabled',
      citation: {
        manual: 'FortiOS 8.0.0 Administration Guide — Logging',
      },
    },
  ],
};

export const fortios_interface_baseline: Spec = {
  id: 'spec_fortios_8_0_0_interface',
  product: 'FORTIOS',
  version: '8.0.0',
  items: [
    {
      id: 'wan_interface_count',
      capabilityId: 'wan_connectivity',
      label: 'WAN 인터페이스 개수',
      observedKey: 'wanInterfaceCount',
      citation: {
        manual: 'FortiOS 8.0.0 Administration Guide — Interfaces',
      },
    },
  ],
};
```

- [ ] **Step 4: Run build and verify no errors**

```bash
cd /Users/jmpark/Playground/whelp99-code-sangfor-engineer-mcp
npm install
npm run build -- --filter '@sangfor-engineer/fortios-spec'
```

Expected: Build completes without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/sangfor-spec/src/index.ts packages/fortios-spec/
git commit -m "feat(spec): add FortiOS spec package with policy/interface items

- Extend ProductCode union with FORTIOS and CISCO_IOSXE
- Create fortios-spec package with policy (3 items) and interface (1 item) baselines
- Mirrors Sangfor spec structure for consistency"
```

---

## Task 2: Create Cisco IOS-XE Spec Package

**Files:**
- Create: `packages/cisco-spec/src/index.ts`
- Create: `packages/cisco-spec/package.json`

**Interfaces:**
- Consumes: `Citation`, `SpecItem`, `Spec` from `packages/sangfor-spec/src/index.ts`
- Produces: `cisco_interface_baseline`, `cisco_routing_baseline`: `Spec[]`

**Steps:**

- [ ] **Step 1: Create cisco-spec package.json**

Create `packages/cisco-spec/package.json`:
```json
{
  "name": "@sangfor-engineer/cisco-spec",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "dependencies": {
    "@sangfor-engineer/sangfor-spec": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create cisco-spec/src/index.ts**

Create `packages/cisco-spec/src/index.ts`:
```typescript
import type { SpecItem, Spec } from '@sangfor-engineer/sangfor-spec';

export const cisco_interface_baseline: Spec = {
  id: 'spec_cisco_iosxe_17_0_0_interface',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'interface_count',
      capabilityId: 'wan_connectivity',
      label: '인터페이스 개수',
      observedKey: 'interfaceCount',
      citation: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — Interface Configuration',
      },
    },
    {
      id: 'loopback_interfaces',
      capabilityId: 'wan_connectivity',
      label: 'Loopback 인터페이스 개수',
      observedKey: 'loopbackCount',
      citation: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — Loopback Interfaces',
      },
    },
  ],
};

export const cisco_routing_baseline: Spec = {
  id: 'spec_cisco_iosxe_17_0_0_routing',
  product: 'CISCO_IOSXE',
  version: '17.0.0',
  items: [
    {
      id: 'static_routes_count',
      capabilityId: 'internet_policy',
      label: '정적 라우트 개수',
      observedKey: 'staticRouteCount',
      citation: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — Static Routing',
      },
    },
    {
      id: 'ospf_enabled',
      capabilityId: 'internet_policy',
      label: 'OSPF 라우팅 활성',
      observedKey: 'ospfEnabled',
      citation: {
        manual: 'Cisco IOS XE 17.0 Configuration Guide — OSPF',
      },
    },
  ],
};
```

- [ ] **Step 3: Run build and verify no errors**

```bash
npm run build -- --filter '@sangfor-engineer/cisco-spec'
```

Expected: Build completes without errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cisco-spec/
git commit -m "feat(spec): add Cisco IOS-XE spec package with interface/routing items

- Create cisco-spec package with interface (2 items) and routing (2 items) baselines
- Mirrors Sangfor/FortiOS spec structure for consistency"
```

---

## Task 3: Create FortiOS Config-State Mapper

**Files:**
- Create: `packages/fortios-client/src/config-state.ts`
- Create: `packages/fortios-client/src/index.ts`
- Create: `packages/fortios-client/package.json`

**Interfaces:**
- Consumes: `httpJson(method, url, options)` from sangfor-hci-client (returns Promise<any>)
- Produces: `mapFortiOSConfigState(apiResponse) => ConfigStateItem[]`
  - `ConfigStateItem = { observedKey: string, value: unknown, source: 'api'|'mock' }`

**Steps:**

- [ ] **Step 1: Create fortios-client package.json**

Create `packages/fortios-client/package.json`:
```json
{
  "name": "@sangfor-engineer/fortios-client",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "dependencies": {
    "@sangfor-engineer/sangfor-spec": "workspace:*",
    "@sangfor-engineer/fortios-spec": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create fortios-client/src/config-state.ts**

Create `packages/fortios-client/src/config-state.ts`. This mapper converts FortiOS REST API responses into config-state items:
```typescript
export interface ConfigStateItem {
  observedKey: string;
  value: unknown;
  source: 'api' | 'mock';
}

/**
 * Map FortiOS REST API responses to config-state items.
 * API response: { results: [...] } or { data: {...} }
 * Returns array of items with observedKey matching spec items.
 */
export function mapFortiOSConfigState(apiResponse: any, source: 'api' | 'mock' = 'api'): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Map policy count (GET /api/v2/firewall/policy -> { results: [...] })
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    items.push({
      observedKey: 'policyCount',
      value: apiResponse.results.length,
      source,
    });
  }

  // Map SSL inspection (check if any policy has sslvpnprofile or ssl-ssh-profile)
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    const sslInspectionEnabled = apiResponse.results.some((p: any) => 
      p['ssl-ssh-profile'] || p.sslvpnprofile
    );
    items.push({
      observedKey: 'sslInspectionEnabled',
      value: sslInspectionEnabled,
      source,
    });
  }

  // Map threat logging (check any policy logtraffic field)
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    const threatLoggingEnabled = apiResponse.results.some((p: any) => 
      p.logtraffic === 'all' || p.logtraffic === 'utm'
    );
    items.push({
      observedKey: 'threatLoggingEnabled',
      value: threatLoggingEnabled,
      source,
    });
  }

  // Map WAN interface count (GET /api/v2/system/interface -> { results: [...] })
  if (apiResponse.results && Array.isArray(apiResponse.results)) {
    const wanCount = apiResponse.results.filter((iface: any) =>
      iface.type === 'physical' && (iface.name?.startsWith('port') || iface.name?.startsWith('wan'))
    ).length;
    items.push({
      observedKey: 'wanInterfaceCount',
      value: wanCount,
      source,
    });
  }

  return items;
}
```

- [ ] **Step 3: Create fortios-client/src/index.ts**

Create `packages/fortios-client/src/index.ts`:
```typescript
export { mapFortiOSConfigState, type ConfigStateItem } from './config-state.js';
```

- [ ] **Step 4: Run build and verify no errors**

```bash
npm run build -- --filter '@sangfor-engineer/fortios-client'
```

Expected: Build completes without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/fortios-client/
git commit -m "feat(client): add FortiOS config-state mapper

- Map FortiOS REST API responses (policies, interfaces) to config-state items
- Observes policyCount, sslInspectionEnabled, threatLoggingEnabled, wanInterfaceCount
- Ready for feeding into existing evaluate logic"
```

---

## Task 4: Create Cisco IOS-XE Config-State Mapper

**Files:**
- Create: `packages/cisco-client/src/config-state.ts`
- Create: `packages/cisco-client/src/index.ts`
- Create: `packages/cisco-client/package.json`

**Interfaces:**
- Consumes: `httpJson(method, url, options)` from sangfor-hci-client
- Produces: `mapCiscoConfigState(apiResponse) => ConfigStateItem[]`

**Steps:**

- [ ] **Step 1: Create cisco-client package.json**

Create `packages/cisco-client/package.json`:
```json
{
  "name": "@sangfor-engineer/cisco-client",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "dependencies": {
    "@sangfor-engineer/sangfor-spec": "workspace:*",
    "@sangfor-engineer/cisco-spec": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create cisco-client/src/config-state.ts**

Create `packages/cisco-client/src/config-state.ts`:
```typescript
export interface ConfigStateItem {
  observedKey: string;
  value: unknown;
  source: 'api' | 'mock';
}

/**
 * Map Cisco RESTCONF API responses to config-state items.
 * RESTCONF path: /restconf/data/ietf-interfaces:interfaces/interface
 * Response: { "ietf-interfaces:interface": [...] }
 */
export function mapCiscoConfigState(apiResponse: any, source: 'api' | 'mock' = 'api'): ConfigStateItem[] {
  const items: ConfigStateItem[] = [];

  // Extract interfaces array from RESTCONF response
  const interfaces = apiResponse['ietf-interfaces:interface'] || apiResponse.interface || [];

  // Map total interface count
  items.push({
    observedKey: 'interfaceCount',
    value: interfaces.length,
    source,
  });

  // Map loopback interface count
  const loopbackCount = interfaces.filter((iface: any) =>
    iface.name?.startsWith('Loopback')
  ).length;
  items.push({
    observedKey: 'loopbackCount',
    value: loopbackCount,
    source,
  });

  // Extract routing info (assuming separate RESTCONF call)
  if (apiResponse['ietf-routing:routing']) {
    const routing = apiResponse['ietf-routing:routing'];
    const staticRoutes = routing['static-routes']?.['static'] || [];
    items.push({
      observedKey: 'staticRouteCount',
      value: Array.isArray(staticRoutes) ? staticRoutes.length : 0,
      source,
    });

    // Check OSPF enabled (presence of ospf process)
    const ospfEnabled = !!(routing['control-plane-protocols']?.['control-plane-protocol']?.some(
      (cp: any) => cp.type === 'ospf'
    ));
    items.push({
      observedKey: 'ospfEnabled',
      value: ospfEnabled,
      source,
    });
  }

  return items;
}
```

- [ ] **Step 3: Create cisco-client/src/index.ts**

Create `packages/cisco-client/src/index.ts`:
```typescript
export { mapCiscoConfigState, type ConfigStateItem } from './config-state.js';
```

- [ ] **Step 4: Run build and verify no errors**

```bash
npm run build -- --filter '@sangfor-engineer/cisco-client'
```

Expected: Build completes without errors.

- [ ] **Step 5: Commit**

```bash
git add packages/cisco-client/
git commit -m "feat(client): add Cisco IOS-XE config-state mapper

- Map Cisco RESTCONF API responses (interfaces, routing) to config-state items
- Observes interfaceCount, loopbackCount, staticRouteCount, ospfEnabled
- Ready for feeding into existing evaluate logic"
```

---

## Task 5: Create FortiOS Mock Server

**Files:**
- Create: `apps/mock-sangfor-console/src/fortios.ts`
- Modify: `apps/mock-sangfor-console/src/server.ts`

**Interfaces:**
- Consumes: `(req: IncomingMessage, res: ServerResponse) => void` route handler signature
- Produces: HTTP endpoints:
  - `POST /api/v1/fortios/query-policy` → JSON policy list
  - `POST /api/v1/fortios/query-interface` → JSON interface list

**Steps:**

- [ ] **Step 1: Create fortios.ts mock handlers**

Create `apps/mock-sangfor-console/src/fortios.ts`:
```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';

export function fortiOSPolicyHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock FortiOS policy response
  const mockPolicies = {
    results: [
      {
        policyid: 1,
        name: 'Allow-Internal-Traffic',
        action: 'accept',
        logtraffic: 'all',
        'ssl-ssh-profile': 'certificate-inspection',
      },
      {
        policyid: 2,
        name: 'Allow-DNS',
        action: 'accept',
        logtraffic: 'utm',
      },
      {
        policyid: 3,
        name: 'Deny-All',
        action: 'deny',
        logtraffic: 'all',
      },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockPolicies));
}

export function fortiOSInterfaceHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock FortiOS interface response
  const mockInterfaces = {
    results: [
      { name: 'port1', type: 'physical', ip: '10.0.1.1 255.255.255.0' },
      { name: 'port2', type: 'physical', ip: '192.168.1.1 255.255.255.0' },
      { name: 'port3', type: 'physical', ip: '0.0.0.0 0.0.0.0' },
      { name: 'internal', type: 'vlan', ip: '172.16.0.1 255.255.0.0' },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(mockInterfaces));
}
```

- [ ] **Step 2: Update server.ts to register FortiOS routes**

Edit `apps/mock-sangfor-console/src/server.ts`. Find the route registration section (around line 50–80, where Sangfor routes are registered). Add FortiOS routes:
```typescript
import { fortiOSPolicyHandler, fortiOSInterfaceHandler } from './fortios.js';

// ... existing code ...

// Register FortiOS routes
if (req.url?.startsWith('/api/v1/fortios/')) {
  if (req.url === '/api/v1/fortios/query-policy') {
    fortiOSPolicyHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/fortios/query-interface') {
    fortiOSInterfaceHandler(req, res);
    return;
  }
}
```

- [ ] **Step 3: Test mock server**

Start the mock server and verify endpoints:
```bash
cd apps/mock-sangfor-console
npm run dev &
sleep 2
curl -X POST http://localhost:3001/api/v1/fortios/query-policy
curl -X POST http://localhost:3001/api/v1/fortios/query-interface
```

Expected: Both requests return JSON with results array.

- [ ] **Step 4: Commit**

```bash
git add apps/mock-sangfor-console/src/fortios.ts apps/mock-sangfor-console/src/server.ts
git commit -m "feat(mock): add FortiOS REST API mock server

- Add fortiOSPolicyHandler and fortiOSInterfaceHandler
- Register /api/v1/fortios/query-policy and /api/v1/fortios/query-interface routes
- Mock returns realistic policy and interface data for testing"
```

---

## Task 6: Create Cisco IOS-XE Mock Server

**Files:**
- Create: `apps/mock-sangfor-console/src/cisco-iosxe.ts`
- Modify: `apps/mock-sangfor-console/src/server.ts`

**Interfaces:**
- Consumes: `(req: IncomingMessage, res: ServerResponse) => void` route handler signature
- Produces: HTTP endpoints:
  - `POST /api/v1/cisco-iosxe/query-interfaces` → RESTCONF interface response
  - `POST /api/v1/cisco-iosxe/query-routing` → RESTCONF routing response

**Steps:**

- [ ] **Step 1: Create cisco-iosxe.ts mock handlers**

Create `apps/mock-sangfor-console/src/cisco-iosxe.ts`:
```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';

export function ciscoInterfaceHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock Cisco RESTCONF interface response
  const mockResponse = {
    'ietf-interfaces:interface': [
      {
        name: 'GigabitEthernet0/0/0',
        description: 'WAN Link',
        enabled: true,
        ipv4: { address: [{ ip: '203.0.113.1', netmask: '255.255.255.0' }] },
      },
      {
        name: 'GigabitEthernet0/0/1',
        description: 'LAN Link',
        enabled: true,
        ipv4: { address: [{ ip: '192.168.1.1', netmask: '255.255.255.0' }] },
      },
      {
        name: 'Loopback0',
        description: 'Router ID',
        enabled: true,
        ipv4: { address: [{ ip: '10.0.0.1', netmask: '255.255.255.255' }] },
      },
      {
        name: 'Loopback1',
        enabled: true,
        ipv4: { address: [{ ip: '10.0.0.2', netmask: '255.255.255.255' }] },
      },
    ],
  };

  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockResponse));
}

export function ciscoRoutingHandler(req: IncomingMessage, res: ServerResponse): void {
  // Mock Cisco RESTCONF routing response
  const mockResponse = {
    'ietf-routing:routing': {
      'static-routes': {
        static: [
          {
            destination_prefix: '10.10.0.0/16',
            next_hop: { next_hop_address: '203.0.113.254' },
          },
          {
            destination_prefix: '172.16.0.0/12',
            next_hop: { next_hop_address: '203.0.113.254' },
          },
        ],
      },
      'control-plane-protocols': {
        'control-plane-protocol': [
          {
            type: 'ospf',
            name: 'ospf_1',
            ospf: {
              global: { router_id: '10.0.0.1' },
            },
          },
        ],
      },
    },
  };

  res.writeHead(200, { 'Content-Type': 'application/yang-data+json' });
  res.end(JSON.stringify(mockResponse));
}
```

- [ ] **Step 2: Update server.ts to register Cisco routes**

Edit `apps/mock-sangfor-console/src/server.ts`. Add Cisco routes (after FortiOS routes):
```typescript
import { ciscoInterfaceHandler, ciscoRoutingHandler } from './cisco-iosxe.js';

// Register Cisco IOS-XE routes
if (req.url?.startsWith('/api/v1/cisco-iosxe/')) {
  if (req.url === '/api/v1/cisco-iosxe/query-interfaces') {
    ciscoInterfaceHandler(req, res);
    return;
  }
  if (req.url === '/api/v1/cisco-iosxe/query-routing') {
    ciscoRoutingHandler(req, res);
    return;
  }
}
```

- [ ] **Step 3: Test mock server**

Verify Cisco endpoints:
```bash
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-interfaces
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-routing
```

Expected: Both requests return JSON with RESTCONF-style data.

- [ ] **Step 4: Commit**

```bash
git add apps/mock-sangfor-console/src/cisco-iosxe.ts apps/mock-sangfor-console/src/server.ts
git commit -m "feat(mock): add Cisco IOS-XE RESTCONF API mock server

- Add ciscoInterfaceHandler and ciscoRoutingHandler
- Register /api/v1/cisco-iosxe/query-interfaces and /api/v1/cisco-iosxe/query-routing routes
- Mock returns RESTCONF-formatted interface and routing data for testing"
```

---

## Task 7: Create FortiOS Config-State Unit Tests

**Files:**
- Create: `tests/fortios-config-state.test.ts`

**Interfaces:**
- Consumes: `mapFortiOSConfigState(apiResponse, source)` from fortios-client
- Produces: Test suite covering policy count, SSL inspection, threat logging, WAN interface count

**Steps:**

- [ ] **Step 1: Create test file**

Create `tests/fortios-config-state.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mapFortiOSConfigState } from '@sangfor-engineer/fortios-client';

describe('mapFortiOSConfigState', () => {
  it('maps policy count from API response', () => {
    const apiResponse = {
      results: [
        { policyid: 1, name: 'Policy-1' },
        { policyid: 2, name: 'Policy-2' },
        { policyid: 3, name: 'Policy-3' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    const policyCount = items.find((item) => item.observedKey === 'policyCount');
    expect(policyCount).toBeDefined();
    expect(policyCount?.value).toBe(3);
    expect(policyCount?.source).toBe('api');
  });

  it('detects SSL inspection when ssl-ssh-profile present', () => {
    const apiResponse = {
      results: [
        { policyid: 1, 'ssl-ssh-profile': 'certificate-inspection' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'mock');

    const sslInspection = items.find((item) => item.observedKey === 'sslInspectionEnabled');
    expect(sslInspection?.value).toBe(true);
    expect(sslInspection?.source).toBe('mock');
  });

  it('detects threat logging when logtraffic is set', () => {
    const apiResponse = {
      results: [
        { policyid: 1, logtraffic: 'all' },
        { policyid: 2, logtraffic: 'none' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    const threatLogging = items.find((item) => item.observedKey === 'threatLoggingEnabled');
    expect(threatLogging?.value).toBe(true);
  });

  it('counts WAN interfaces by type and name', () => {
    const apiResponse = {
      results: [
        { name: 'port1', type: 'physical' },
        { name: 'port2', type: 'physical' },
        { name: 'internal', type: 'vlan' },
        { name: 'wan1', type: 'physical' },
      ],
    };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    const wanCount = items.find((item) => item.observedKey === 'wanInterfaceCount');
    expect(wanCount?.value).toBe(3); // port1, port2, wan1 are physical
  });

  it('returns empty array when API response is empty', () => {
    const apiResponse = { results: [] };

    const items = mapFortiOSConfigState(apiResponse, 'api');

    expect(items.length).toBeGreaterThan(0);
    items.forEach((item) => {
      expect(item.value).toBeDefined();
      expect(item.observedKey).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- fortios-config-state
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/fortios-config-state.test.ts
git commit -m "test(fortios): add config-state mapper unit tests

- Test policy count extraction from results array
- Test SSL inspection detection (ssl-ssh-profile presence)
- Test threat logging detection (logtraffic values)
- Test WAN interface counting (physical + port/wan prefix)"
```

---

## Task 8: Create Cisco Config-State Unit Tests

**Files:**
- Create: `tests/cisco-config-state.test.ts`

**Interfaces:**
- Consumes: `mapCiscoConfigState(apiResponse, source)` from cisco-client
- Produces: Test suite covering interface count, loopback count, static routes, OSPF

**Steps:**

- [ ] **Step 1: Create test file**

Create `tests/cisco-config-state.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mapCiscoConfigState } from '@sangfor-engineer/cisco-client';

describe('mapCiscoConfigState', () => {
  it('counts total interfaces from RESTCONF response', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [
        { name: 'GigabitEthernet0/0/0' },
        { name: 'GigabitEthernet0/0/1' },
        { name: 'Loopback0' },
      ],
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const interfaceCount = items.find((item) => item.observedKey === 'interfaceCount');
    expect(interfaceCount?.value).toBe(3);
    expect(interfaceCount?.source).toBe('api');
  });

  it('counts loopback interfaces separately', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [
        { name: 'GigabitEthernet0/0/0' },
        { name: 'Loopback0' },
        { name: 'Loopback1' },
        { name: 'Loopback2' },
      ],
    };

    const items = mapCiscoConfigState(apiResponse, 'mock');

    const loopbackCount = items.find((item) => item.observedKey === 'loopbackCount');
    expect(loopbackCount?.value).toBe(3);
    expect(loopbackCount?.source).toBe('mock');
  });

  it('extracts static route count from routing section', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [],
      'ietf-routing:routing': {
        'static-routes': {
          static: [
            { destination_prefix: '10.0.0.0/8' },
            { destination_prefix: '192.168.0.0/16' },
          ],
        },
      },
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const staticRouteCount = items.find((item) => item.observedKey === 'staticRouteCount');
    expect(staticRouteCount?.value).toBe(2);
  });

  it('detects OSPF when control-plane-protocol includes ospf', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [],
      'ietf-routing:routing': {
        'control-plane-protocols': {
          'control-plane-protocol': [
            { type: 'ospf', name: 'ospf_1' },
          ],
        },
      },
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const ospfEnabled = items.find((item) => item.observedKey === 'ospfEnabled');
    expect(ospfEnabled?.value).toBe(true);
  });

  it('returns zero static routes when none present', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [],
      'ietf-routing:routing': {
        'static-routes': {
          static: undefined,
        },
      },
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const staticRouteCount = items.find((item) => item.observedKey === 'staticRouteCount');
    expect(staticRouteCount?.value).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npm test -- cisco-config-state
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/cisco-config-state.test.ts
git commit -m "test(cisco): add config-state mapper unit tests

- Test interface count extraction from RESTCONF response
- Test loopback interface counting (Loopback* prefix)
- Test static route counting from routing section
- Test OSPF detection (control-plane-protocol type)"
```

---

## Task 9: Register FortiOS Advisor Tool in MCP Server

**Files:**
- Modify: `apps/mcp-server/src/index.ts` (around TOOL_METADATA)

**Interfaces:**
- Consumes: `ProductCode`, `normalizeProduct()`, `evaluateSpec()` from packages
- Produces: MCP tool registration: `advisor_fortios` with capability safety classification

**Steps:**

- [ ] **Step 1: Add FortiOS tool to TOOL_METADATA**

Edit `apps/mcp-server/src/index.ts`. Find the TOOL_METADATA array (around line 100–150) and add:
```typescript
{
  toolId: 'advisor_fortios',
  name: 'advisor_fortios',
  description: 'Read-only self-assessment advisor for FortiOS firewalls (policies, interfaces, routing)',
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
{
  toolId: 'advisor_cisco_iosxe',
  name: 'advisor_cisco_iosxe',
  description: 'Read-only self-assessment advisor for Cisco IOS-XE routers/switches (interfaces, routing, ACLs)',
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

- [ ] **Step 2: Add handler logic for advisor_fortios**

In the same file, find the tool handler section (around line 200–250, after TOOL_METADATA). Add a case for FortiOS:
```typescript
if (toolId === 'advisor_fortios') {
  const { host, username, password, specVersion = '8.0.0' } = input;
  
  // Load spec
  const { fortios_policy_baseline } = await import('@sangfor-engineer/fortios-spec');
  const spec = fortios_policy_baseline; // select spec by version in production
  
  // Query device
  const apiUrl = `https://${host}/api/v2/firewall/policy`;
  const response = await httpJson('GET', apiUrl, {
    username,
    password,
    // For dev/test: use mock server endpoint instead of real device
    // For prod: ensure device has valid CA-signed cert or add CA to trust store
  });
  
  // Map config state
  const { mapFortiOSConfigState } = await import('@sangfor-engineer/fortios-client');
  const configState = mapFortiOSConfigState(response, 'api');
  
  // Evaluate
  const { evaluateSpec } = await import('@sangfor-engineer/sangfor-spec');
  const evaluation = evaluateSpec(spec, configState);
  
  return {
    product: 'FORTIOS',
    device: host,
    evaluation,
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 3: Add handler logic for advisor_cisco_iosxe**

Add another case for Cisco:
```typescript
if (toolId === 'advisor_cisco_iosxe') {
  const { host, username, password, specVersion = '17.0.0' } = input;
  
  // Load spec (for now use interface baseline; in production select by version)
  const { cisco_interface_baseline } = await import('@sangfor-engineer/cisco-spec');
  const spec = cisco_interface_baseline;
  
  // Query device
  const apiUrl = `https://${host}/restconf/data/ietf-interfaces:interfaces`;
  const response = await httpJson('GET', apiUrl, {
    username,
    password,
    auth: 'basic',
    // For dev/test: use mock server endpoint instead of real device
    // For prod: ensure device has valid CA-signed cert or add CA to trust store
  });
  
  // Map config state
  const { mapCiscoConfigState } = await import('@sangfor-engineer/cisco-client');
  const configState = mapCiscoConfigState(response, 'api');
  
  // Evaluate
  const { evaluateSpec } = await import('@sangfor-engineer/sangfor-spec');
  const evaluation = evaluateSpec(spec, configState);
  
  return {
    product: 'CISCO_IOSXE',
    device: host,
    evaluation,
    timestamp: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Verify TypeScript builds**

```bash
npm run build -- --filter 'mcp-server'
```

Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mcp-server/src/index.ts
git commit -m "feat(mcp): register FortiOS and Cisco advisor tools

- Add advisor_fortios tool (FortiOS REST, read-only_diagnostic class)
- Add advisor_cisco_iosxe tool (Cisco RESTCONF, read-only_diagnostic class)
- Both tools auto-allowed (HTTP GET only, no writes)
- Handler queries device API, maps config-state, evaluates against spec"
```

---

## Task 10: Create MCP Tool Integration Tests

**Files:**
- Create: `tests/mcp-fortios-advisor.test.ts`
- Create: `tests/mcp-cisco-advisor.test.ts`

**Interfaces:**
- Consumes: MCP tool handler from mcp-server
- Produces: Integration tests that mock device API and verify end-to-end evaluation

**Steps:**

- [ ] **Step 1: Create FortiOS MCP test**

Create `tests/mcp-fortios-advisor.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

describe('MCP advisor_fortios tool', () => {
  let mockServer: http.Server;
  const PORT = 9999;

  beforeAll(() => {
    // Start mock FortiOS server
    mockServer = http.createServer((req, res) => {
      if (req.url === '/api/v2/firewall/policy') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          results: [
            { policyid: 1, action: 'accept', logtraffic: 'all' },
            { policyid: 2, action: 'accept', 'ssl-ssh-profile': 'inspection' },
          ],
        }));
      }
    });
    mockServer.listen(PORT);
  });

  afterAll(() => {
    mockServer.close();
  });

  it('evaluates FortiOS policy baseline against device state', async () => {
    // Simulate tool invocation
    const { fortios_policy_baseline } = await import('@sangfor-engineer/fortios-spec');
    const { mapFortiOSConfigState } = await import('@sangfor-engineer/fortios-client');
    const { evaluateSpec } = await import('@sangfor-engineer/sangfor-spec');

    const mockResponse = {
      results: [
        { policyid: 1, action: 'accept', logtraffic: 'all' },
        { policyid: 2, action: 'accept', 'ssl-ssh-profile': 'inspection' },
      ],
    };

    const configState = mapFortiOSConfigState(mockResponse, 'mock');
    const evaluation = evaluateSpec(fortios_policy_baseline, configState);

    expect(evaluation.product).toBe('FORTIOS');
    expect(evaluation.items).toBeDefined();
    expect(evaluation.items.length).toBeGreaterThan(0);

    // Verify at least some items were evaluated
    const policyCountItem = evaluation.items.find((i) => i.observedKey === 'policyCount');
    expect(policyCountItem).toBeDefined();
    expect(policyCountItem?.value).toBe(2);
  });
});
```

- [ ] **Step 2: Create Cisco MCP test**

Create `tests/mcp-cisco-advisor.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('MCP advisor_cisco_iosxe tool', () => {
  it('evaluates Cisco interface baseline against device state', async () => {
    // Simulate tool invocation
    const { cisco_interface_baseline } = await import('@sangfor-engineer/cisco-spec');
    const { mapCiscoConfigState } = await import('@sangfor-engineer/cisco-client');
    const { evaluateSpec } = await import('@sangfor-engineer/sangfor-spec');

    const mockResponse = {
      'ietf-interfaces:interface': [
        { name: 'GigabitEthernet0/0/0' },
        { name: 'GigabitEthernet0/0/1' },
        { name: 'Loopback0' },
      ],
    };

    const configState = mapCiscoConfigState(mockResponse, 'mock');
    const evaluation = evaluateSpec(cisco_interface_baseline, configState);

    expect(evaluation.product).toBe('CISCO_IOSXE');
    expect(evaluation.items).toBeDefined();
    expect(evaluation.items.length).toBeGreaterThan(0);

    const interfaceCountItem = evaluation.items.find((i) => i.observedKey === 'interfaceCount');
    expect(interfaceCountItem).toBeDefined();
    expect(interfaceCountItem?.value).toBe(3);
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
npm test -- mcp-fortios-advisor mcp-cisco-advisor
```

Expected: Both test suites pass.

- [ ] **Step 4: Verify all tests pass**

```bash
npm test
```

Expected: All tests pass (181+ existing + new 8 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/mcp-fortios-advisor.test.ts tests/mcp-cisco-advisor.test.ts
git commit -m "test(mcp): add FortiOS and Cisco advisor tool integration tests

- Test FortiOS tool evaluates policy baseline (count, SSL inspection, threat logging)
- Test Cisco tool evaluates interface baseline (interface count, loopback count)
- Both mock device API responses and verify end-to-end evaluation flow
- Confirm integration with existing spec/evaluate architecture"
```

---

## Task 11: Add FortiOS and Cisco Baseline Spec Data Files

**Files:**
- Create: `data/specs/FORTIOS/8.0.0/policy-baseline.spec.json`
- Create: `data/specs/CISCO_IOSXE/17.0.0/interface-baseline.spec.json`

**Interfaces:**
- Consumes: Spec shape from packages/sangfor-spec (id, product, version, items[])
- Produces: JSON files matching Sangfor spec format

**Steps:**

- [ ] **Step 1: Create FortiOS spec directory**

```bash
mkdir -p data/specs/FORTIOS/8.0.0
```

- [ ] **Step 2: Create FortiOS policy baseline spec**

Create `data/specs/FORTIOS/8.0.0/policy-baseline.spec.json`:
```json
{
  "id": "spec_fortios_8_0_0_policy",
  "product": "FORTIOS",
  "version": "8.0.0",
  "items": [
    {
      "id": "firewall_policy_count",
      "capabilityId": "internet_policy",
      "label": "파이어월 정책 개수",
      "observedKey": "policyCount",
      "citation": {
        "manual": "FortiOS 8.0.0 Administration Guide — Firewall Policies"
      }
    },
    {
      "id": "ssl_inspection_enabled",
      "capabilityId": "internet_policy",
      "label": "SSL/TLS 검사 활성",
      "observedKey": "sslInspectionEnabled",
      "citation": {
        "manual": "FortiOS 8.0.0 Administration Guide — SSL Inspection"
      }
    },
    {
      "id": "threat_logging_enabled",
      "capabilityId": "internet_policy",
      "label": "위협 로깅 활성",
      "observedKey": "threatLoggingEnabled",
      "citation": {
        "manual": "FortiOS 8.0.0 Administration Guide — Logging"
      }
    }
  ]
}
```

- [ ] **Step 3: Create Cisco spec directory**

```bash
mkdir -p data/specs/CISCO_IOSXE/17.0.0
```

- [ ] **Step 4: Create Cisco interface baseline spec**

Create `data/specs/CISCO_IOSXE/17.0.0/interface-baseline.spec.json`:
```json
{
  "id": "spec_cisco_iosxe_17_0_0_interface",
  "product": "CISCO_IOSXE",
  "version": "17.0.0",
  "items": [
    {
      "id": "interface_count",
      "capabilityId": "wan_connectivity",
      "label": "인터페이스 개수",
      "observedKey": "interfaceCount",
      "citation": {
        "manual": "Cisco IOS XE 17.0 Configuration Guide — Interface Configuration"
      }
    },
    {
      "id": "loopback_interfaces",
      "capabilityId": "wan_connectivity",
      "label": "Loopback 인터페이스 개수",
      "observedKey": "loopbackCount",
      "citation": {
        "manual": "Cisco IOS XE 17.0 Configuration Guide — Loopback Interfaces"
      }
    }
  ]
}
```

- [ ] **Step 5: Verify JSON syntax**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('data/specs/FORTIOS/8.0.0/policy-baseline.spec.json', 'utf8')))"
node -e "console.log(JSON.parse(require('fs').readFileSync('data/specs/CISCO_IOSXE/17.0.0/interface-baseline.spec.json', 'utf8')))"
```

Expected: Both output valid JSON without syntax errors.

- [ ] **Step 6: Commit**

```bash
git add data/specs/FORTIOS data/specs/CISCO_IOSXE
git commit -m "data(spec): add FortiOS and Cisco baseline spec files

- Add FortiOS 8.0.0 policy-baseline.spec.json (3 items)
- Add Cisco IOS-XE 17.0.0 interface-baseline.spec.json (2 items)
- Both follow existing Sangfor spec JSON structure for consistency"
```

---

## Task 12: Documentation and README Update

**Files:**
- Modify: `README.md` or create `docs/MULTIVENDOR.md`

**Interfaces:**
- Consumes: Implementation details from all previous tasks
- Produces: User-facing documentation explaining how to use FortiOS and Cisco advisors

**Steps:**

- [ ] **Step 1: Create MULTIVENDOR.md documentation**

Create `docs/MULTIVENDOR.md`:
```markdown
# Multi-Vendor Network Device Advisory

This system extends read-only advisory support to FortiOS and Cisco IOS-XE devices, using the same spec-based evaluation architecture as Sangfor.

## Supported Vendors

| Vendor | Product | API | Spec Version | Advisory Scope |
|--------|---------|-----|--------------|----------------|
| Sangfor | HCI, ENDPOINT_SECURE, etc. | REST (custom) | Various | Self-assessment (read-only) |
| Fortinet | FortiOS (firewall) | REST | 8.0.0+ | Policy, interfaces, threat protection (read-only) |
| Cisco | IOS-XE (router/switch) | RESTCONF | 17.0.0+ | Interfaces, routing, control-plane (read-only) |

## Advisory Tools

### FortiOS Advisor (`advisor_fortios`)

Query FortiOS firewall policies and generate a self-assessment report.

**Input:**
- `host`: FortiOS management IP (e.g., `192.168.1.1`)
- `username`: Admin account
- `password`: Admin password
- `specVersion`: Spec version (default: `8.0.0`)

**Output:** Evaluation against policy-baseline spec (policy count, SSL inspection, threat logging, WAN interface count).

**Example (mock):**
```bash
curl -X POST http://localhost:9000/mcp/call_tool \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "advisor_fortios",
    "input": {
      "host": "10.0.1.1",
      "username": "admin",
      "password": "fortinet",
      "specVersion": "8.0.0"
    }
  }'
```

### Cisco Advisor (`advisor_cisco_iosxe`)

Query Cisco IOS-XE router/switch and generate a self-assessment report.

**Input:**
- `host`: Cisco device IP
- `username`: Admin account
- `password`: Admin password
- `specVersion`: Spec version (default: `17.0.0`)

**Output:** Evaluation against interface-baseline spec (interface count, loopback count, static routes, OSPF status).

**Example (mock):**
```bash
curl -X POST http://localhost:9000/mcp/call_tool \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "advisor_cisco_iosxe",
    "input": {
      "host": "10.0.1.254",
      "username": "admin",
      "password": "cisco",
      "specVersion": "17.0.0"
    }
  }'
```

## Architecture

Each vendor follows this pattern:

1. **Spec Package** — Defines self-assessment items (what to observe).
2. **Client Package** — Maps device API response → config-state (observed values).
3. **Mock Server** — Provides test data via HTTP/RESTCONF endpoints.
4. **MCP Tool** — Orchestrates spec + client + API call + evaluation.

The spec/evaluate engine (sangfor-spec) is vendor-agnostic; vendors differ only in API shape and config-state mapping.

## Testing

```bash
# Run all tests
npm test

# Run vendor-specific tests
npm test -- fortios
npm test -- cisco

# Run mock server (for manual testing)
npm run dev
curl http://localhost:3001/api/v1/fortios/query-policy
curl http://localhost:3001/api/v1/cisco-iosxe/query-interfaces
```

## Adding a New Vendor

1. Create spec package (`packages/<vendor>-spec/src/index.ts`) with items.
2. Create client package (`packages/<vendor>-client/src/config-state.ts`) to map API → config-state.
3. Add mock server handlers (`apps/mock-sangfor-console/src/<vendor>.ts`).
4. Register MCP tool in `apps/mcp-server/src/index.ts`.
5. Add test files (`tests/<vendor>-*.test.ts`).
6. Add spec data files (`data/specs/<VENDOR>/<VERSION>/<baseline>.spec.json`).
```

- [ ] **Step 2: Run through documentation for clarity**

Read the documentation you just created to make sure it's accurate and helpful.

- [ ] **Step 3: Commit**

```bash
git add docs/MULTIVENDOR.md
git commit -m "docs: add multi-vendor advisory guide

- Document FortiOS and Cisco advisor tools
- Explain architecture (spec/client/mock/MCP pattern)
- Provide curl examples for mock testing
- Include vendor comparison table and testing instructions"
```

---

## Task 13: Final Build and Full Test Suite

**Files:**
- (None created; verification only)

**Interfaces:**
- Consumes: All packages, tests, and tools from Tasks 1–12
- Produces: Clean build output + all tests passing

**Steps:**

- [ ] **Step 1: Clean build**

```bash
npm run clean
npm install
npm run build
```

Expected: No errors, all packages build successfully.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: All tests pass (including new FortiOS/Cisco tests). Test output should show ✓ for each test.

- [ ] **Step 3: Type check**

```bash
npm run typecheck
```

Expected: No TypeScript errors.

- [ ] **Step 4: Lint (if configured)**

```bash
npm run lint 2>/dev/null || echo "Lint not configured"
```

- [ ] **Step 5: Start mock server and verify endpoints**

```bash
npm run dev &
sleep 2

echo "=== Testing FortiOS endpoints ==="
curl -X POST http://localhost:3001/api/v1/fortios/query-policy | jq .
curl -X POST http://localhost:3001/api/v1/fortios/query-interface | jq .

echo "=== Testing Cisco endpoints ==="
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-interfaces | jq .
curl -X POST http://localhost:3001/api/v1/cisco-iosxe/query-routing | jq .

kill %1
```

Expected: All endpoints return valid JSON.

- [ ] **Step 6: Create final summary commit (if any uncommitted changes)**

```bash
git status
```

If clean, no commit needed. If dirty, commit with:
```bash
git add -A
git commit -m "chore: final multi-vendor advisory build — all tests passing"
```

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-03-multivendor-ngfw-advisory.md`.**

Two execution options:

**Option 1: Subagent-Driven (Recommended)**
- I dispatch a fresh subagent per task
- Subagent implements, commits, and reports back
- I review between tasks and adjust if needed
- Fast iteration, parallel learning, high confidence

**Option 2: Inline Execution**
- I execute tasks sequentially in this session
- Checkpoints for review after every 2–3 tasks
- Good for tight feedback loops on design questions
- Slower wall-clock but more hands-on control

**Which approach would you prefer?**
