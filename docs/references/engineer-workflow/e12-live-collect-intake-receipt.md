# E12 live-collect start intake receipt

Secret-free evidence for [#105](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/105) (collect path also Refs [#95](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/95)). Live collect is `NOT_RUN`. This is not field acceptance.

| Field | Value |
| --- | --- |
| unit | E12 |
| issue | #105 |
| baseCommit | `5b51cfce25a5a8d726cd36c7f9faf694d58853f2` (PR #139 tip) |
| environmentKind | fixture start-intake code |
| fixtureOrLive | fixture |
| liveRead | not_run |
| field_accepted | false |
| integration_verified | no |
| Phase A complete | no |
| E14 started | no |
| mutationDispatchCount | 0 |
| SANGFOR_ALLOW_REAL_EXECUTION | unset / refused when set |

## What this increment does

- Adds `evaluateEngineerLiveCollectStart` / `startEngineerLiveCollect`.
- Missing Jae-owned intake returns `LIVE_COLLECT_INTAKE_INCOMPLETE` with the six field ids.
- `startEngineerLiveCollect` does not call `collect` or `fetch`. Complete intake still returns `LIVE_COLLECT_INTAKE_COMPLETE_NOT_STARTED` (no GET).
- `runEngineerWorkflow({ liveCollectStart: true })` refuses before the inventory client is used.
- `fieldAccepted` stays false. No apply tool.

## Commands

| commandOrProcedure | exitCode | pass/fail/not_run |
| --- | --- | --- |
| `TMPDIR=/home/jm/.cache/sangfor-e13-intake pnpm exec vitest run --config vitest.config.ts tests/engineer-live-collect-intake.test.ts tests/engineer-collect-bind.test.ts tests/engineer-field-acceptance.test.ts tests/engineer-workflow-e2e.test.ts` | 0 | pass (53) |
| `pnpm run lint` (after `pnpm run db:generate` in this worktree) | 0 | pass |
| `pnpm run build` | 0 | pass |
| live HCI read collect | — | **NOT_RUN**. not_run ≠ PASS |

## Explicit no

No live HCI/Janus GET. No host invented. No `field_accepted`. No E14. `#105` / `#95` stay open.
