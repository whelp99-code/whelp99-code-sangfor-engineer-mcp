#!/bin/zsh
# 재로그인(사람이 로그인 완료) → 세션 검증 → learn:all 재실행 (반자동 버튼 스크립트)

set -euo pipefail

REPO_DIR="${SANGFOR_REPO_DIR:-/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp}"
LOG_DIR="${SANGFOR_LOG_DIR:-$HOME/Library/Logs/sangfor-engineer-mcp}"

RUNTIME_DIR="${REPO_DIR}/data/runtime"
NEEDS_RELOGIN_FLAG="${RUNTIME_DIR}/needs-relogin.flag"

mkdir -p "${LOG_DIR}"
mkdir -p "${RUNTIME_DIR}"

TS="$(date '+%Y-%m-%d_%H-%M-%S')"
OUT_LOG="${LOG_DIR}/relogin-rerun.${TS}.out.log"
ERR_LOG="${LOG_DIR}/relogin-rerun.${TS}.err.log"

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

echo "[${TS}] 시작: login:one (브라우저 창에서 로그인 완료 필요)" | tee -a "${OUT_LOG}"

set +e
/bin/zsh -lc "corepack enable >/dev/null 2>&1 || true; corepack pnpm run login:one" \
  1>>"${OUT_LOG}" 2>>"${ERR_LOG}"
LOGIN_EXIT=$?
set -e

if [[ "${LOGIN_EXIT}" -ne 0 ]]; then
  notify "sangfor-engineer-mcp" "login:one 실패. 로그 확인 필요."
  echo "[${TS}] login:one 실패 (exit=${LOGIN_EXIT})" | tee -a "${OUT_LOG}"
  exit "${LOGIN_EXIT}"
fi

echo "[${TS}] verify:one 실행" | tee -a "${OUT_LOG}"
set +e
/bin/zsh -lc "corepack pnpm run verify:one" 1>>"${OUT_LOG}" 2>>"${ERR_LOG}"
VERIFY_EXIT=$?
set -e

if [[ "${VERIFY_EXIT}" -ne 0 ]]; then
  notify "sangfor-engineer-mcp" "verify:one 실패. 토큰/세션이 유효하지 않을 수 있습니다."
  echo "[${TS}] verify:one 실패 (exit=${VERIFY_EXIT})" | tee -a "${OUT_LOG}"
  exit "${VERIFY_EXIT}"
fi

rm -f "${NEEDS_RELOGIN_FLAG}" 2>/dev/null || true

echo "[${TS}] learn:nightly 재실행" | tee -a "${OUT_LOG}"
set +e
/bin/zsh -lc "export SANGFOR_CDP_URL='${SANGFOR_CDP_URL:-http://127.0.0.1:9222}'; export SANGFOR_GLASS_CDP_REQUIRED=1; corepack pnpm run learn:nightly" \
  1>>"${OUT_LOG}" 2>>"${ERR_LOG}"
LEARN_EXIT=$?
set -e

if [[ "${LEARN_EXIT}" -eq 0 ]]; then
  notify "sangfor-engineer-mcp" "재로그인 후 learn:all 재실행 성공"
  echo "[${TS}] 성공" | tee -a "${OUT_LOG}"
  exit 0
fi

notify "sangfor-engineer-mcp" "재로그인 후에도 learn:all 실패. 로그 확인 필요."
echo "[${TS}] learn:all 실패 (exit=${LEARN_EXIT})" | tee -a "${OUT_LOG}"
exit "${LEARN_EXIT}"
