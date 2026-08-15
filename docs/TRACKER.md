# Work tracker standard (mandatory)

**Primary tracker: GitHub Issues + labels.**  
**Not primary: Linear** (Orca Linear tab = reference only).

| Layer | System | Role |
|---|---|---|
| Work unit | **GitHub Issue** | What / why / status |
| Implementation | **JM** workstation | Code, commits, PRs |
| Verification | **GitHub Actions** | CI verify |
| Runtime (when applicable) | **BLRO** `ssh blro` | migrate/deploy/smoke |
| Sessions | Orca workspace tree | Agents/branches — not the backlog |

## Status labels

Use one `status:*` on open issues (Done = close).

- `status:backlog` · `status:in-progress` · `status:in-review` · `status:blocked`
- `ready-for-blro` — merged/verified; runtime apply remaining
- `ops` · `blro` · `agent` · `ci-blocked` · `tracker:github`

## Orca UI

1. **Daily board = GitHub Issues** for this repo (`./scripts/tracker.sh open`).
2. **Linear tab / WHE-*** = legacy reference only — do not plan new work there.
3. **Workspace board** = multi-repo/session glance, not issue source of truth.

If real work only exists on Linear: mirror into a GitHub Issue and continue on GitHub.

## Agent workflow

1. Open/update GitHub Issue first.
2. PR with `Closes #N` + PR template.
3. Actions CI green.
4. If runtime needed → `ready-for-blro` + `ops` + `blro` → apply on BLRO → evidence → close.
5. Prefer `gh issue` / `scripts/tracker.sh` over `orca linear`.

## CLI

```bash
./scripts/tracker.sh list
./scripts/tracker.sh blro
./scripts/tracker.sh open
```
