# Rollout acceptance handoff

Issue #86 remains open. LightRAG is excluded. This packet records current evidence and missing inputs; it is not a CodeRabbit or human approval.

## Proven candidate

- Runtime implementation frozen in e65c9c8; f630655 updates only the reviewed handler test digest and its evidence. Source files still match the holdout-3 manifest.
- Three-stage evaluation history preserved, including two rejected candidates. Final frozen retrieval: 11/12 Hit@5, 0/12 no-answer false positives. Same-author synthetic questions with frozen translations.
- Actual local MCP source order matches all 24 rows. Saved client answers and exact citation audit cover 12 answers and 12 abstentions; independent semantic review has not occurred.
- f630655 passed all four required CI checks, local and BLRO 3,332 tests (102 environment-dependent skipped), lint/build, 118-tool smoke and browser boundary. Scorecard 96/100 is tool metadata quality, not answer accuracy.

## Stack and merge review

Fetched ancestry: main 9bd7769 → PR78 069df31 → PR81 2311c66 → PR83 d1fc62d → PR85 292eb11 → PR87 72e5a5b. Each preceding head is an ancestor of the next. These PRs target main; PR78 is still draft. No formal human reviews were returned for PR78 or PR87 at inspection.

`docs/CODE-REVIEW.md` requires human review for anything in its extra-scrutiny zones, including `@sangfor/hci-client`. The stack changes `inventory.ts` and `ops-monitor.ts` there: collection completeness, partial/failed distinction, timestamp freshness and PASS/FAIL/INDETERMINATE reporting. Passing tests do not substitute for that review. Gate/nonce/operator/shared source directories have no changed files in the inspected main-to-head diff. Do not force merge or bypass required review.

CodeRabbit 0.7.6 is present but its authentication status is false; login was initiated. No completed CodeRabbit review exists for this packet. An older bot-authored PR summary is not a final-head approval.

## BLRO release and inputs

Verified source archive SHA: `7401eca8536a3b74283c7d290e32c526795f478bb7c27b337f74a4bd9fca6644`.
Release: `/home/blro/orca/projects/sangfor-engineer-mcp/releases/f630655`.
Verified corpus: `/home/blro/orca/projects/sangfor-engineer-mcp/experiments/holdout3-runtime-f630655/corpus.json`, SHA `ff1118e44d4c1f21e7e465f6e1d66fcb0f4a08a09e9f1f7fbc098054c3febfa0`.

The release is STAGED_NOT_ACTIVATED. Root `start-mcp.sh` still launches the old root copy. The observed E5 8104 and Qwen 8109 processes are experiment services, not evidence of durable production service wiring. Use both `SANGFOR_RAG_INDEX_PATH` (MCP) and `SANGFOR_RAG_INDEX` (console) for the same verified corpus when configuring the operational release.

Required authority inputs are defined by `apps/control-tower/src/authority-config.ts`: credentialed PostgreSQL URL, tenant and project IDs, Ed25519 private key path, trust bundle path, and separate audit/approval secrets. Do not invent identities, copy unrelated application credentials, or publish secret values in review artifacts. The user has been asked for the existing configuration location, not secret contents.

Read-only discovery found no project `.env` at the root deployment or the older sangfor-os service path. `/srv/blro-data` and `/srv/blro-artifacts` contained only initial directories. The older sangfor-os compose mentions a different service layout and lacks its `.env`; this is not proof of current authority. The running evoharvest database belongs to another project and was not reused.

## Remaining order

1. Finish remote actual-MCP comparison and retain raw results.
2. Obtain actual review results and resolve actionable findings; confirm final CI. Human review of the HCI changes remains required by repository policy.
3. Verify operational configuration and database identity, signing/trust material and current schema using the existing readiness implementation. Never manufacture readiness from a live process or 2xx response.
4. Merge the reviewed stack in order, prepare the matching immutable operational artifact and durable service wiring, then verify readiness and actual search/answer read-back after activation.

The remote release needed `db:generate` after install and explicit zip/unzip availability. Official Ubuntu packages were extracted under the project's experiment tools directory without system package changes. An empty Git repository was initialized solely for root-resolution tests; it does not supply commit history.
