# Tech Debt Tracker

**Status:** Active
**Owner:** field-engineer-mcp maintainers
**Related:** [QUALITY-SCORE.md](../../QUALITY-SCORE.md), [ARCHITECTURE.md](../../../ARCHITECTURE.md), [SECURITY.md](../../SECURITY.md)

Running list of known, accepted debt. Each item names the gap, the risk it carries,
and the check that would close it. Grades and debt numbers here mirror
[QUALITY-SCORE.md](../../QUALITY-SCORE.md) — keep them in sync when a domain changes.

## Open

### #1 — `applyApprovedProductChange` is inert
- **Where:** `@sangfor/product-adapters` (planning/advisory domain).
- **Gap:** the gated-apply entry point does not yet drive a real executor end-to-end;
  the only live mutation path that is fully wired is HCI (`@sangfor/hci-client`).
- **Risk:** low (fail-closed — nothing mutates that shouldn't), but it limits the
  product-adapters flow to plan → dry-run → verify without a real apply for non-HCI products.
- **Close when:** a non-HCI product can run plan → gated-apply → read-back-verified,
  with a refusal test proving a missing/invalid approval is rejected.

### #5 — RAG retrieval is an O(n) scan
- **Where:** `@sangfor/rag`.
- **Gap:** semantic search scans the whole local JSON vector index linearly; fine at
  current corpus size, won't scale to a large ingested manual set.
- **Risk:** latency only; correctness is unaffected (cosine ranking is exact).
- **Close when:** an ANN index (or partitioned index) backs `ragSearch` with a
  recall-parity test against the brute-force baseline.

### #6 — Legacy docs drift
- **Where:** assorted docs (e.g. stale `:3500` port references).
- **Gap:** a few runbooks predate the current app port layout.
- **Risk:** operator confusion; no runtime impact.
- **Close when:** a doc sweep reconciles every port/URL against `apps/*` servers.

### #7 — MCP scorecard `annotations` ceiling (46/81)
- **Where:** `apps/mcp-server` tool annotations vs. `mcp-scorecard` name heuristic.
- **Gap:** the scorecard counts any non-mutation-verb tool as "read" and expects
  `readOnlyHint: true`. This server deliberately marks local-file writers
  (`generate_*`, `import_*`, `capture_*`, ledger/learning/tower writes) as
  `readOnlyHint: false` because the HTTP bridge's fail-closed guard keys off that
  hint to refuse writes on remote binds. Flipping them to chase the score would
  weaken a security gate — forbidden by [SECURITY.md](../../SECURITY.md).
- **Risk:** none — this is a deliberate, safer-than-heuristic choice. The scorecard
  check stays WARN (4 points) by design.
- **Close when:** never by weakening the gate; only if the scorecard learns to read
  the real write-set rather than name verbs. Documented as accepted.

## Resolved

- **#2 — Learning-loop state non-durable** (2026-07): feedback/lessons/eval/wiki
  proposals now persist as file-based JSONL (`@sangfor/shared` `appendJsonl` /
  `foldJsonlById`), surviving restart. (QUALITY-SCORE learning loop C+ → noted resolved.)
- **MCP scorecard F → A (39 → 96)** (2026-07-31): tool names migrated `sangfor.*` →
  `sangfor_*` snake_case; mutation gating documented on all 15 write tools;
  `sangfor_agent_manifest` + `sangfor_capabilities` discovery tools added; three MCP
  resources registered; honored `privacy_mode` param on read tools. Only #7 remains WARN.

## Convention
- One section per item, numbered, never silently deleted — move to **Resolved** with a date.
- A debt is only "resolved" when the closing check (named above) is shown passing.
