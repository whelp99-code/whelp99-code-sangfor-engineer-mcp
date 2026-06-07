#!/bin/zsh
# Sangfor learn:all 반자동 러너 (macOS launchd용)
# - 매일 자동 실행
# - 인증/토큰 만료로 보이면 플래그 파일 생성 + macOS 알림
# - 상세 로그 파일 저장

set -euo pipefail

# macOS 기본값은 사용자의 로컬 레포 경로
# 다른 환경에서는 SANGFOR_REPO_DIR로 오버라이드 가능
REPO_DIR="${SANGFOR_REPO_DIR:-/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp}"
LOG_DIR="${SANGFOR_LOG_DIR:-$HOME/Library/Logs/sangfor-engineer-mcp}"

RUNTIME_DIR="${REPO_DIR}/data/runtime"
NEEDS_RELOGIN_FLAG="${RUNTIME_DIR}/needs-relogin.flag"

mkdir -p "${LOG_DIR}"
mkdir -p "${RUNTIME_DIR}"

TS="$(date '+%Y-%m-%d_%H-%M-%S')"
OUT_LOG="${LOG_DIR}/learnall.${TS}.out.log"
ERR_LOG="${LOG_DIR}/learnall.${TS}.err.log"
LATEST_OUT="${LOG_DIR}/learnall.latest.out.log"
LATEST_ERR="${LOG_DIR}/learnall.latest.err.log"

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

echo "[${TS}] 시작: pnpm run learn:all" | tee -a "${OUT_LOG}"

set +e
/bin/zsh -lc "corepack enable >/dev/null 2>&1 || true; corepack pnpm run learn:all" \
  1>>"${OUT_LOG}" 2>>"${ERR_LOG}"
EXIT_CODE=$?
set -e

cp -f "${OUT_LOG}" "${LATEST_OUT}"
cp -f "${ERR_LOG}" "${LATEST_ERR}"

if [[ "${EXIT_CODE}" -eq 0 ]]; then
  rm -f "${NEEDS_RELOGIN_FLAG}" 2>/dev/null || true
  notify "sangfor-engineer-mcp" "learn:all 완료"
  echo "[${TS}] 성공" | tee -a "${OUT_LOG}"
  exit 0
fi

echo "[${TS}] 실패 (exit=${EXIT_CODE})" | tee -a "${OUT_LOG}"

AUTH_REGEX='HTTP 401|401|unauthorized|Unauthorized|forbidden|Forbidden|invalid token|token|access_token|SANGFOR_ONE_ACCESS_TOKEN|library_token|login|SSO'

if /usr/bin/grep -Eqi "${AUTH_REGEX}" "${ERR_LOG}" "${OUT_LOG}" 2>/dev/null; then
  echo "[${TS}] 인증 이슈로 추정 → needs-relogin.flag 생성" | tee -a "${OUT_LOG}"
  echo "${TS} auth_or_token_issue_detected" > "${NEEDS_RELOGIN_FLAG}"
  notify "sangfor-engineer-mcp (재로그인 필요)" "인증/토큰 만료로 보입니다. 터미널에서: cd ${REPO_DIR} && pnpm run login:one  (완료 후: automation/scripts/relogin-and-rerun.sh 실행)"
else
  notify "sangfor-engineer-mcp" "learn:all 실패. 로그를 확인하세요: ${LOG_DIR}/learnall.latest.*.log"
fi

exit "${EXIT_CODE}"
