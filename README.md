# sangfor-engineer-mcp

Sangfor product-specific senior engineer MCP server — advises, plans, and (behind hard
gates) executes Sangfor/FortiOS/Cisco device work. Read-only by default; irreversible
acts always require a human-signed, single-use approval.

**MCP scorecard: 96/100 — grade A** (`pnpm run check:mcp-scorecard`). 108 tools, snake_case
`sangfor_*` naming, agent self-onboarding (`sangfor_agent_manifest` / `sangfor_capabilities`),
MCP resources, and documented mutation gating on every write tool.

현재 108개 MCP 도구의 전체 기능 목록, Cursor/stdio/HTTP 연결법, 승인 흐름과 예제는 **[MCP 기능 및 사용 가이드](docs/MCP_FEATURES_AND_USAGE.md)**를 참고하세요.

## Quickstart (customer / first run)

```bash
corepack enable && pnpm install
pnpm test                 # full Vitest suite
pnpm run check:mcp-scorecard   # objective MCP quality gate (grade A)
pnpm run dev:mcp          # MCP stdio server for Cursor / any MCP client
```

First calls an agent should make (also returned by `sangfor_agent_manifest`):
`sangfor_products` → `sangfor_capabilities` → `sangfor_list_spec_coverage` →
`sangfor_search_manuals` → `sangfor_analyze_project`.

Everything is dry-run/read-only until you explicitly enable live execution (below).


Priority products:

1. HCI
2. IAG
3. Endpoint Secure
4. Cyber Command

## Included scope

This project includes:

- MCP-style JSON-RPC stdio server
- Sangfor project analyzer and configuration planner
- Approval/risk engine
- Mock and live Playwright operator paths
- Customer/production execution path with mandatory gates
- PDF/HTML/Markdown/TXT ingestion
- Local RAG vector index
- GitHub Wiki and Obsidian write adapters
- Feedback → lesson → wiki proposal → eval pipeline
- Fine-tuning dataset and job manifest pipeline
- Control Tower 플레이북 — 승인된 리비전만 실행, write 블록에서 사람 승인 대기, 기계 집계 리포트 (**[docs/PLAYBOOK_RUNBOOK.md](docs/PLAYBOOK_RUNBOOK.md)**)

## Run (local)

Use **pnpm** on your machine (recommended). See **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)** for clone, `.env`, login, and full learning on a local PC.

```bash
corepack enable
pnpm install
pnpm test
pnpm run lint
pnpm run build
pnpm run dev:mcp      # MCP stdio — Cursor 등 외부 클라이언트
pnpm run dev:web      # 웹 UI http://localhost:3502
```

Use **pnpm only** (`packageManager` in `package.json`, workspaces in
`pnpm-workspace.yaml`, lock state in `pnpm-lock.yaml`). The npm lockfile is not
maintained. See `AGENTS.md` for agent/CI notes.

## Real execution gates

Non-dry-run live action requires:

```bash
export SANGFOR_ALLOW_REAL_EXECUTION=true
# Server-side HMAC key that signs approvals; the call must carry an action-bound,
# unexpired, single-use signed approval (see docs/INCLUDED_HIGH_RISK_SCOPE.md).
export SANGFOR_OPERATOR_APPROVAL_SECRET='set-a-strong-server-side-secret'
```

Production mode or any non-loopback mutation target additionally requires:

```bash
export SANGFOR_ALLOW_PRODUCTION_EXECUTION=true
```

Every live write call must include approval payload with `approvedBy`, `approvalToken`, `changeTicketId`, and `rollbackPlanId`.

## RAG ingestion

```bash
pnpm run ingest:docs -- ./manuals/hci-guide.pdf HCI 6.11
pnpm run ingest:attachments -- /Users/jmpark/Documents/SANGFOR/Attachment
```

## Fine-tuning dataset

```bash
pnpm run export:finetune -- HCI
```

## Learn from Sangfor Knowledge + Community

```bash
# Optional: SANGFOR_KB_TOKEN from knowledgebase.sangfor.com (library_token) for full article bodies
pnpm run learn:sources   # loads .env; ingests KB, Community, demo-docs → RAG
```

Details: `docs/SANGFOR_SOURCE_LEARNING.md`
