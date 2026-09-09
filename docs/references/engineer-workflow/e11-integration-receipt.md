# E11 integration receipt

Secret-free evidence for [#104](https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/issues/104). This is a fixture harness compose after independent REJECT of `0114163`. It is not field acceptance, not `integration_verified`, and not program completion.

| Field | Value |
| --- | --- |
| unit | E11 |
| issue | #104 |
| baseCommit | `ae3d190d1f7ba25fb817095fe43cddc93139ee22` (`origin/codex/engineer-e10b-guide-preview`) |
| composedDomain | E08 `493ba66c91b28639d5742ea690abf8035f75326f` (includes E07 `4ef1f42498ba51402966bece8b7457f9bde2e30a`) |
| previous rejected head | `011416384bfb8395660c9352e915624aa54c9fd8` |
| environmentKind | fixture |
| fixtureOrLive | fixture |
| capturedAt | 2026-09-10 |
| liveProof | false |
| field_accepted | false |
| guideReadyGranted on assemble | false |
| review_ready treated as field_accepted | false |
| developer tests treated as field acceptance | false |
| integration_verified | no |
| Phase A complete | no |
| E12/E13/E14 started | no |
| supportedScope | fixture HCI existing + new-build path after composing the independently reviewed domain stack onto the persist/UI stack |
| reviewer | not assigned; developer report only |

## Compose

Merge commit of independently reviewed E08 onto the rejected E11 persist harness. Conflict resolution did not invent assess/guide behavior:

- assess/guide/Word/required-observations: E08
- store/API/UI: persist stack
- overlapping E04/E05 blobs were already identical
- `tests/engineer-guide-export.test.ts`: E08
- `report-docx.ts` package relationships namespace: E08
- planner/product-adapter index re-exports: union without duplicate `ingestEngineerRequirements`

`runEngineerWorkflow` now calls, in order: `collectInventory` → `ingestEngineerRequirements` → `evaluateEngineerFormula` → `assessEngineerCase` → `buildEngineerGuide` → `saveEngineerCase` → `exportEngineerGuide`. Step status `ran` is set only after those functions return. File existence is not used.

Persist remaps readiness through `prepareEngineerCaseForPersistence` / `computeEngineerGuideDigest`. UI preview and Word/review JSON use that remapped document, whose steps come from `buildEngineerGuide`.

## Independent oracle

Hand arithmetic, not a pipeline golden. File sha256 `657deb4cd0e54bddb6675bccc946f129209910a6f56af28742525bdc451b6d7c`.

| Formula | Inputs | Expected |
| --- | --- | --- |
| confirmed-remaining-capacity | total 100 GiB, used 40 GiB | 60 GiB |
| confirmed-utilization-ratio | total 100 GiB, used 40 GiB | 40 percent |
| demand-headroom | remaining 60 GiB, demand 20 GiB | 40 GiB |

Unknown host fields stay unknown, not 0. Volume-status health PASS is not copied into capacity/HA assessments. Capacity formulas use provided 100/40/20 GiB operands, not inventory `size`.

## Tracking (existing fixture)

Requirement tracking is assessed-requirement coverage, not `requirements.length === 0 ? 0 : 1`. Executable-step tracking is tracked E07 steps / defined steps; empty `[]` is 0, not 100%. Required fields come from E03A inventory field status plus E03B `collectRequiredObservations` (host/CPU/RAM/storage/network/HA stay unsupported unless explicitly provided).

On the existing fixture run: 2/2 requirements assessed (rate 1), defined guide steps > 0 with requirementRefs/verify/stop/recovery (rate 1), `fieldAccepted` false, `completedNormally` false.

Requirement edit stales linked calculations through assessment `calculationRefs`. Collect failure keeps `completedNormally` false and now refuses Word (`COLLECTION_FAILED`); export success is not workflow success. Capacity assessment compares stored `calc-headroom` (40 GiB) to the parseable `>= 20 GiB` constraint.

## Commands

| commandOrProcedure | exitCode | pass/fail/not_run |
| --- | --- | --- |
| Independent `evaluateEngineerFormula` 100/40/20 GiB | 0 | 60 GiB / 40 percent / 40 GiB; missing used → `MISSING_INPUTS:used` |
| `TMPDIR=/home/jm/.cache/sangfor-e11 pnpm exec vitest run --config vitest.config.ts tests/engineer-workflow-e2e.test.ts` | 0 | pass (12/12) |
| related engineer + lock + boundary (`e2e`, `guide-export`, `persist`, `api`, `review-ui`, `contract`, `assessment`, `guide-grounding`, `calc`, `required-observations`, `hci-collection`, `requirements`, `authority-manifest-lock`, `runtime-boundary-contract`, `authority-migration-manifest`, `wiki-decomposition`) | 0 | pass (152) |
| `pnpm run lint` | 0 | pass |
| `pnpm run build` | 0 | pass |
| `pnpm run test:postgres:mandatory` | 1 | not_run (`MANDATORY_POSTGRES_DATABASE_REQUIRED`; no isolation DB). not_run ≠ PASS |
| `pnpm test` | — | **NOT re-run in full** this follow-up. Targeted lock + runtime-boundary now pass. skip≠PASS |
| historical 26-item workbook sha256 `20e99de99a04b349a4ec82bad18c383eddb869973498ba11aeb729ac2e4eda79` | — | not_run (file not in this tree). not_run ≠ PASS |

Skipped Vitest cases in the default suite are not counted as PASS.

## Follow-ups after ACCEPT WITH FOLLOW-UPS

| leftover | result |
| --- | --- |
| Word on collect-fail | Fixed. `exportEngineerGuide` returns `COLLECTION_FAILED` and writes no docx. Pipeline keeps `completedNormally === false`. |
| UNPARSEABLE_CONSTRAINT hides compare | Fixed. `%` now parses. E11 fixture constraint is `usable storage headroom >= 20 GiB`. Assess compares stored `calc-headroom` (40 GiB) to that requirement. |
| Authority lock census | Fixed. Lock rewritten with `deriveAuthorityManifestLock` + live `loadRepositoryCensus` (`fe7ce72a…`). E08 `exportEngineerGuide` / `writeConfinedDocxArchive` owned under generated-artifacts. |
| persistence `JSON.parse` | Fixed. Both sites use `parseRuntimeJson`. Not skipped. |
| `freshnessIssue: storedCalc ? undefined : stale` | Fixed. Observation freshness is voided only when the stored calculation is the compared current (`storedCalc.id === compareCurrentRef`). A known stale observation still reports `STALE_INPUT` even if a matching stored calc exists. Substitute path stays `derived` / `stored-calculation`. Unknown stays unknown. |

Neither leftover is BLOCKED. This receipt is still fixture evidence, not `field_accepted`.

## Artifact digests (inputs, not generated Word)

| path | sha256 |
| --- | --- |
| `tests/fixtures/engineer-workflow/e11-oracle.json` | `657deb4cd0e54bddb6675bccc946f129209910a6f56af28742525bdc451b6d7c` |
| `tests/fixtures/engineer-workflow/cases/existing-hci-health.json` | `82a4caecbe781fed57fbe3ebaf17fcb82b214f04a3acfb9cc330214fc6f9c45e` |
| `tests/fixtures/engineer-workflow/synthetic/existing-hci-inventory.json` | `567a5525c8ef8c52327a20648b02ce5b3aa14ed19b9e6c0a7634504864a698f0` |
| `tests/fixtures/engineer-workflow/synthetic/existing-hci-requirements.json` | `64c4e19c3c3cd83246dae1e4d1f9387661c8f53b8bb30d31529dc7e6b08316fd` |

Generated Word/JSON live under `TMPDIR` and are not retained as goldens.

## Unresolved

- This remains a fixture harness. `field_accepted` is false. `integration_verified` is not granted. Phase A is not complete.
- Postgres/RLS isolation DB and historical 26-item xlsx are NOT_RUN ≠ PASS.
- Actions CI on this stacked PR targeting `codex/engineer-e10b-guide-preview` is NOT_RUN ≠ PASS.
- E12/E13/E14 were not started. #90 remains open.
- Authority lock census and persistence `JSON.parse` were fixed on this follow-up; they are not skipped.
