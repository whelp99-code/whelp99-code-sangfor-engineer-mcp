# Quality Score

Per-domain quality grades from the harness-bootstrap review (2026-07-04). Grades are a **snapshot for prioritization**, not a CI gate. Re-grade when a domain changes materially. Scale: **A** solid/well-tested · **B** good, minor gaps · **C** works, notable gaps · **D** risky/thin.

| Domain | Grade | Basis | Top gap to close |
|---|---|---|---|
| Execution safety spine (`operator`, `approval`, `safety`, nonce store) | **A** | Layered fail-closed gates, action-bound HMAC, single-use nonce, dedicated gate tests. | Wire the real executor end-to-end (debt #1). |
| HCI live path (`hci-client`: apply-machine, read-back, audit ledger) | **A** | Read-back-verified state machine, idempotency key, hash-chained ledger, e2e tests. | — |
| Multi-vendor advisory (`spec`, `fortios-*`, `cisco-*`, `config-state`) | **A−** | Vendor-agnostic engine, pure mappers, fixture tests, INDETERMINATE-first. | Broaden spec coverage per product. |
| HTTP exposure (`shared` bind safety, `http-bridge` tool-guard) | **A−** | Fail-closed bind, annotation-based authz, guard tests. | — |
| Run/evidence ledgers (`runs`, `evidence`, `pm`) | **B+** | Append-only, masked, hash-chained. | — |
| Knowledge/RAG (`rag`, `knowledge`, `collector`) | **B** | Local-first with hash fallback, dedupe, provider tests. | Retrieval quality depends on provider; O(n) scan won't scale (debt #5). |
| Learning loop (`feedback`, `evals`, `wiki`, `finetune`) | **C+** | Correct flow, review-gated, PII/secret scrubbing. | Feedback/lessons/eval/proposal state is now persisted as file-based JSONL (debt #2 resolved). |
| Planning/advisory (`planner`, `verifier`, `product-adapters`, `evidence`) | **B** | Cited, risk-classified, verifier never mutates. | `applyApprovedProductChange` inert (debt #1). |
| Apps (`mcp-server`, `control-tower`, `operator-console`, `bridge`, `mock`) | **B** | Thin adapters, playbook engine tested, e2e coverage. | Control-tower paused-approval args non-durable (debt #2). |
| Docs/config hygiene | **B−** | Rich docs, `.env.example` complete. | Legacy docs drift (e.g. stale `:3500`) — debt #6. |

## Method
Grades weigh: test coverage of the safety-critical path, fail-closed behavior, honesty of failure modes (no false-PASS), and evidence/auditability. The bar is deliberately highest for anything that can change a device. Gaps map to [plans/work/tech-debt-tracker.md](plans/work/tech-debt-tracker.md).
