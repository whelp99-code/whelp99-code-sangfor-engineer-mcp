# Security

Security is the defining property of this repo — it drives real device changes for customers. **Read this before touching any write, execution, approval, bind, or persistence path.** The governing belief: a confidently-wrong or replayable action is worse than no action.

## Threat model (what we defend against)
- An errant/misconfigured caller mutating a **production** device.
- A leaked or **replayed** approval token authorizing a write.
- An approval minted for action A being **reused** for action B.
- A server accidentally exposed on a **non-loopback** interface without auth.
- **Secrets** (passwords, tokens, cookies) leaking into logs, ledgers, or fine-tune data.
- A vendor 2xx being mistaken for a successful change (**false PASS**).

## The live-execution gate (canonical, in `@sangfor/operator`)
A non-dry-run live write passes `assertRealExecutionAllowed()` only if **all** hold, in order:
1. Not a dry-run (`action.dryRun !== false` means dry-run → returns before mutation).
2. `SANGFOR_ALLOW_REAL_EXECUTION=true`.
3. `SANGFOR_ALLOW_PRODUCTION_EXECUTION=true` **when** `session.mode === 'production'`.
4. **Action-bound HMAC approval** — `approvalToken = HMAC-SHA256(SANGFOR_OPERATOR_APPROVAL_SECRET, approvedBy · changeTicketId · rollbackPlanId · nonce · expiresAt · action.type · action.target)`, verified with `timingSafeEqual`. Missing secret → **fail closed**. Action type+target are inside the MAC, so a token cannot be reused for a different action.
5. **Single-use nonce** — a durable `FileNonceStore` (`data/runtime/approval-nonces.json`, atomic tmp+rename) consumes `(nonce, expiresAt)`; replay within the window is rejected. Store error → refuse.
6. **Origin lock** — `assertNavigationWithinTarget` refuses a cross-origin navigate even under dry-run.

Mandatory approval fields: `approvedBy`, `approvalToken`, `changeTicketId`, `rollbackPlanId`, `nonce`, `expiresAt` (+ optional `maintenanceWindow`). No rollback plan → no approval.

## The second, independent gate (`apps/http-bridge/tool-guard.ts`)
Defense-in-depth for the REST surface:
- Tools with **missing annotations** → 403 (fail closed).
- `destructiveHint` tools → **always refused** over HTTP.
- Write tools on a **non-loopback** bind → refused unless `SANGFOR_ALLOW_REMOTE_WRITE=true`.
- Honors the same signed `SignedApproval`; the nonce is `consume`d **last** (after all other checks pass).

## Network exposure (`@sangfor/shared`)
- `assertBindSafety` **fails closed**: binding a non-loopback host **requires** a token (`SANGFOR_API_TOKEN`). An empty/whitespace `BIND_HOST` must not silently become an all-interfaces bind.
- `checkAuth` is a constant-time bearer comparison. All app servers (`mcp`/`bridge`/`control-tower`/`operator-console`) route through these helpers.

## Secret handling
- `maskSecrets` redacts `password|secret|token|authorization|cookie` → `***` **before** anything is written to a run ledger, audit ledger, or console.
- Fine-tune datasets run a secret-blocking regex (`validateFineTuneDataset`); collection sanitizes PII (email/phone/password/OTP/MFA/license) before export.
- `.env` is gitignored; `.env.example` documents vars without values. Never commit real credentials or lab tokens.

## Tamper-evidence
- Change runs (`data/evidence/change-runs/*.jsonl`), the run ledger (`data/runs/*.jsonl`), and PM events are **append-only and hash-chained**. Keyed HMAC chains when `SANGFOR_CHANGE_LEDGER_SECRET` / `SANGFOR_PM_CHAIN_SECRET` are set; otherwise unkeyed SHA-256 and `verify()` honestly reports `keyed:false`.

## Knowledge/data trust
- RAG runs local-first; cloud embeddings/rerank need `SANGFOR_ALLOW_CLOUD_RAG`; customer-trust docs excluded from results unless `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER=1`.
- Wiki writes are review-gated: proposal → `approveWikiUpdate` (action-bound HMAC over the `proposalId`, keyed by `SANGFOR_WIKI_APPROVAL_SECRET`, timing-safe verify, fail-closed if unset) → apply.

## Rules for agents working here
- **Never weaken a gate to make a test pass.** The refusal *is* the feature; dedicated tests assert it (`operator-execution-gate`, `operator-nonce-store`, `verifier-apply-gate`, `http-bridge-approval-guard`, `operator-console-auth`).
- New write/execution capability must route through `assertRealExecutionAllowed` (or an equivalently strong action-bound HMAC), consume a single-use nonce, and mask secrets before persistence.
- Any new server bind must go through `assertBindSafety`; any new persisted record through `maskSecrets`.
- When in doubt, **refuse and surface** rather than proceed.

## Security env vars (gates & secrets)
`SANGFOR_ALLOW_REAL_EXECUTION`, `SANGFOR_ALLOW_PRODUCTION_EXECUTION`, `SANGFOR_OPERATOR_APPROVAL_SECRET`, `SANGFOR_ALLOW_REMOTE_WRITE`, `SANGFOR_API_TOKEN`, `SANGFOR_NONCE_STORE_PATH`, `SANGFOR_CHANGE_LEDGER_SECRET`, `SANGFOR_PM_CHAIN_SECRET`, `SANGFOR_WIKI_APPROVAL_SECRET`, `SANGFOR_ALLOW_CLOUD_RAG`, `SANGFOR_ALLOW_CLOUD_RAG_CUSTOMER`. See `.env.example` for the full set.
