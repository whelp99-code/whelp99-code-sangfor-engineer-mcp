#!/bin/zsh
# Daily KB full learn via fixed Glass CDP (port 9222)
# - CDP health check
# - pnpm run learn:kb:full
# - auth/CDP failure → flag + macOS notification

set -euo pipefail

REPO_DIR="${SANGFOR_REPO_DIR:-/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp}"
LOG_DIR="${SANGFOR_LOG_DIR:-$HOME/Library/Logs/sangfor-engineer-mcp}"
CDP_URL="${SANGFOR_CDP_URL:-http://127.0.0.1:9222}"

RUNTIME_DIR="${REPO_DIR}/data/runtime"
NEEDS_RELOGIN_FLAG="${RUNTIME_DIR}/needs-relogin.flag"
NEEDS_GLASS_FLAG="${RUNTIME_DIR}/needs-glass.flag"

mkdir -p "${LOG_DIR}"
mkdir -p "${RUNTIME_DIR}"

TS="$(date '+%Y-%m-%d_%H-%M-%S')"
OUT_LOG="${LOG_DIR}/learn-kb-full.${TS}.out.log"
ERR_LOG="${LOG_DIR}/learn-kb-full.${TS}.err.log"
LATEST_OUT="${LOG_DIR}/learn-kb-full.latest.out.log"
LATEST_ERR="${LOG_DIR}/learn-kb-full.latest.err.log"

notify() {
  local title="$1"
  local message="$2"
  if command -v osascript >/dev/null 2>&1; then
    /usr/bin/osascript -e "display notification \"${message}\" with title \"${title}\""
  else
    echo "[notify] ${title}: ${message}" | tee -a "${OUT_LOG}"
  fi
}

cd "${REPO_DIR}"

echo "[${TS}] CDP health: ${CDP_URL}" | tee -a "${OUT_LOG}"
if ! /usr/bin/curl -sf --max-time 5 "${CDP_URL}/json/version" >/dev/null 2>&1; then
  echo "[${TS}] CDP unreachable" | tee -a "${OUT_LOG}"
  echo "${TS} glass_cdp_unreachable" > "${NEEDS_GLASS_FLAG}"
  notify "sangfor-engineer-mcp (Glass 필요)" "CDP ${CDP_URL} 에 연결할 수 없습니다. Glass 브라우저를 열고 KB에 로그인하세요."
  exit 2
fi

rm -f "${NEEDS_GLASS_FLAG}" 2>/dev/null || true

echo "[${TS}] Safari token refresh (best-effort)" | tee -a "${OUT_LOG}"
set +e
/bin/zsh -lc "corepack enable >/dev/null 2>&1 || true; corepack pnpm run login:one:safari" \
  1>>"${OUT_LOG}" 2>>"${ERR_LOG}"
set -e

echo "[${TS}] learn:kb:full (CDP=${CDP_URL})" | tee -a "${OUT_LOG}"
set +e
/bin/zsh -lc "export SANGFOR_CDP_URL='${CDP_URL}'; export SANGFOR_GLASS_CDP_REQUIRED=1; corepack pnpm run learn:kb:full" \
  1>>"${OUT_LOG}" 2>>"${ERR_LOG}"
EXIT_CODE=$?
set -e

cp -f "${OUT_LOG}" "${LATEST_OUT}"
cp -f "${ERR_LOG}" "${LATEST_ERR}"

if [[ "${EXIT_CODE}" -eq 0 ]]; then
  rm -f "${NEEDS_RELOGIN_FLAG}" 2>/dev/null || true
  notify "sangfor-engineer-mcp" "learn:kb:full 완료"
  echo "[${TS}] 성공" | tee -a "${OUT_LOG}"
  exit 0
fi

echo "[${TS}] 실패 (exit=${EXIT_CODE})" | tee -a "${OUT_LOG}"

AUTH_REGEX='HTTP 401|401|unauthorized|Login|library_token|token_by_code|KB session not ready|Missing KB token'

if /usr/bin/grep -Eqi "${AUTH_REGEX}" "${ERR_LOG}" "${OUT_LOG}" 2>/dev/null; then
  echo "${TS} kb_auth_issue" > "${NEEDS_RELOGIN_FLAG}"
  notify "sangfor-engineer-mcp (재로그인)" "KB 세션 만료로 보입니다. Glass에서 KB 로그인 후 relogin-and-rerun.sh 실행"
else
  notify "sangfor-engineer-mcp" "learn:kb:full 실패. 로그: ${LOG_DIR}/learn-kb-full.latest.*.log"
fi

exit "${EXIT_CODE}"
