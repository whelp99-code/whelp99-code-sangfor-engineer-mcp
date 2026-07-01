#!/usr/bin/env bash
set -euo pipefail

AGENT="${1:-}"
shift || true
REPO="$PWD"

if [[ -z "$AGENT" ]]; then
  echo "Usage: with-memory.sh <agent> [agent args...]" >&2
  exit 1
fi

if [[ -d "$REPO/memory" ]]; then
  echo "[memory] Onboarding for $REPO"
  if [[ -f "$REPO/memory/context/project-summary.md" ]]; then
    echo "===== project-summary ====="
    sed -n '1,120p' "$REPO/memory/context/project-summary.md"
  fi
  if [[ -f "$REPO/memory/tasks/active-tasks.md" ]]; then
    echo "===== active-tasks ====="
    sed -n '1,120p' "$REPO/memory/tasks/active-tasks.md"
  fi
  if [[ -f "$REPO/memory/agent-handoffs/latest-handoff.md" ]]; then
    echo "===== latest-handoff ====="
    sed -n '1,160p' "$REPO/memory/agent-handoffs/latest-handoff.md"
  fi
  if [[ -f "$REPO/memory/decisions/ADR-0000-index.md" ]]; then
    echo "===== adr-index ====="
    sed -n '1,120p' "$REPO/memory/decisions/ADR-0000-index.md"
  fi
  if [[ -f "$REPO/memory/risk/known-issues.md" ]]; then
    echo "===== known-issues ====="
    sed -n '1,120p' "$REPO/memory/risk/known-issues.md"
  fi
fi

set +e
"$AGENT" "$@"
EXIT_CODE=$?
set -e

if [[ -d "$REPO/memory" ]]; then
  echo "[memory] Handoff recorded for $REPO"
  if [[ -t 0 ]]; then
    read -r -p "Paste handoff notes (empty to skip): " HANDOFF || true
  else
    HANDOFF=""
  fi
  if [[ -n "${HANDOFF:-}" ]]; then
    cat > "$REPO/memory/agent-handoffs/latest-handoff.md" <<EOF2
# Latest Agent Handoff

## Current Goal
- Continue active work.

## Current Status
- In progress.

## Last Agent
- Agent: ${AGENT}
- Tool: with-memory wrapper
- Date: $(date +%Y-%m-%d)
- Branch: $(git -C "$REPO" branch --show-current 2>/dev/null || echo unknown)

## What Changed
| File | Change | Reason |
|---|---|---|
| N/A | Executed ${AGENT} | started via wrapper |

## Code Areas Reviewed
| Area | Method | Result |
|---|---|---|
| /memory | File read at start | Reviewed |

## Tests / Validation
| Command | Result | Notes |
|---|---|---|
| N/A | Not run | wrapper start |

## Important Decisions
- N/A

## Failed Attempts
- N/A

## Known Risks
- N/A

## Fragile Files
- TBD

## Do Not Touch
- `node_modules`, `.git`, build outputs.

## Next Recommended Actions
1. Continue from active tasks.

## Commit Readiness
- Not Ready
- Reason: Pending handoff review.
EOF2
  fi
fi

exit "$EXIT_CODE"
