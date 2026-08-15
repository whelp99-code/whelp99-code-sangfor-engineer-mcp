## Summary
<!-- What changed and why (1–5 sentences). -->

## Tracker
- Closes #
- Status after merge: <!-- none | ready-for-blro -->

## BLRO
- [ ] **No** BLRO apply needed (docs/CI/code-only)
- [ ] **Yes** BLRO apply needed → create/keep issue labeled `ready-for-blro` + `ops` + `blro`

## Verification
- [ ] Relevant unit/typecheck ran (commands + exit 0)
- [ ] CI expected green (Actions is the Docker gate when local Docker is absent)
- Commands:

```text
```

## Security / tenancy
- [ ] No new IDOR / trust of client tenancy
- [ ] No secret committed (`.env` untracked)

## Irreversible ops (must NOT run in this PR unless explicitly delegated)
- [x] No production mail send
- [x] No unapproved prod data destroy
- [ ] migrate deploy (only on BLRO with approval/delegation)
- [ ] ground-truth / corpus import (only on BLRO with approval/delegation)

## Agent notes
- Primary tracker: **GitHub Issues** (not Linear).
- JM = implement; Actions = verify; BLRO = `ssh blro` runtime.
