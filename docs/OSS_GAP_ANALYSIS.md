# OSS Gap Analysis — sangfor-engineer-mcp

Generated from `sangfor-oss-gap-analyst` survey (2026-06).  
Subagent: `.cursor/agents/sangfor-oss-gap-analyst.md`

## Executive summary

- **MCP surface (42 tools)** is broader than typical OSS RAG-only servers; domain-specific planner, approval, and product-adapters are differentiators.
- **RAG quality** lags OSS: we use SHA hash embeddings in `packages/sangfor-rag`; OSS peers use semantic vectors (Ollama, LightRAG, Qdrant, Rapid-MLX `/v1/embeddings`).
- **KB ingestion** is fragile: Playwright token injection alone hits Login; Glass/CDP session reuse is required for full bodies.
- **Operator live path** is gated but under-tested; mock layers dominate planner/knowledge/wiki.
- **No MCP quality CI** (contrast: [mcp-scorecard](https://github.com/davidmosiah/mcp-scorecard), [mcp-audit](https://github.com/jsandov/mcp-audit)).

## Product decisions (owner, 2026-06)

| Topic | Decision |
|-------|----------|
| KB daily automation | **Yes** — 1×/day via fixed Glass CDP + `learn:kb:full` |
| RAG embeddings | **Rapid-MLX (local Apple Silicon)** primary; **Xiaomi MiMo cloud** rerank/augment — not 100% Ollama-only |
| This document | **Committed** to `docs/OSS_GAP_ANALYSIS.md` |
| Next design | See `docs/design/RAG_SEMANTIC_EMBEDDINGS.md`, `docs/design/KB_DAILY_CDP_AUTOMATION.md` |

## Our product snapshot

| Area | Today |
|------|--------|
| MCP | 42 tools — planner, approval, operator, RAG, learn, product-adapters, wiki, finetune |
| RAG | `data/rag/index.json`, hash embedding 384-dim (`hashEmbedding`) |
| KB learn | `learn:sources`, `learn:kb:full`, Safari tokens, Playwright DOM crawl, 80 URL seed table |
| Operator | Mock default; live Playwright + env gates |
| Product adapters | HCI_SCP `ready`; IAG / Endpoint Secure / NDR `discovery_required` |
| Tests | 5 Vitest files — no live Playwright, no semantic RAG eval |

## OSS landscape (relevant)

| Project | URL | Strength vs us | Weakness vs us |
|---------|-----|----------------|----------------|
| [playwright-mcp](https://github.com/microsoft/playwright-mcp) | Microsoft | a11y snapshots, 40+ tools, session persistence | No Sangfor domain, no approval gates |
| [knowledge-mcp](https://github.com/olafgeibig/knowledge-mcp) | LightRAG + graph | Hybrid RAG, CLI KB management | No partner ONE/KB auth |
| [mcp-rag](https://github.com/JMRussas/mcp-rag) | Local SQLite+Ollama | Semantic+FTS hybrid, 61 tests | No enterprise operator |
| [rag-code-mcp](https://github.com/doitmagic/rag-code-mcp) | AST+Qdrant | Strong code chunking | Out of vendor-console scope |
| [rapid-mlx](https://github.com/raullenchai/Rapid-MLX) | Apple Silicon | OpenAI `/v1/embeddings`, cloud routing | Mac-only local path |
| [mcp-scorecard](https://github.com/davidmosiah/mcp-scorecard) | Agent readiness score | Stdio 0–100 probe | Not domain-specific |

## Gap & problem analysis

### Critical

1. **Non-semantic RAG** — `packages/sangfor-rag/src/index.ts` (`hashEmbedding`). Hurts `sangfor.search_manuals` / planner grounding.
2. **KB body crawl unstable** — `scripts/lib/kb-browser-session.ts`; API 405; headless Login without CDP.
3. **Live operator unverified** — `packages/sangfor-verifier` manual-only; no E2E for `execute_console_action_live`.

### High

4. Mock knowledge/wiki vs real RAG (`sangfor-knowledge`, `sangfor-wiki` hardcoded chunks).
5. Three of four product adapters not `ready`.
6. In-memory session/feedback/wiki stores.
7. No `mcp-scorecard` / SARIF CI on MCP server.

### Medium

8. Multi-step KB auth (safari, chrome, CDP, `token_by_code`).
9. Fine-tune export only — no closed eval loop.
10. Cold-start agent path for `learn:kb:full` success unclear in docs.

## Adopt / avoid / build

| Pattern | Source | Action |
|---------|--------|--------|
| OpenAI-compatible embeddings | Rapid-MLX | **Adopt** (primary local) |
| Cloud RAG augmentation | [Xiaomi MiMo API](https://platform.xiaomimimo.com/) | **Adopt** (rerank; embed TBD) |
| CDP + storageState | playwright-mcp | **Adopt** for KB |
| Autonomous browser agents | Skyvern / Browser Use | **Avoid** (conflicts with approval gates) |
| MCP scorecard in CI | mcp-scorecard | **Adopt** |
| Sangfor partner KB SSO | — | **Build** (no OSS equivalent) |

## Roadmap (ordered)

1. Semantic RAG — Rapid-MLX + Xiaomi MiMo (design: `docs/design/RAG_SEMANTIC_EMBEDDINGS.md`)
2. KB daily CDP automation (design: `docs/design/KB_DAILY_CDP_AUTOMATION.md`)
3. `mcp-scorecard` in CI after `pnpm test`
4. Planner uses `rag_search` only (drop mock manual path)
5. Product adapter discovery for IAG/EPP/NDR
6. Persistent stores (Prisma)

## References

- Agent: `.cursor/agents/sangfor-oss-gap-analyst.md`
- Local setup: `docs/LOCAL_SETUP.md`
- Automation: `automation/README.md`
