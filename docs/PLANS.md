# Plans — process & conventions

How planning artifacts are organized in [plans/](plans/). Folder = type; the `Status` header = lifecycle.

## Where things go
- **`plans/designs/NNN-name.md`** — permanent design references (architecture, API specs, tradeoffs). `Status: Draft | Approved`. When a decision is settled and verified in code, promote a summary into [design-docs/](design-docs/index.md).
- **`plans/work/NNN-name.md`** — execution plans with progress and a decision log. `Status: Active | Completed`.
- **`plans/work/tech-debt-tracker.md`** — the running debt list.
- `NNN` is a 3-digit sequential prefix per folder (`001-…`).

`plans/` holds **local working notes** and is gitignored. Anything meant to be permanent and reviewed belongs in `design-docs/` (committed).

## Work-plan template
```markdown
# NNN — <title>

**Status:** Active | Completed
**Owner:** <who>
**Related:** <design-doc / spec / issue links>

## Goal
<one paragraph: what done looks like, and the acceptance check>

## Steps
- [ ] Step 1 — <smallest safe change> — test: <command/assertion>
- [ ] Step 2 — ...

## Decision log
- YYYY-MM-DD: <decision> — <why>

## Verification
<the exact commands run and their observed result — evidence, not assertion>
```

## Conventions specific to this repo
- **TDD-leaning**: there is a test suite per feature (see `tests/`). A plan step that changes behavior names its test up front.
- **Safety steps are explicit**: any step touching a gate/approval/execution path states the fail-closed behavior it must preserve and the refusal test that proves it.
- **Smallest reversible step first**: prefer dry-run/preview and additive changes; sequence irreversible work behind gates and human sign-off.
- **Verify with evidence**: a step isn't done until `pnpm test && pnpm run lint` (and any relevant smoke script) is shown passing. Never claim done without the output.

## Relationship to skills
When an OMA planning skill (`oma-pm`, `oma-architecture`) or a superpowers plan workflow produces a plan, drop the artifact here so the next session/agent can pick it up.
