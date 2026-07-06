# Code Review

Review standards for sangfor-engineer-mcp. This is a security-critical codebase that drives real device changes — reviews weigh **safety and honesty above all**.

## Severity levels
- **Blocker** — must fix before merge. Any safety-gate weakening, false-PASS risk, secret leak, unsafe bind, or dependency-direction violation.
- **Major** — fix before merge or file as tracked debt with rationale. Missing test on a changed safety path, un-masked persistence, broken fail-closed default.
- **Minor** — should fix. Naming/idiom drift, missing citation on an advisory, docs not updated with the change.
- **Nit** — optional polish.

## Every-PR checklist
1. **Safety gates intact?** No test weakens a gate to pass. New write/execution routes through `assertRealExecutionAllowed` (or an equally strong action-bound HMAC), consumes a single-use nonce, and defaults to dry-run. (Blocker if violated.)
2. **No false PASS.** Unknown/uncaptured → `null`/empty/`unsourced`/INDETERMINATE, never a fabricated or defaulted value. INDETERMINATE is never rendered as PASS; a 2xx is never treated as success. (Blocker.)
3. **Fail closed.** Missing secret/service/file, ambiguous locator, non-loopback bind without token → refuse. (Blocker.)
4. **Secrets masked before persistence** (`maskSecrets`); no credential/lab-token committed; `.env` untouched. (Blocker.)
5. **Dependency direction** points downward (L0→L3, ARCHITECTURE.md); no L1→L2/L3 import; new logic lives in a **package**, not an app handler. (Major.)
6. **Tests present** for the changed behavior, importing package `src/` directly per repo convention; safety paths get an explicit refusal test. (Major.)
7. **Evidence & audit** — device-affecting changes write to the run/audit ledger and (browser) capture screenshots. (Major.)
8. **Citations** — advisories/plans cite their source manual/section. (Major for advisory changes.)
9. **Docs** — if behavior, ports, env vars, or gates changed, the relevant `docs/*` and `AGENTS.md` are updated (no drift). (Minor–Major.)

## Extra scrutiny zones (review slowly)
`@sangfor/operator` (approval, nonce, execution gate) · `@sangfor/hci-client` (apply-machine, read-back, audit-ledger) · `apps/http-bridge/tool-guard.ts` · `@sangfor/shared` bind-safety · anything touching `SANGFOR_ALLOW_*` env vars or `maskSecrets`.

## Anti-patterns to flag
- A gate turned into a warning/log instead of a throw.
- `dryRun` defaulting to `false`, or a mock path fabricating an "Executed" result.
- Catching an error and continuing where the safe move is to refuse.
- Storing an un-masked arg/result; logging a token/password/cookie.
- Widening `shared`'s dependencies (it must stay a leaf) or importing upward across layers.
- New vendor logic added to the `evaluateSpec` engine instead of as a spec + client mapper.

## Auto-approve vs. request human review
- **May auto-approve:** pure additive spec/mapper data, docs, tests, non-safety refactors that keep behavior and pass `pnpm test && pnpm run lint`.
- **Require human review:** anything in the extra-scrutiny zones, any change to a gate/approval/nonce, any new server bind, any live-execution path. Verify with evidence (test output), not assertion — see [../AGENTS.md](../AGENTS.md) quick rules.
