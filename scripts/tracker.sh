#!/usr/bin/env bash
# Open / list the primary work tracker (GitHub Issues — not Linear).
set -euo pipefail
REPO="${TRACKER_REPO:-whelp99-code/whelp99-code-sangfor-engineer-mcp}"
CMD="${1:-list}"

usage() {
  cat <<'EOF'
Usage: scripts/tracker.sh <command>

  list              Open issues (default)
  blro              Issues labeled ready-for-blro
  mine              Issues assigned to @me
  open              Open Issues page in a browser if possible
  open-blro         Open ready-for-blro filter in a browser
  web               Print tracker URLs

Primary tracker is GitHub Issues. Linear / Orca Linear tab is reference-only.
See docs/TRACKER.md.
EOF
}

open_url() {
  local url="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  fi
  printf '%s\n' "$url"
}

case "$CMD" in
  -h|--help|help) usage ;;
  list)
    gh issue list --repo "$REPO" --limit "${2:-30}"
    ;;
  blro)
    gh issue list --repo "$REPO" --label ready-for-blro --limit "${2:-30}"
    ;;
  mine)
    gh issue list --repo "$REPO" --assignee @me --limit "${2:-30}"
    ;;
  open)
    open_url "https://github.com/${REPO}/issues"
    ;;
  open-blro)
    open_url "https://github.com/${REPO}/issues?q=is%3Aissue+is%3Aopen+label%3Aready-for-blro"
    ;;
  web)
    cat <<EOF
Issues:     https://github.com/${REPO}/issues
BLRO queue: https://github.com/${REPO}/issues?q=is%3Aissue+is%3Aopen+label%3Aready-for-blro
Labels:     https://github.com/${REPO}/labels
Milestones: https://github.com/${REPO}/milestones
EOF
    ;;
  *)
    usage
    exit 2
    ;;
esac
