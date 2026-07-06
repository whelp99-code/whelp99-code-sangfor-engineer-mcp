# Decision: Safe-by-default, layered live-execution gates

**Status:** verified

## Context
The product must be able to *actually change* Sangfor/HCI devices to be useful to a field engineer, but a wrong or replayed write against a customer's production device is unacceptable. A single boolean "allow writes" flag is too coarse: it can't distinguish lab from production, can't bind an approval to a specific action, and can't prevent replay.

## Decision
Live execution is unlocked only when **every** layer passes, checked in order inside `assertRealExecutionAllowed()` (`@sangfor/operator`):

1. **Dry-run default** — `action.dryRun !== false`; any dry-run returns before mutation. The mock path refuses to fabricate an "Executed" result and points to the signed path.
2. **`SANGFOR_ALLOW_REAL_EXECUTION=true`** (lab/customer) — else throw.
3. **`SANGFOR_ALLOW_PRODUCTION_EXECUTION=true`** — additionally required when `session.mode === 'production'`.
4. **Signed, action-bound, time-bound HMAC approval** — `approvalToken = HMAC-SHA256(SANGFOR_OPERATOR_APPROVAL_SECRET, approvedBy·changeTicketId·rollbackPlanId·nonce·expiresAt·action.type·action.target)`, verified in constant time. Missing secret → fail closed. Because the action type+target are inside the HMAC, a token minted for one action cannot be reused for another.
5. **Single-use nonce** — a durable `FileNonceStore` consumes `(nonce, expiresAt)` (atomic tmp+rename); replay within the window is rejected. Any store error refuses execution.
6. **Origin lock** — `assertNavigationWithinTarget` refuses a cross-origin navigate even under dry-run.

The HTTP bridge (`apps/http-bridge/tool-guard.ts`) is a second, independent gate: it refuses `destructiveHint` tools always, refuses write tools on a non-loopback bind unless `SANGFOR_ALLOW_REMOTE_WRITE`, and verifies the same signed approval (nonce consumed **last**).

## Rationale
- **Defense in depth**: env flags gate the *environment*, the HMAC gates the *specific action*, the nonce gates *replay*. Each layer fails closed independently.
- **Non-repudiation & reversibility**: mandatory `changeTicketId` + `rollbackPlanId` + `approvedBy` mean every live write is traceable and has a stated undo.
- **Default posture is read-only** so a fresh checkout, a test run, or a misconfigured deploy cannot mutate a device.

## Consequences
- Tests must never weaken a gate to go green — there are dedicated gate tests (`operator-execution-gate`, `operator-nonce-store`, `verifier-apply-gate`, `http-bridge-approval-guard`) that assert the refusals.
- The full real executor is not yet wired for all products (`product-adapters.applyApprovedProductChange` gates correctly but is deliberately inert). See [tech-debt-tracker](../plans/work/tech-debt-tracker.md).
- Related: [core-beliefs](core-beliefs.md) §2–§3, [SECURITY.md](../SECURITY.md), [RELIABILITY.md](../RELIABILITY.md).
