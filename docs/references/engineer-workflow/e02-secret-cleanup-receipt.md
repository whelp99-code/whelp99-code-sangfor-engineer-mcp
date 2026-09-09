# E02 secret cleanup receipt

Value-less receipt for [#94](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/94). This file must not contain live hosts, usernames paired with secrets, or passwords.

## Evidence

- unit: E02
- issue: 94
- baseCommit: `cd8e44db41b8fcd7aad4d6c052c3dd008c1e27d4`
- commit: see pull-request head
- environmentKind: repository-docs
- capturedAt: 2026-09-09
- fixtureOrLive: fixture
- supportedScope: current-tree sanitization of named evidence documents
- reviewer: not-yet — developer receipt only

## Code PR checkbox

- status: in_development until the pull request is opened
- current_tree_sanitized: yes
- files_rewritten_with_placeholders:
  - `docs/M4_HCI_API_SPIKE_RUNBOOK.md`
  - `outputs/diagnosis/HCI_SCP_real_device_smoke_2026-07-02.md`
- check_method: `docs/SECURITY.md` Secret handling; `tests/engineer-secret-cleanup.test.ts`
- scanner_echoes_secret_text: no
- artifactDigest_sha256:
  - `docs/M4_HCI_API_SPIKE_RUNBOOK.md` `c8fbc04017b37f06a9250081cd55990ba6f7f752bc828d2e9d66d9346ec6e7c7`
  - `outputs/diagnosis/HCI_SCP_real_device_smoke_2026-07-02.md` `aafd2d3c62a589c62f0a5a7ba2a543286d4d80c8cb01c99f083c55519d3fba47`
  - `docs/SECURITY.md` `57f8e79e95aabed643d381d3bce3208767096ff3a65a1427fe862ab56f42beeb`
  - `tests/engineer-secret-cleanup.test.ts` `402ee0473c103da27a4d88ec04c8ea6c18994399429ca30c32de0b5f2efac985`

## Operations checkbox (separate)

- credential_rotation: not_run
- history_rewrite: not_run
- live_device_access: not_run
- owner_confirmation: missing
- leak_response_complete: no

Current-tree sanitization is not a complete leak response. Deleting or masking HEAD content does not expire the previously published value and does not rewrite Git history.

A person with authority over the approved private store must confirm whether the previously exposed value is still valid and, if it is, dispose or replace it. This plan does not rotate device passwords.

Until that confirmation exists, field access must not use a value recovered from Git history or from a prior document revision.

## Safe credential source for later field work

- Approved private store injects `SANGFOR_HCI_IDENTITY_URL`, `SANGFOR_HCI_TENANT`, `SANGFOR_HCI_USER`, and `SANGFOR_HCI_PASSWORD`.
- Replay path: `scripts/hci-real-smoke.ts` (env only; no literals).
- Do not invent replacement strings that look like customer credentials.

## Locations recorded (paths only)

- plaintext secret class: `docs/M4_HCI_API_SPIKE_RUNBOOK.md` (STATUS and blocker notes)
- host/account class: `outputs/diagnosis/HCI_SCP_real_device_smoke_2026-07-02.md`

## Known leftovers outside this change set

These still contain historical host stamps or a lab-credential-class fixture string. They are not this receipt's sanitized set. They are not claimed clean.

- `packages/sangfor-hci-client/src/token-provider.ts` and `data/hci-api/catalog.json` (historical contract stamp; tests pin the string)
- `docs/skills/itac-console-login.md` and capture scripts (lab host inventory, vault/env passwords)
- `tests/hci-audit-ledger.test.ts` (masking fixture uses a lab-credential-class mock, not the runbook secret)
- Git history of the rewritten files

## Unresolved

- credential_rotation remains not_run
- history_rewrite remains not_run
- Issue #94 stays open until operations confirmation exists
