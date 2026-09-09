# E12 grant-path increment receipt

Secret-free evidence for [#105](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/105). Honest grant recorder only. Live collect is `NOT_RUN`. This is not field acceptance.

| Field | Value |
| --- | --- |
| unit | E12 |
| issue | #105 |
| baseCommit | `71f864dc84d608e25ebe8c841dcc3a9c8711893c` (`codex/engineer-e12-field-acceptance`) |
| environmentKind | fixture prep + grant-path code |
| fixtureOrLive | fixture |
| liveRead | not_run |
| field_accepted | false for real cases |
| integration_verified | no |
| Phase A complete | no |
| E13/E14 started | no |
| mutationDispatchCount | 0 |
| SANGFOR_ALLOW_REAL_EXECUTION | unset / unused |

## Live collect

Not run. Access was ambiguous:

- No authorized private-store locator after E02 operational confirmation (`#94` owner_confirmation missing, credential_rotation not_run).
- Process environment had no HCI collect variables.
- A local env file listed HCI names, but the identity URL class matched a historical runbook host. E02 forbids reusing a value recovered from Git history or a prior document revision.
- Mock console `:3400` is not field acceptance.

Exact blocker still needed from the user/PM: product, firmware, read-only collection scope, and a private-store locator for a current (rotated) read account. Do not reuse historical cleanup hosts.

## Grant path

`evaluateEngineerFieldAcceptanceGrant` can return `fieldAccepted: true` only for the conjunction of a structurally valid live `originalPresent` read and a structured HMAC PM grant over the same revisions, using `@sangfor/approval` primitives and `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET`. Kitchen-sink claims, fixture plus attestation string, and synthetic live-shaped fixtures refuse. The unit-test true path is an explicit test double, not a production default.

Shared `evaluateEngineerFieldAcceptance` still never grants.

## Commands

| commandOrProcedure | exitCode | pass/fail/not_run |
| --- | --- | --- |
| `TMPDIR=/home/jm/.cache/sangfor-e12 pnpm exec vitest run --config vitest.config.ts tests/engineer-field-acceptance.test.ts tests/engineer-workflow-e2e.test.ts` | 0 | pass (21) |
| `pnpm run lint` | 0 | pass (after `pnpm run db:generate` in this worktree) |
| `pnpm run build` | 0 | pass |
| live HCI read collect | — | **NOT_RUN**. not_run ≠ PASS |
| `pnpm run test:postgres:mandatory` | — | **NOT_RUN**. not_run ≠ PASS |
| historical 26-item xlsx | — | **NOT_RUN**. not_run ≠ PASS |

## Explicit no

No `field_accepted` for real cases. No merge to main. No E14. No program / Epic #90 completion. `#105` stays open.
