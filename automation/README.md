# macOS 반자동 운영 가이드 (Notification + 재로그인 후 재시도 자동)

요구사항:
- (1) 매일 02:00에 `learn:all` 자동 실행
- (2) 매일 03:00에 `learn:kb:full` 자동 실행 (Glass CDP **9222** 고정)
- (3) 토큰/인증 만료로 실패하면 **알림(Notification)** 으로 알려주기
- (4) 사용자가 재로그인(사람이 수행)하면, **검증+재실행** 은 스크립트 1번으로 자동 처리

## 0) 전제
- 레포 경로: `/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp`
- `.env`가 레포 루트에 존재해야 합니다.
- `corepack` / `pnpm` 사용

참고:
- 스크립트는 기본 레포 경로를 위 값으로 사용하지만, 필요하면 `SANGFOR_REPO_DIR` 환경변수로 오버라이드할 수 있습니다.

## 1) 파일 배치
이 폴더의 파일들을 레포에 그대로 두면 됩니다.
- `automation/scripts/run-learnall.sh`
- `automation/scripts/run-learn-kb-full.sh`
- `automation/scripts/relogin-and-rerun.sh`
- `automation/com.jmpark.sangfor.learnall.plist`
- `automation/com.jmpark.sangfor.learnkb.plist`

## 2) 실행 권한 부여
```bash
cd "/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp"
chmod +x automation/scripts/run-learnall.sh
chmod +x automation/scripts/run-learn-kb-full.sh
chmod +x automation/scripts/relogin-and-rerun.sh
```

## 3) launchd 등록 (매일 02:00 자동 실행)
```bash
cp "/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/automation/com.jmpark.sangfor.learnall.plist" \
  "$HOME/Library/LaunchAgents/com.jmpark.sangfor.learnall.plist"

launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.jmpark.sangfor.learnall.plist"
launchctl enable "gui/$(id -u)/com.jmpark.sangfor.learnall"
```

## 3b) launchd 등록 (매일 03:00 KB full learn — Glass CDP 9222)

Glass 브라우저에서 `knowledgebase.sangfor.com` 파트너 로그인 상태를 유지한 채 CDP 포트가 열려 있어야 합니다.

`.env` 예시:
```bash
SANGFOR_CDP_URL=http://127.0.0.1:9222
SANGFOR_GLASS_CDP_REQUIRED=1
```

```bash
cp automation/com.jmpark.sangfor.learnkb.plist \
  "$HOME/Library/LaunchAgents/com.jmpark.sangfor.learnkb.plist"

launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.jmpark.sangfor.learnkb.plist"
launchctl enable "gui/$(id -u)/com.jmpark.sangfor.learnkb"
```

CDP 확인:
```bash
pnpm run check:glass-cdp
```

설계: `docs/design/KB_DAILY_CDP_AUTOMATION.md`

### 즉시 1회 실행(테스트)
```bash
launchctl kickstart -k "gui/$(id -u)/com.jmpark.sangfor.learnall"
```

## 4) 로그 위치
- `~/Library/Logs/sangfor-engineer-mcp/learnall.latest.out.log`
- `~/Library/Logs/sangfor-engineer-mcp/learnall.latest.err.log`

## 5) 알림이 “재로그인 필요”로 뜨면
터미널에서 아래 1줄만 실행하면 됩니다:
```bash
"/Users/jmpark/Documents/Playground/whelp99-code-sangfor-engineer-mcp/automation/scripts/relogin-and-rerun.sh"
```

이 스크립트가:
1) `pnpm run login:one` (브라우저에서 로그인 완료)
2) `pnpm run verify:one`
3) `pnpm run learn:all` 재실행
까지 자동으로 진행합니다.

## 6) 중지/삭제
```bash
launchctl disable "gui/$(id -u)/com.jmpark.sangfor.learnall"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.jmpark.sangfor.learnall.plist"
rm -f "$HOME/Library/LaunchAgents/com.jmpark.sangfor.learnall.plist"
```
