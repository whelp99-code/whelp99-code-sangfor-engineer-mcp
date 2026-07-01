# Shared Agent Memory Contract

This repository uses the Shared Agent Memory System at `./memory`.

## On session start
Read in order:
1. `memory/context/project-summary.md`
2. `memory/tasks/active-tasks.md`
3. `memory/agent-handoffs/latest-handoff.md`
4. `memory/decisions/ADR-0000-index.md`
5. `memory/risk/known-issues.md`

## During work
- Update `memory/tasks/active-tasks.md` when you start or block a task.
- Append to `memory/evidence/*.md` with command, result, and date after meaningful checks.
- Record irreversible decisions in `memory/decisions/` using the existing template.

## On session end
1. Write a handoff to `memory/agent-handoffs/latest-handoff.md`.
2. Move completed tasks to `memory/tasks/completed-tasks.md`.
3. Leave explicit `Next Recommended Actions` in the handoff.

## Rules
- Do not create files outside `memory/` for agent state.
- Do not overwrite non-empty files unless it is the designated latest state file.
- Mask secrets/credentials before writing anything to disk.
