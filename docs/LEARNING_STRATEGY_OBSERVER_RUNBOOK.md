# Learning Strategy Observer Pilot Runbook

This runbook records pilot maturity without turning missing access, keys, or evidence into a pass. It is for the CC `3.0.98`, IAG `13.0.120`, and FortiOS `8.0` pilots described in the learning-strategy observer plan.

## Safety boundary

- Work is read-only. Do not log in automatically, click export controls, replay live requests, or change device configuration.
- Do not place passwords, cookies, tokens, device IPs, serial numbers, raw captures, or approval secrets in the manifest, Git, or command arguments.
- A live promotion still needs the existing action-bound, single-use learning approval. This manifest is evidence of pilot state, not an approval.
- `PASS` means the pilot evidence was checked. It never means that an unavailable device, missing key, or unrun operator window was successful.

## Manifest contract

Use [pilot-manifest.schema.json](acceptance/learning-strategy-observer/pilot-manifest.schema.json). Keep the working manifest outside Git with its local evidence root. The checked-in fixtures illustrate safe `BLOCKED` and `NOT_RUN` states only; they are not production evidence.

Each manifest has exactly these pilot IDs:

| Pilot | Product/version | Required external dependencies |
|---|---|---|
| `cc-3.0.98` | CC 3.0.98 | VPN, device, CDP, learning approval secret |
| `iag-13.0.120` | IAG 13.0.120 | VPN, device, CDP, learning approval secret |
| `fortios-8.0` | FortiOS 8.0 | lab device, learning approval secret, PostgreSQL mirror |

The acceptance test probes readiness only; it never opens a VPN, attaches CDP, contacts a device or database, or reads secret contents. Its inputs are deliberately narrow:

| Probe | Positive signal |
|---|---|
| VPN | `SANGFOR_PILOT_VPN_READY=1` |
| Device/lab | `SANGFOR_PILOT_DEVICE_READY=1` |
| Existing CDP session | `SANGFOR_PILOT_CDP_READY=1` |
| Learning approval secret | non-empty `SANGFOR_LEARNING_APPROVAL_SECRET` (presence only) |
| PostgreSQL mirror | `DATABASE_URL` starts with `postgres://` or `postgresql://` (presence only) |

The operator must independently confirm actual connectivity and authorization before setting any readiness signal. A presence probe is not a live connectivity assertion.

## State decision

1. Start with `NOT_RUN` and `OPERATOR_NOT_STARTED` before the approved observation window.
2. Use `BLOCKED` when a required dependency is absent or a listed user decision blocks the work. Record a non-empty, stable reason code such as `U_03_FORTIOS_8_LAB_UNAVAILABLE`; do not invent an evidence record.
3. Use `PASS` only after every required dependency is available, all evidence files are under the configured local evidence root, each is a regular non-symlink file, and each SHA-256 matches the manifest.
4. If an observation starts but cannot complete, retain the partial local evidence according to the encrypted-capture policy and record `BLOCKED`; do not relabel it `PASS` or delete it to hide the failure.

## Evidence checklist for a PASS

- [ ] Product, exact firmware identity, and reviewed Spec version were independently confirmed.
- [ ] Existing-CDP ownership, page-count, URL, protection window, and post-detach invariants passed.
- [ ] No browser storage mutation or mock/device write occurred.
- [ ] Each manifest evidence path is relative to the local evidence root, regular, non-symlink, non-empty, and SHA-256 verified.
- [ ] Evidence is sanitized: no credentials, cookies, token, IP, serial, raw payload, or secret is named in the manifest.
- [ ] CC/IAG have a real-file observation and the required human learning approval before any `strategy_field_verified` transition.
- [ ] FortiOS has an actual 8.0 lab observation and the required human learning approval before any `lab_verified` transition.
- [ ] PostgreSQL mirror state, if used, is recorded only as readiness/receipt metadata; captures remain local.

## Automated acceptance

Run the focused check during development:

```bash
pnpm test -- tests/learning-pilot-manifest.test.ts
```

The test rejects an empty/unknown status, a `PASS` without evidence, evidence outside the configured root, digest mismatch, a symlink, stale claimed dependency availability, and a `BLOCKED` state without an actual dependency or user-decision blocker. It also verifies the checked-in fixtures stay `BLOCKED`/`NOT_RUN` rather than fabricating a live result.

Before final delivery, include the normal repository gate from the plan:

```bash
pnpm test
pnpm run lint
pnpm run build
pnpm run test:observer:e2e
pnpm run smoke:mcp
```

## Reporting

Report code construction and field proof separately. When VPN, device, CDP, approval key, FortiOS 8.0 lab, or PostgreSQL is unavailable, report `코드 구축 완료 / 실증 BLOCKED` with the manifest reason code and the missing dependency. Do not push, merge, deploy, or commit local pilot evidence without separate authorization.
