# sangfor-engineer-mcp

Sangfor product-specific senior engineer MCP server.

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

## Run (local)

Use **pnpm** on your machine (recommended). See **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)** for clone, `.env`, login, and full learning on a local PC.

```bash
corepack enable
pnpm install
pnpm test
pnpm run lint
pnpm run build
pnpm run dev:mcp
```

`npm install` works with `package-lock.json`, but **pnpm is recommended** (`packageManager` in `package.json`, workspaces in `pnpm-workspace.yaml`). See `AGENTS.md` for agent/CI notes.

## Real execution gates

Non-dry-run live action requires:

```bash
export SANGFOR_ALLOW_REAL_EXECUTION=true
export SANGFOR_OPERATOR_APPROVAL_TOKEN='set-a-one-time-approval-token'
```

Production mode additionally requires:

```bash
export SANGFOR_ALLOW_PRODUCTION_EXECUTION=true
```

Every live write call must include approval payload with `approvedBy`, `approvalToken`, `changeTicketId`, and `rollbackPlanId`.

## RAG ingestion

```bash
pnpm run ingest:docs -- ./manuals/hci-guide.pdf HCI 6.11
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
