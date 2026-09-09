# E12 collect → binder increment receipt

Secret-free evidence for [#105](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/105). Collect facts can now reach the existing authorized-read binder. Live collect is `NOT_RUN`. This is not field acceptance.

| Field | Value |
| --- | --- |
| unit | E12 |
| issue | #105 |
| baseCommit | `c728e2f814f8d42837d13654ec832aa71ce91ccd` (`codex/engineer-e12-grant-path`) |
| environmentKind | fixture collect-bind code |
| fixtureOrLive | fixture |
| liveRead | not_run |
| field_accepted | false for real cases |
| integration_verified | no |
| Phase A complete | no |
| E13/E14 started | no |
| mutationDispatchCount | 0 |
| SANGFOR_ALLOW_REAL_EXECUTION | unset / unused |

## Collect → binder

Missing on `c728e2f`: `runEngineerWorkflow` always snapshotted collect as `fixture` and called the grant sibling without `boundObservations`.

This increment adds `bindHciCollectToFieldAcceptanceObservations`. When collect actually executes and a declared target matches the in-process `endpointFor` identity origin, volumes/servers/images facts with `originalPresent === true` are usable by `bindEngineerAuthorizedDeviceReadEvidence`. `collectInventory` now also emits firmware, collectedAt, volume_status_health, and E03B extras as `originalPresent === true` facts when those explicit keys are present on already-fetched REST JSON. They bind through `bindObservedFactToCase` with field-qualified endpoints (`GET /volumes/detail field:firmware`). They are not invented from the collect timestamp, a `firmwareVersion` option, volume status, flavor/hypervisor shapes, or provided-only E03B fields. Omitted keys stay absent / `NOT_RUN`. Official HCI OpenAPI/catalog still has no dedicated firmware, hypervisor, network, or HA URL; a real device that only returns volumes/servers/images still ends `REQUIRED_LIVE_SURFACES_NOT_RUN`. A synthetic authorized stub whose API JSON contains the extras can mint `authorized_device_read`; that is not a live device read and not `field_accepted`. Mock `:3400`, historical session kinds, fixture inventory without a verified target, and invented collector bytes cannot mint `authorized_device_read`. The fixture workflow path still does not pass `boundObservations` and stays `fieldAccepted: false` / `liveRead: not_run`.

A stub client with a matching example.test origin can exercise the wire. That is not a live device read.

## Live collect

Not run. Access was ambiguous or forbidden:

- No authorized private-store locator after E02 operational confirmation (`#94` owner_confirmation missing, credential_rotation not_run).
- Process environment had no HCI collect variables.
- A local env file listed HCI names whose identity URL class matched the historical cleanup host. E02 forbids reusing that host. It was not contacted.
- JM endpoint doctor: `NOT_READY` (`BROWSER_EXECUTABLE_UNSET`). Execution gates remain read-only (real-execution flag unset).
- Mock console `:3400` is not field acceptance.

Exact blocker still needed from the user/PM: product, firmware, read-only collection scope, and a private-store locator for a current (rotated) read account that is not the historical cleanup host.

## Commands

| commandOrProcedure | exitCode | pass/fail/not_run |
| --- | --- | --- |
| `TMPDIR=/home/jm/.cache/sangfor-e12 pnpm exec vitest run --config vitest.config.ts tests/engineer-field-acceptance.test.ts tests/engineer-workflow-e2e.test.ts tests/engineer-collect-bind.test.ts tests/engineer-hci-collection.test.ts tests/engineer-required-observations.test.ts` | 0 | pass (55) |
| `pnpm run lint` (after `pnpm run db:generate` in this worktree) | 0 | pass |
| `pnpm run build` | 0 | pass |
| live HCI read collect | — | **NOT_RUN**. not_run ≠ PASS |
| `pnpm run test:postgres:mandatory` | — | **NOT_RUN** (no isolation `DATABASE_URL` / `BLRO_OWNER_DATABASE_URL`). not_run ≠ PASS |
| historical 26-item xlsx | 0 | **ran** inside `tests/engineer-workflow-e2e.test.ts` after discover read a hash-matching `.xlsx` from repo-root documented paths (`20e99de99a04b349a4ec82bad18c383eddb869973498ba11aeb729ac2e4eda79`, 22547 bytes). Hermes-path presence or a digest file alone is not replay. |
| `pnpm run jm:endpoint:doctor` | 1 | **NOT_READY** (`BROWSER_EXECUTABLE_UNSET`). not a live HCI target |

## Explicit no

No `field_accepted` for real cases. No merge to main. No E14. No program / Epic #90 completion. `#105` stays open.
