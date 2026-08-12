# Start Here — using Sangfor Engineer MCP today

What works right now, how to run it, and what is deliberately not finished. Every command below
was executed on this repository and its real output recorded before being written down.

The job this serves: **AI + MCP performs the engineering work and authors the technical-support
documents**, with you supervising as PM.

## 1. Start it

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm run dev:mcp
```

`dev:mcp` is an MCP **stdio** server — it binds no port. Point Cursor (or any MCP client) at that
command. Verified live: **108 tools**.

Sanity check without a client:

```bash
pnpm run smoke:mcp     # observed: smoke-mcp-tools: ok (108 tools)
```

## 2. What it can do for you today

Observed tool inventory, by category (from `sangfor_capabilities`):

| Category | Tools |
|---|---:|
| advisory | 33 |
| report (documents) | 16 |
| knowledge | 10 |
| collect | 10 |
| playbook | 9 |
| ml | 8 |
| admin | 7 |
| pm | 7 |
| hci | 5 |
| wiki | 3 |

Recommended first calls, straight from `sangfor_agent_manifest`:
`sangfor_products`, `sangfor_capabilities`, `sangfor_list_spec_coverage`, `sangfor_search_manuals`,
`sangfor_analyze_project`.

### Document authoring — verified end to end

Turning an ITAC-style Excel checklist into a customer setting guide:

```
tool: sangfor_generate_setting_guide_docx
args: { "filePath": "<your ITAC .xlsx>", "outputPath": "<output .docx>" }
```

Observed result on a real 26-item checklist:

```json
{
  "size": 8407,
  "sections": ["1. 요약","2. 실행 원칙","3. 제품별 설정 계획","3a. Endpoint Secure","3b. IAG",
               "3c. NDR / Cyber Command","4. 수동/외부 증적 수집 계획","5. Dry-run 수행 절차",
               "6. 고객 확인 필요 사항"],
  "totalItems": 26, "consoleItems": 12, "manualItems": 14
}
```

The file on disk was confirmed to be a real `Microsoft Word 2007+` document.

Related document tools: `sangfor_generate_comprehensive_setting_guide_docx` (much more detailed),
`sangfor_generate_setting_guide_pptx`, `sangfor_generate_operations_guide_docx`,
`sangfor_build_evidence_package`.

> `officecli` is not installed here, so the generator reported
> `validation: { valid: null, note: "officecli unavailable" }`. The document is still produced;
> only the extra OpenXML schema pre-validation is skipped. Install officecli if you want that
> check, or validate by opening the file.

## 3. Safety posture you are running with

Default is **read-only**. Verified by the built-in self-test (`sangfor_safety_selftest`), which
reported every gate as `refused`:

| Gate | Observed |
|---|---|
| `operator.assertRealExecutionAllowed` | refused — live execution blocked without `SANGFOR_ALLOW_REAL_EXECUTION` |
| `http-bridge.authorizeToolCall` | refused — destructive tool refused by MCP annotations |
| `approval.verifyDomainApprovalSignature` | refused — signature mismatch |
| `approval` nonce replay | refused |

Structural gates, both green: `BLRO_DATA_SCOPE_BOUNDARY_PASS`, `BLRO_READY_BROWSER_BOUNDARY_PASS`.

Nothing touches a customer device unless you deliberately unlock it for one window.

## 4. Unlocking a real change window (only when you need it)

```bash
export SANGFOR_ALLOW_REAL_EXECUTION=true
export SANGFOR_OPERATOR_APPROVAL_SECRET='<from your secret manager>'
export SANGFOR_NONCE_STORE_PATH="$HOME/.local/state/sangfor-jm/approval-nonces.json"
# production mode OR any non-loopback mutation target additionally needs:
export SANGFOR_ALLOW_PRODUCTION_EXECUTION=true
```

Each action still needs a signed approval bound to that exact action, a fresh single-use nonce, an
exact origin match, and an independent read-back before anything counts as success. A click or an
HTTP 2xx is never success. Unset these when the window closes.

Endpoint setup and readiness: [JM Endpoint Install](JM_ENDPOINT_INSTALL.md)
(`pnpm run jm:endpoint:doctor`). Per-window checklist:
[User Intervention](USER_INTERVENTION_JM_BROWSER.md). Security rules: [SECURITY.md](SECURITY.md).

## 5. What is deliberately NOT finished

Being explicit so you do not rely on something that is not there.

| Item | Status |
|---|---|
| Tenant/project/actor scope model | **shipped**, fail-closed, `ai_engineer` work flagged for PM supervision |
| Postgres RLS isolation | **proven** on a live cluster — see [BLRO Local Database](BLRO_LOCAL_DATABASE.md) |
| Postgres single-use nonce store | **built, verified, and wired** into all three execution-gate call sites — see below |
| Audit chain / registry / run-step / evidence / RAG in Postgres | **not migrated** — still file-backed |
| Remote JM↔BLRO protocol, enrollment | **not implemented** |

### Choosing the single-use nonce store

The execution gate consumes an approval's single-use nonce through one selected store. All three
call sites — the operator gate, the MCP server's HCI write gate, and the http-bridge tool guard —
go through the same selection, so "single use" never means "once per call site".

| `SANGFOR_NONCE_STORE` | Store | Use it when |
|---|---|---|
| unset (default) or `file` | JSON file at `SANGFOR_NONCE_STORE_PATH` | one process, which is how you are running it today |
| `postgres` | `BlroApprovalNonce` table, scoped by `project_id` under RLS | BLRO has more than one replica |

```bash
# replica-safe selection; BOTH values are required
export SANGFOR_NONCE_STORE=postgres
export DATABASE_URL="postgresql://blro_app:...@host:5432/blro"   # or SANGFOR_BLRO_DATABASE_URL
export SANGFOR_PROJECT_ID=<project>                              # SANGFOR_ENGAGEMENT_ID is its legacy seed
```

Selection is fail-closed and never silently downgrades. Each of these **refuses** the execution
rather than falling back to the file store: `postgres` with no connection string, `postgres` with
no resolvable project scope, an unknown store name, and an unreachable database. A refusal reason
never echoes the connection password. The synchronous entry point refuses outright while a
non-file store is selected, so a straggler cannot burn the same nonce in a second store.

Verified on the local cluster (see [BLRO Local Database](BLRO_LOCAL_DATABASE.md)): a nonce consumed
through the wired gate survives a brand-new empty file store, eight concurrent consumers of one
nonce elect exactly one winner, and a nonce burned by the operator gate is then refused by both the
http-bridge guard and the HCI write gate.

**Still unproven:** this ran against the single-node development cluster only. The multi-replica
behaviour it is designed for has not been exercised against two live BLRO replicas, because there
is no such deployment yet.

**Why the remaining stores are not migrated:** they hold live data (`data/rag` 4.4 MB,
`data/evidence` 3.4 MB) and touch every store and all 108 tools. A half-migrated data layer on the
day you need to work is the worst possible state, and it would give you nothing visible.

Sequencing for these: [BLRO separation plan](design-docs/blro-separation-and-operations.md).

## 6. If something looks wrong

```bash
pnpm run lint                     # tsc, expect no output
pnpm test                         # full suite
pnpm run check:browser-boundary   # expect BLRO_READY_BROWSER_BOUNDARY_PASS
pnpm run check:data-scope-boundary# expect BLRO_DATA_SCOPE_BOUNDARY_PASS
pnpm run check:hygiene            # expect check-source-hygiene: ok
```

An `INDETERMINATE` result is never a pass. It means a change may have been dispatched but was not
independently confirmed — verify the device yourself before deciding anything.
