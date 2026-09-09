# E12 field-session checklist

Secret-free preparation for [#105](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/105). This is not a live session, not `field_accepted`, and not Phase A completion.

Do not put passwords, cookies, session material, or customer host addresses in git, Issues, or this file. Point at the approved private store after E02 operational confirmation.

## Gate

`evaluateEngineerFieldAcceptance` records refusals only. It never grants.

`evaluateEngineerFieldAcceptanceGrant` may set `field_accepted` only when all of the following hold together:

1. A live read actually executed, with `originalPresent === true` facts that went through `bindObservedFactToCase` / collect. HMAC binds the observation digest of those bound facts, not caller-chosen `executed` / `originalPresent` / `environmentKind` / `sourceKind` labels. `sourceKind: authorized_device_read` is derived only by the collect binder after every required surface binds. Fixture, synthetic live-shaped fixture, mock console, historical records, and attestation strings are not a live read.
2. A structured PM grant verifies with the existing `@sangfor/approval` HMAC primitive (`signDomainApproval` / `verifyDomainApprovalSignature`) over the grant domain, case/guide revision, and that observation digest, keyed only by the process environment `SANGFOR_ENGINEER_FIELD_ACCEPTANCE_SECRET`. A request-supplied secret is not read. Missing or empty secret fails closed. A raw string `pm_live_read_review` or a boolean JSON claim is not a grant. This is not a device-write approval and does not use `SANGFOR_OPERATOR_APPROVAL_SECRET`.
3. Case revision and guide revision on the grant, the live read, and the case under review are identical (matching revision). Mismatch refuses.
4. The grant nonce is consumed through the existing single-use nonce store. Replay refuses. A missing or corrupt nonce store fails closed.

Required conjunction: live originalPresent bound facts + structured HMAC PM grant + matching revision + consumed nonce.

When collect actually executes against an authorized device (declared target matches the in-process `endpointFor` identity origin; not mock `:3400`), those REST facts go through `bindHciCollectToFieldAcceptanceObservations` and are usable by `bindEngineerAuthorizedDeviceReadEvidence`. Firmware, collectedAt, volume_status_health, and E03B surfaces pass through only when collect returns them as `originalPresent === true` facts that bind through `bindObservedFactToCase`. Current HCI collect does not produce those facts; they stay `NOT_RUN`. Do not invent them from the collect timestamp, a firmware option, volume status, or provided-only E03B fields. Host/CPU/RAM/storage/network/HA stay unsupported unless explicitly provided or actually observed. Fixture clients, mock console, historical kinds, and invented collector bytes cannot mint `authorized_device_read`. The fixture workflow path still does not pass `boundObservations`.

Fixture PASS, `review_ready`, Word download, e2e PASS, developer tests, and `SANGFOR_ALLOW_REAL_EXECUTION` cannot set `field_accepted`. Required surfaces with no bound originalPresent facts stay `NOT_RUN` and refuse the grant; `NOT_RUN` is not PASS. A refused grant does not report `liveRead: executed` merely because the caller claimed it. This tree has not run a live HCI collect. A unit-test binder path can exercise the sibling true path; that path is not a production default and is not `field_accepted` for a real case. A real grant still cannot happen until a real collect produces those facts.

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
