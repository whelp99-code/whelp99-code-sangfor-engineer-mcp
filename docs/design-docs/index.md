# Design Docs Index

Indexed architectural decisions for sangfor-engineer-mcp. Status: `verified` = observed and confirmed in code; `draft` = observed but unconfirmed; `superseded` = replaced.

| Doc | Status | Summary |
|---|---|---|
| [core-beliefs](core-beliefs.md) | verified | Agent-first operating principles: safe-by-default, no false-pass, no fabrication, human-in-the-loop, fail-closed. |
| [safe-by-default-execution-gates](safe-by-default-execution-gates.md) | verified | Why live execution is layered behind env gates + HMAC action-bound single-use approvals, and why it's off by default. |
| [vendor-agnostic-spec-evaluate](vendor-agnostic-spec-evaluate.md) | verified | Why multi-vendor support is a data contract + shared evaluate engine, not an OO device hierarchy. |
| [thin-apps-fat-packages](thin-apps-fat-packages.md) | verified | Why domain logic lives in `packages/*` and apps are thin adapters; the layered dependency graph. |
| [local-first-knowledge](local-first-knowledge.md) | verified | Why RAG/embeddings run locally by default with a hash fallback, and cloud/customer-trust access is gated. |

To add a decision: copy the shape of an existing doc (Context → Decision → Rationale → Consequences), set a Status, and add a row here.
