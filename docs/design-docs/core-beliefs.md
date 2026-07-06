# Core Beliefs

The operating principles that define how work is done in this repo. These are not aspirations — each is enforced in code and tests. When a change conflicts with one of these, the change is wrong.

## 1. A confidently-wrong AI is dangerous, not merely useless
The product replaces a *trusted* field engineer, so **false confidence is the cardinal sin**. `INDETERMINATE` must never be reported as `PASS`. Unknown inputs return `null` / empty / `unsourced` — never a fabricated value. Uncaptured config keys are omitted (so downstream treats them as indeterminate), never defaulted. Every advisory cites its source.

## 2. Safe by default; live mutation is opt-in and gated
Every action previews (dry-run) unless explicitly unlocked. Real device writes require, together: `SANGFOR_ALLOW_REAL_EXECUTION`, a signed **action-bound single-use** approval, and (in production) `SANGFOR_ALLOW_PRODUCTION_EXECUTION`. Blocking the feature forever would make the product incomplete; shipping it ungated would make it unsafe — so it exists but the default runtime is safe. See [safe-by-default-execution-gates](safe-by-default-execution-gates.md).

## 3. Fail closed, always
Missing approval secret, a service absent from the catalog, a corrupt safety/nonce/ledger file, an ambiguous UI locator (0 or >1 matches), a cross-origin navigate, a non-loopback bind without a token → **refuse**. The safe path is the one taken when anything is uncertain.

## 4. A 2xx is not success; a read-back PASS is
Vendor APIs return 202 even when nothing happened (e.g. quota exceeded). Success is only an independent read-back that PASSes. Failure **halts for a human** — there is no automatic rollback.

## 5. Humans keep the irreversible hand and the signature
Physical installs, irreversible applies, and customer-facing risk decisions are permanently human. The AI's job is advise + prepare + verify; the human approves and signs. The [replacement-rate metric](../PRODUCT-SENSE.md) counts only what is genuinely, verifiably automatable — it is designed to be honest, not flattering.

## 6. Everything is evidenced and tamper-evident
Runs, changes, and PM events are append-only and hash-chained; secrets are masked before any persistence; approvals are single-use to prevent replay. If it happened, there is a ledger line for it.

## 7. Thin apps, fat packages, one leaf
Domain logic lives in `packages/*`; apps are transport adapters. Imports point downward through the layers to the single leaf `@sangfor/shared`. New behavior goes in a package with a test, not in an app handler. See [thin-apps-fat-packages](thin-apps-fat-packages.md).

## 8. Local-first knowledge
RAG and embeddings run locally by default with a deterministic hash fallback, so ingest and search work offline. Cloud embeddings/rerank and customer-trust-level documents are behind explicit gates.
