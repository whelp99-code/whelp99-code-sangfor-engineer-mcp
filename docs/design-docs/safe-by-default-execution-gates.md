# Decision: Safe-by-default, layered live-execution gates

**Status:** verified

## Context
The product must be able to *actually change* Sangfor/HCI devices to be useful to a field engineer, but a wrong or replayed write against a customer's production device is unacceptable. A single boolean "allow writes" flag is too coarse: it can't distinguish lab from production, can't bind an approval to a specific action, and can't prevent replay.

## Decision
Live execution is unlocked only when **every** layer passes, checked in order inside `assertRealExecutionAllowed()` (`@sangfor/operator`):

1. **Dry-run default** — `action.dryRun !== false`; any dry-run returns before mutation. The mock path refuses to fabricate an "Executed" result and points to the signed path.
2. **`SANGFOR_ALLOW_REAL_EXECUTION=true`** (lab/customer) — else throw.
3. **`SANGFOR_ALLOW_PRODUCTION_EXECUTION=true`** — additionally required
   when `session.mode === 'production'` or the mutation target is
   non-loopback.
4. **Signed, complete-action-bound, time-bound HMAC approval** — `approvalToken = HMAC-SHA256(SANGFOR_OPERATOR_APPROVAL_SECRET, approvedBy·changeTicketId·rollbackPlanId·nonce·expiresAt·canonicalActionJson)`, verified in constant time. Canonical JSON recursively sorts keys and binds every supplied action field; browser writes bind `type`, `target`, `value`, `dryRun`, `menuPath`, and `formFields`. Missing secret → fail closed.
5. **Single-use nonce** — a durable `FileNonceStore` consumes `(nonce, expiresAt)` (atomic tmp+rename); replay within the window is rejected. Browser execution validates target/origin/request and requires an authoritative read-only preflight before consuming the nonce immediately before mutation dispatch. Any store error refuses execution.
6. **Origin lock** — `assertNavigationWithinTarget` refuses a cross-origin navigate even under dry-run.

The HTTP bridge (`packages/sangfor-operator/src/tool-authorization.ts`) is a second, independent gate: it refuses `destructiveHint` tools without a valid single-use approval, refuses write tools on a non-loopback bind unless `SANGFOR_ALLOW_REMOTE_WRITE`, and verifies the same signed approval (nonce consumed **last**).

## Rationale
- **Defense in depth**: env flags gate the *environment*, the HMAC gates the *specific action*, the nonce gates *replay*. Each layer fails closed independently.
- **Non-repudiation & reversibility**: mandatory `changeTicketId` + `rollbackPlanId` + `approvedBy` mean every live write is traceable and has a stated undo.
- **Default posture is read-only** so a fresh checkout, a test run, or a misconfigured deploy cannot mutate a device.

## Consequences
- Tests must never weaken a gate to go green — there are dedicated gate tests (`operator-execution-gate`, `operator-nonce-store`, `verifier-apply-gate`, `http-bridge-approval-guard`) that assert the refusals.
- The full real executor is not yet wired for all products (`product-adapters.applyApprovedProductChange` gates correctly but is deliberately inert). See [tech-debt-tracker](../plans/work/tech-debt-tracker.md).
- Related: [core-beliefs](core-beliefs.md) §2–§3, [SECURITY.md](../SECURITY.md), [RELIABILITY.md](../RELIABILITY.md).
