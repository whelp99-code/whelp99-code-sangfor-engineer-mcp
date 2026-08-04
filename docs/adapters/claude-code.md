# Claude Code adapter

Sangfor engineer MCP server, stdio transport, run from a local clone.

## Register

```bash
claude mcp add sangfor-engineer -- node /absolute/path/to/repo/bin/sangfor-engineer-mcp.mjs
```

`bin/sangfor-engineer-mcp.mjs` pins its own cwd to the repo root and runs
`apps/mcp-server/src/index.ts` through `tsx`, so it works from any directory
once registered — no `cd` and no shell script needed. Requires `pnpm install`
to have been run once in the repo (for `tsx` and the rest of the deps).

## Tool exposure profile

The server exposes `SANGFOR_TOOL_PROFILE = advisor | operator | full`
(default `full`, unset/unrecognized also fall back to `full`). Set it with
`-e`/`--env` at registration time:

```bash
# Read-only advisory tools only (search, evaluate, sizing, RCA, coverage)
claude mcp add sangfor-engineer-advisor \
  -e SANGFOR_TOOL_PROFILE=advisor \
  -- node /absolute/path/to/repo/bin/sangfor-engineer-mcp.mjs

# advisor + approval-gated local writes (plans, PM ledger, playbook drafts),
# excludes destructive device/external mutators
claude mcp add sangfor-engineer-operator \
  -e SANGFOR_TOOL_PROFILE=operator \
  -- node /absolute/path/to/repo/bin/sangfor-engineer-mcp.mjs
```

Call `sangfor_agent_manifest` (or read resource `sangfor://agent-manifest`)
at session start — it reports `activeProfile` and the live tool count for
each profile, computed from the running server, not a static doc.

## Curated workflows (MCP prompts)

The server ships three prompts (`prompts/list` / `prompts/get`) that chain
real tools in a specific order — use them as a starting instruction rather
than guessing the right tool sequence yourself:

- **sangfor-health-check** — `sangfor_agent_manifest` → the matching
  `sangfor_advisor_fortios` / `sangfor_advisor_cisco_iosxe` /
  `sangfor_hci_health_report` → `sangfor_evaluate_config` →
  `sangfor_generate_evidence_report`. All read-only.
- **sangfor-config-plan** — `sangfor_analyze_customer_requirements` →
  `sangfor_generate_config_plan` → `sangfor_request_approval` (risk
  classification) → `sangfor_validate_config_plan`. Never calls an
  `apply_*`/`execute_*` tool — those need separate human approval.
- **sangfor-troubleshoot** — `sangfor_rag_search` (grounded evidence first)
  → hypothesis → `sangfor_suggest_rca`.

In Claude Code, invoke a prompt with `/mcp__sangfor-engineer__sangfor-health-check`
(prompt names are slugified per-client; check `/mcp` for the exact form your
client exposes) or ask the model to "run the sangfor-troubleshoot workflow
for <symptom>" — it will call `prompts/get` itself.

## Safety posture (unchanged by profile)

Profiles control *visibility*, not the approval gate. Every device/external
write still requires `SANGFOR_ALLOW_REAL_EXECUTION` and a signed,
action-bound, single-use approval regardless of profile — `operator` only
changes which tools show up in `tools/list`; it does not weaken any gate.
