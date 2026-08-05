# Cursor adapter

Sangfor engineer MCP server, stdio transport, run from a local clone.

## Register (`.cursor/mcp.json`)

Project-scoped (`<repo>/.cursor/mcp.json`) or global
(`~/.cursor/mcp.json`, use absolute paths in either case):

```json
{
  "mcpServers": {
    "sangfor-engineer": {
      "command": "node",
      "args": ["/absolute/path/to/repo/bin/sangfor-engineer-mcp.mjs"]
    }
  }
}
```

`bin/sangfor-engineer-mcp.mjs` pins its own cwd to the repo root and runs
`apps/mcp-server/src/index.ts` through `tsx` — no shell wrapper, works from
any cwd Cursor launches it from. Requires `pnpm install` once in the repo.

## Tool exposure profile

Set `SANGFOR_TOOL_PROFILE` in the `env` block (default `full`; unset or an
unrecognized value also falls back to `full`):

```json
{
  "mcpServers": {
    "sangfor-engineer-advisor": {
      "command": "node",
      "args": ["/absolute/path/to/repo/bin/sangfor-engineer-mcp.mjs"],
      "env": { "SANGFOR_TOOL_PROFILE": "advisor" }
    }
  }
}
```

`advisor` = read-only tools only. `operator` = advisor + approval-gated
local writes (plans, PM ledger, playbook drafts), excludes destructive
device/external mutators. Call `sangfor_agent_manifest` to see
`activeProfile` and the live per-profile tool counts.

## Curated workflows (MCP prompts)

`prompts/list` returns three curated workflows you can pull into a Cursor
chat (via the client's prompt picker, or by asking the model to run one):

- **sangfor-health-check** — registry discovery → the matching advisor tool
  (`sangfor_advisor_fortios`, `sangfor_advisor_cisco_iosxe`, or
  `sangfor_hci_health_report`) → `sangfor_evaluate_config` →
  `sangfor_generate_evidence_report`.
- **sangfor-config-plan** — `sangfor_analyze_customer_requirements` →
  `sangfor_generate_config_plan` → `sangfor_request_approval` →
  `sangfor_validate_config_plan`. Never applies a change on its own.
- **sangfor-troubleshoot** — `sangfor_rag_search` for grounded evidence →
  hypothesis → `sangfor_suggest_rca`.

## Safety posture (unchanged by profile)

Profiles only affect which tools appear in `tools/list`/are callable — they
do not touch the approval gate. Every device/external write still needs
`SANGFOR_ALLOW_REAL_EXECUTION` and a signed, single-use approval no matter
which profile is active.
