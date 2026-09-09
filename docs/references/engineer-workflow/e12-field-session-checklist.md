# E12 field-session checklist

Secret-free preparation for [#105](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/105). This is not a live session, not `field_accepted`, and not Phase A completion.

Do not put passwords, cookies, session material, or customer host addresses in git, Issues, or this file. Point at the approved private store after E02 operational confirmation.

## Gate

`evaluateEngineerFieldAcceptance` records refusals only. It never grants.

`evaluateEngineerFieldAcceptanceGrant` may set `field_accepted` only when all of the following hold together:

1. A live read actually executed, with `originalPresent === true` observed facts, `environmentKind: live`, and `sourceKind: authorized_device_read`. Fixture, synthetic live-shaped fixture, mock console, historical records, and attestation strings are not a live read.
2. A structured PM grant verifies with the existing `@sangfor/approval` HMAC primitive (`signDomainApproval` / `verifyDomainApprovalSignature`) over the grant domain, case/guide revision, and live-read digest, keyed by `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET`. Missing secret fails closed. A raw string `pm_live_read_review` or a boolean JSON claim is not a grant. This is not a device-write approval and does not use `SANGFOR_OPERATOR_APPROVAL_SECRET`.
3. Case revision and guide revision on the grant, the live read, and the case under review are identical (matching revision). Mismatch refuses.

Required conjunction: live originalPresent read + structured PM grant + matching revision.

Fixture PASS, `review_ready`, Word download, e2e PASS, developer tests, and `SANGFOR_ALLOW_REAL_EXECUTION` cannot set `field_accepted`. This tree has not run a live read. The only unit-test true path is an explicit HMAC test double; that double is not a production default.

## What the user / PM must provide before a live read starts

1. Authorized **read-only** target: product, firmware, and collection scope. Do not reuse a past HCI write approval.
2. Read-account **locator** in the approved private store (not the secret value). E02 operational replacement/disposal of previously exposed values must already be confirmed.
3. Data-retention and sanitization scope for collected evidence.
4. Customer requirements for the existing-environment case, and provided/proposed specs for the new-build case.
5. Confirmation that the session is read-only. Do not set `SANGFOR_ALLOW_REAL_EXECUTION`. Do not approve a device write.

Until those exist, live collect stays `NOT_RUN` ≠ PASS.

## Required live read surfaces (existing HCI case)

Compare every required value on an independent read screen. Do not treat inventory `size` as usable cluster capacity. Do not copy volume-status health into capacity/HA.

| Surface | Layer | Fixture status | Live session |
| --- | --- | --- | --- |
| volumes | E03A automatic | fixture only | NOT_RUN |
| servers | E03A automatic | fixture only | NOT_RUN |
| images | E03A automatic | fixture only | NOT_RUN |
| collectedAt | E03A automatic | fixture only | NOT_RUN |
| volume_status_health | E03A derived from volumes | fixture only | NOT_RUN |
| firmware | E03A | unknown in fixture | NOT_RUN |
| host_cpu | E03B | unsupported / unknown | NOT_RUN |
| host_ram | E03B | unsupported / unknown | NOT_RUN |
| storage_usable_capacity | E03B | unsupported / unknown | NOT_RUN |
| network_topology | E03B | unsupported / unknown | NOT_RUN |
| ha_status | E03B | unsupported / unknown | NOT_RUN |
| requirements | provided | fixture rows | NOT_RUN (customer text) |

## New-build case

Provided specifications and proposed settings stay `provided` / `proposed`. They are not `observed`. Official BOM remains unknown unless a sourced formula exists.

## After a live read (not this increment)

1. Recalculate remaining / utilization / headroom from the live operands. Independent oracle for the fixture numbers remains 60 GiB / 40 percent / 40 GiB from 100/40/20; live numbers must be re-derived from that session.
2. Track every requirement as satisfied, change_needed, unresolved, or not_applicable. Unresolved stays unresolved.
3. PM reads the guide: missing values, risks, verify/stop/recovery. Record accept or change-request as a structured HMAC grant bound to the same live read and revisions. An attestation kind name alone cannot grant.
4. Do not apply a setting. E13/E14 stay closed until separately approved.

## Explicit no

- No live read ran for this document.
- No `field_accepted`.
- No `integration_verified`.
- No merge of the stacked PRs to main.
- No E14 apply.
- No program / Epic #90 completion.
