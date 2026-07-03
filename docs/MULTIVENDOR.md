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
