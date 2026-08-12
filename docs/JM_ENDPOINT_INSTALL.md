# JM Endpoint Installation and Run Guide

How to turn an engineer workstation into a **JM endpoint** — the client-side browser execution
edge of Sangfor Engineer MCP.

JM is client-side. BLRO is the server-side authority for MCP, RAG, database, approvals, audit, and
evidence. Never install browser profiles or customer credentials on BLRO. See
[BLRO Authority Architecture](BLRO_AUTHORITY_ARCHITECTURE.md) for the ownership boundary and
[BLRO Operations Runbook](BLRO_OPERATIONS_RUNBOOK.md) for the server side.

For the per-operation checklist on the day of a change window, use
[User Intervention — JM Browser Runtime](USER_INTERVENTION_JM_BROWSER.md). This guide is the
one-time installation and routine verification path.

## What gets installed

| On the JM endpoint | Not on the JM endpoint |
|---|---|
| Node.js runtime and pnpm workspace | Authoritative database |
| Playwright-managed Chromium, or an approved system Chrome | RAG index of record |
| Project-scoped browser profiles and their cookies | Approval HMAC secret of record |
| Short-lived screenshots and temp artifacts | Audit ledger of record |
| The MCP stdio server for the local client | Evidence archive of record |

Everything in the right-hand column belongs to BLRO. JM state is disposable: wiping a JM endpoint
must never destroy truth.

## Requirements

- Node.js 20 or newer. The preflight refuses anything older with `NODE_VERSION_UNSUPPORTED`.
- pnpm, activated through `corepack` (pinned by `packageManager` in `package.json`). The npm
  lockfile is not maintained.
- A Playwright-supported OS, or an approved Chrome/Chromium executable path.
- A display or remote desktop session for the interactive login step. A headless server is flagged
  with `NO_DISPLAY_INTERACTIVE_LOGIN_REQUIRES_DISPLAY`.

## 1. Review the install plan before running it

```bash
pnpm run jm:endpoint:doctor
```

This prints the ordered plan and then runs the readiness check. It changes nothing. Observed on a
Linux x64 host with node 24:

```text
JM endpoint doctor plan — linux/x64, node 24

[STEP] 1. Enable the pinned package manager
    $ corepack enable
[STEP] 2. Install workspace dependencies from the committed lockfile
    $ pnpm install --frozen-lockfile --offline --dry-run
[STEP] 3. Install the Playwright-managed Chromium build
    $ pnpm exec playwright install --with-deps chromium
[STEP] 4. Evaluate endpoint readiness fail-closed
    $ node scripts/jm-endpoint-preflight.mjs --json
[STEP] 5. Prove the browser port end-to-end against the local mock console
    $ pnpm run dev:mock-console  # then: pnpm exec tsx scripts/test-browser-port.ts --scenario local-readback --base-url http://127.0.0.1:3400/hci

JM_ENDPOINT_INSTALL_PLAN_OK: 5 step(s), mode=doctor
```

The machine-readable form, for fleet tooling:

```bash
node scripts/jm-endpoint-install.mjs --json
```

Every step reports `requiresCustomerAccess: false` and `mutatesDevice: false`. The installer plans
no execution-gate opt-in: enabling real or production execution is always a separate, deliberate
human action for a specific change window.

## 2. Run the installation

```bash
pnpm run jm:endpoint:install
```

This executes the safe steps in order and stops at the first failure with
`JM_ENDPOINT_INSTALL_FAILED: <step> exited <code>`. On success it prints
`JM_ENDPOINT_INSTALL_COMPLETE`.

The mock-console smoke is intentionally **not** auto-started: it needs two terminals, so it stays
operator-driven and is reported as step 5 instead.

If Playwright cannot install a browser on this host, provide an approved executable and re-run:

```bash
export SANGFOR_CHROMIUM_PATH=/absolute/path/to/chrome
test -x "$SANGFOR_CHROMIUM_PATH"
pnpm run jm:endpoint:doctor
```

The plan then reports step 3 as `[SKIP] Use the operator-provided browser executable` and verifies
your path instead of downloading one.

## 3. Verify readiness

```bash
pnpm run jm:endpoint:preflight
```

Readiness is **fail-closed**: it exits non-zero and names a reason code unless every check passes.
Observed on a ready host:

```text
[PASS] node_runtime: node major 24 >= 20
[PASS] browser_executable: resolved browser executable: /home/…/chrome-linux64/chrome
[PASS] cdp_profiles: no borrowed CDP profile registered; JM will only use managed browsers
[PASS] execution_gates: read-only default: SANGFOR_ALLOW_REAL_EXECUTION is not enabled

JM_ENDPOINT_PREFLIGHT_READY
```

Observed on an unconfigured host:

```text
[FAIL] browser_executable: SANGFOR_CHROMIUM_PATH is not set; JM cannot resolve a browser executable

JM_ENDPOINT_PREFLIGHT_NOT_READY: BROWSER_EXECUTABLE_UNSET
```

### Reason codes

| Code | Meaning | Fix |
|---|---|---|
| `NODE_VERSION_UNSUPPORTED` | Node older than 20 | Upgrade the runtime |
| `BROWSER_EXECUTABLE_UNSET` | No browser configured | `pnpm exec playwright install chromium` or set `SANGFOR_CHROMIUM_PATH` |
| `BROWSER_EXECUTABLE_MISSING` | Configured path is absent or not executable | Correct the path |
| `CDP_PROFILE_REGISTRY_CORRUPT` | `SANGFOR_JM_CDP_PROFILES_JSON` is not a JSON array | Repair the registry; borrowed attach fails closed until then |
| `CDP_PROFILE_PORT_INVALID` | Profile port is not a safe port number | Use a valid port |
| `CDP_BIND_NOT_LOOPBACK` | Profile exposes CDP off `127.0.0.1` | Rebind to loopback |
| `CDP_PROFILE_ORIGIN_INVALID` | `expectedOrigin` is not an exact `scheme://host[:port]` | Remove path/query/fragment |
| `APPROVAL_SECRET_MISSING` | Real execution enabled without the HMAC secret | Inject the secret, or disable real execution |
| `PRODUCTION_OPT_IN_REQUIRED` | Non-loopback mutation target without the production flag | Set `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true` for that window, or target loopback |

## 4. Register a borrowed browser profile (only if attaching to an existing Chrome)

JM prefers launching its own managed browser. To attach to a browser you already authenticated,
register the exact port/origin pair first:

```bash
export SANGFOR_JM_CDP_PROFILES_JSON='[
  {
    "profileRef": "approved-console",
    "cdpPort": 9333,
    "expectedOrigin": "https://<customer-console-origin>"
  }
]'
pnpm run jm:endpoint:preflight
```

An unregistered port, a mismatched origin, a non-loopback bind, or a corrupt registry is refused
before JM connects — `CDP_PROFILE_REQUIRED` / `CDP_PROFILE_MISMATCH` at runtime, and the preflight
codes above at setup time.

## 5. Prove the browser port end-to-end (loopback only)

Terminal 1:

```bash
pnpm run dev:mock-console
```

Terminal 2:

```bash
pnpm exec tsx scripts/test-browser-port.ts \
  --scenario local-readback \
  --base-url http://127.0.0.1:3400/hci
```

Expect `status: "PASS"`, `readBack: "PASS"`, `restored: "PASS"`, and a screenshot path. The
mutation dispatch itself stays `INDETERMINATE` until read-back — a click is never success.

Then prove the refusal path:

```bash
pnpm exec tsx scripts/test-browser-port.ts \
  --scenario bad-origin \
  --base-url http://127.0.0.1:3400/hci
```

Expect `status: "REFUSED"`, `mutationAttempted: false`, `error.code: "SESSION_ORIGIN_MISMATCH"`.

## 6. Run the MCP server for a client

```bash
pnpm run dev:mcp
```

This is an MCP stdio server: it binds no port. Point Cursor or any MCP client at this command. For
a REST façade on loopback, `pnpm run dev:http-bridge` (`:3600`); a non-loopback bind requires
`SANGFOR_API_TOKEN`.

## 7. Enabling a real change window

Real execution is off by default and stays off between windows. For the duration of one approved
window only:

```bash
export SANGFOR_ALLOW_REAL_EXECUTION=true
export SANGFOR_OPERATOR_APPROVAL_SECRET='<inject from the local secret manager>'
export SANGFOR_NONCE_STORE_PATH="$HOME/.local/state/sangfor-jm/approval-nonces.json"
```

For a production-mode session **or any non-loopback mutation target**, additionally:

```bash
export SANGFOR_ALLOW_PRODUCTION_EXECUTION=true
```

Re-run `pnpm run jm:endpoint:preflight` and require `JM_ENDPOINT_PREFLIGHT_READY` before acting.
Every action still needs a signed approval bound to that exact action, a fresh single-use nonce, an
exact origin, and an independent read-back. See [Security](SECURITY.md).

## 8. Teardown after the window

```bash
unset SANGFOR_ALLOW_REAL_EXECUTION SANGFOR_ALLOW_PRODUCTION_EXECUTION \
      SANGFOR_OPERATOR_APPROVAL_SECRET SANGFOR_NONCE_STORE_PATH \
      SANGFOR_JM_CDP_PROFILES_JSON
pnpm run jm:endpoint:preflight   # expect read-only default restored
lsof -nP -iTCP:3400 -iTCP:9333 -sTCP:LISTEN
pgrep -a chrome
```

Expect no listener and no stray browser. Keep an approved project profile only if customer policy
permits; to revoke local access, sign out in the browser first, close it, then archive or delete
that exact project-scoped directory under change control.

## Decommissioning a JM endpoint

1. Revoke the endpoint's enrollment on BLRO (once Phase 4 of the
   [separation plan](design-docs/blro-separation-and-operations.md) ships).
2. Sign out of every console in each project profile.
3. Delete the profile directories and the local nonce store.
4. Confirm no evidence bytes remain unuploaded; BLRO holds the authoritative copies.

Wiping a JM endpoint never destroys authoritative data — that is the point of the boundary.
