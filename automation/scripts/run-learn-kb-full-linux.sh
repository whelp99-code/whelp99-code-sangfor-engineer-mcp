#!/usr/bin/env bash
# Linux runner for the KB full-site collection loop.
#
# The original run-learn-kb-full.sh targets macOS: /bin/zsh -lc, osascript
# notifications, and a launchd plist. On Linux none of that exists, which is why
# the KB collector never ran on this host and needs-glass.flag sat unread from
# 2026-08-11 onward.
#
# Behaviour is otherwise identical: check the CDP precondition first, and if it
# is not satisfied drop needs-glass.flag and exit non-zero instead of pretending
# a crawl happened.
#
#   bash automation/scripts/run-learn-kb-full-linux.sh
#
# Schedule with systemd --user or cron, e.g.
#   0 3 * * *  cd <repo> && bash automation/scripts/run-learn-kb-full-linux.sh
set -euo pipefail

REPO_DIR="${SANGFOR_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LOG_DIR="${SANGFOR_LOG_DIR:-$HOME/.local/state/sangfor-engineer-mcp/logs}"
CDP_URL="${SANGFOR_CDP_URL:-http://127.0.0.1:9222}"
FLAG_DIR="$REPO_DIR/data/runtime"
GLASS_FLAG="$FLAG_DIR/needs-glass.flag"

mkdir -p "$LOG_DIR" "$FLAG_DIR"
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
LOG_FILE="$LOG_DIR/learn-kb-full-$STAMP.log"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }

notify() {
  # Best-effort desktop notification; never fail the run because it is absent.
  command -v notify-send >/dev/null 2>&1 && notify-send "Sangfor KB" "$1" || true
  log "NOTIFY: $1"
}

cd "$REPO_DIR"

log "CDP health check: $CDP_URL"
if ! curl -sf --max-time 10 "$CDP_URL/json/version" >/dev/null 2>&1; then
  printf '%s glass_cdp_unreachable\n' "$STAMP" > "$GLASS_FLAG"
  notify "CDP $CDP_URL 미응답 — 브라우저를 CDP 9222로 열고 KB 로그인 후 재시도"
  log "BLOCKED: CDP unreachable; wrote $GLASS_FLAG"
  exit 2
fi

# CDP is up. Confirm a logged-in KB tab exists before crawling: connecting to a
# browser without a KB session produces login shells, not knowledge.
if ! pnpm run check:glass-cdp >>"$LOG_FILE" 2>&1; then
  printf '%s glass_kb_tab_missing\n' "$STAMP" > "$GLASS_FLAG"
  notify "CDP는 열렸지만 KB 로그인 탭이 없음 — knowledgebase.sangfor.com 로그인 필요"
  log "BLOCKED: CDP up but no logged-in KB tab; wrote $GLASS_FLAG"
  exit 3
fi

# Precondition satisfied: clear any stale block before running.
rm -f "$GLASS_FLAG"
log "CDP ready; starting learn:kb:full"

if pnpm run learn:kb:full >>"$LOG_FILE" 2>&1; then
  log "OK: learn:kb:full completed"
else
  status=$?
  notify "learn:kb:full 실패 (exit $status) — 로그: $LOG_FILE"
  log "FAILED: learn:kb:full exit $status"
  exit "$status"
fi
