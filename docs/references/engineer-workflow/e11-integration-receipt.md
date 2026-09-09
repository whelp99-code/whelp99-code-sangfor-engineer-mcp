# E11 integration receipt

Secret-free evidence for [#104](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/104). This is not field acceptance, not `integration_verified`, and not program completion.

| Field | Value |
| --- | --- |
| unit | E11 |
| issue | #104 |
| baseCommit | `ae3d190d1f7ba25fb817095fe43cddc93139ee22` (`origin/codex/engineer-e10b-guide-preview`) |
| commit | this PR head on `codex/engineer-e11-integration` |
| environmentKind | fixture |
| fixtureOrLive | fixture |
| capturedAt | 2026-09-10 |
| liveProof | false |
| field_accepted | false |
| review_ready treated as field_accepted | false |
| developer tests treated as field acceptance | false |
| supportedScope | fixture HCI existing + new-build path on the unmerged persist stack; assess/guide package exports absent |
| reviewer | not assigned; developer report only |

## Independent oracle

Hand arithmetic, not a pipeline golden. File sha256 `657deb4cd0e54bddb6675bccc946f129209910a6f56af28742525bdc451b6d7c`.

| Formula | Inputs | Expected |
| --- | --- | --- |
| confirmed-remaining-capacity | total 100 GiB, used 40 GiB | 60 GiB |
| confirmed-utilization-ratio | total 100 GiB, used 40 GiB | 40 percent |
| demand-headroom | remaining 60 GiB, demand 20 GiB | 40 GiB |

Unknown host fields stay unknown, not 0. Volume-status health PASS is not copied into capacity/HA assessments.

## Commands

| commandOrProcedure | exitCode | pass/fail/not_run |
| --- | --- | --- |
| `TMPDIR=/home/jm/.cache/sangfor-e11 pnpm exec vitest run --config vitest.config.ts tests/engineer-workflow-e2e.test.ts` | 0 | pass (12/12) |
| related engineer tests (`engineer-guide-export`, `engineer-case-persistence`, `engineer-case-api`, `engineer-case-review-ui`, `engineer-case-contract`) | 0 | pass (56) |
| `pnpm run lint` (after `pnpm exec prisma generate` in this fresh worktree) | 0 | pass |
| `pnpm run build` | 0 | pass |
| `pnpm run smoke:mcp` | 0 | pass (118 tools; no engineer-case MCP export path on this head) |
| `pnpm run check:browser-boundary` | 0 | pass |
| `pnpm run check:data-scope-boundary` | 0 | pass |
| `pnpm run check:hygiene` | 0 | pass |
| `pnpm test` | 1 | fail: 3390 passed, 102 skipped, 2 failed (inherited, recorded below) |
| `pnpm run test:postgres:mandatory` | 1 | not_run (`MANDATORY_POSTGRES_DATABASE_REQUIRED`; no isolation DB). not_run ≠ PASS |
| historical 26-item workbook sha256 `20e99de99a04b349a4ec82bad18c383eddb869973498ba11aeb729ac2e4eda79` | — | not_run (file not in this tree). not_run ≠ PASS |

Skipped Vitest cases are the existing 102 skips in the default suite. They are not counted as PASS.

## Inherited known fails (not skipped, not weakened)

| test | observation |
| --- | --- |
| `tests/authority-manifest-lock.test.ts` | lock `repositoryCensusDigest` `4cfb9c9a…` ≠ computed census `4f5383b3…`. E09B-owned lock; this PR does not rewrite it. |
| `tests/runtime-boundary-contract.test.ts` | `engineer-case-persistence.ts` lines 157 and 419 still use `JSON.parse`. E10B guide path already uses `parseRuntimeJson`. Out of E11 scope. |

## Artifact digests (inputs, not generated Word)

| path | sha256 |
| --- | --- |
| `tests/fixtures/engineer-workflow/e11-oracle.json` | `657deb4cd0e54bddb6675bccc946f129209910a6f56af28742525bdc451b6d7c` |
| `tests/fixtures/engineer-workflow/cases/existing-hci-health.json` | `82a4caecbe781fed57fbe3ebaf17fcb82b214f04a3acfb9cc330214fc6f9c45e` |
| `tests/fixtures/engineer-workflow/synthetic/existing-hci-inventory.json` | `567a5525c8ef8c52327a20648b02ce5b3aa14ed19b9e6c0a7634504864a698f0` |
| `tests/fixtures/engineer-workflow/synthetic/existing-hci-requirements.json` | `5317a01c42b42e9ea5cb9fcdd31d86990611681d9d4d759f94954880d11b3f1a` |

Generated Word/JSON live under `TMPDIR` and are not retained as goldens.

## Unresolved on this stacked head

- `assessEngineerCase` and `buildEngineerGuide` are absent (`ASSESS_EXPORT_ABSENT`, `GUIDE_EXPORT_ABSENT`). Pipeline `completedNormally` is false. Guide steps are empty, so executable-step tracking is not a field-ready 100%.
- Requirement edits mark the guide stale. Calculations stay known because the stale-calc graph is assessment-linked and assessments are empty. That is not fabricated unknown.
- Persist stack is not merged with the E08 domain stack. E11 does not merge stacked PRs.
- Postgres/RLS and historical original replay are NOT_RUN.
- Fixture identity is not live proof. E12/E13/E14 were not started. #90 remains open.
