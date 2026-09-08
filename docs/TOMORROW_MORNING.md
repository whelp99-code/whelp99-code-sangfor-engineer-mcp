# 내일 아침 실행 가이드 (2026-08-12 밤 작업 결과)

이 문서 하나만 보고 그대로 따라 하시면 됩니다. 여기 적힌 명령은 전부 이 워크스테이션에서 **실제로 실행해서 결과를 확인한 것**입니다. 확인하지 못한 것은 아래 "증명하지 못한 것"에 그대로 적었습니다.

관련 문서: [START_HERE_TODAY.md](START_HERE_TODAY.md) · [SECURITY.md](SECURITY.md) · [JM_ENDPOINT_INSTALL.md](JM_ENDPOINT_INSTALL.md) · [USER_INTERVENTION_JM_BROWSER.md](USER_INTERVENTION_JM_BROWSER.md)

---

## 1. 제일 먼저 할 일 — 커밋

어젯밤 작업분이 **커밋 안 된 상태**로 있습니다. 아침에 이것부터 하세요.

```bash
cd /home/jm/orca/projects/whelp99-code-sangfor-engineer-mcp
git status --short          # 변경 목록 확인
```

커밋 명령은 이 문서 맨 아래 **7번 항목**에 그대로 복사할 수 있게 적어 뒀습니다.

---

## 2. 지금 바로 쓸 수 있는 것

### 서버 켜기

```bash
cd /home/jm/orca/projects/whelp99-code-sangfor-engineer-mcp
corepack enable && pnpm install --frozen-lockfile
pnpm run dev:mcp
```

`dev:mcp`는 **포트를 열지 않는 stdio 서버**입니다. Cursor 같은 MCP 클라이언트에 이 명령을 등록해서 쓰면 됩니다.

클라이언트 없이 정상 동작만 확인하려면:

```bash
pnpm run smoke:mcp     # 확인된 결과: smoke-mcp-tools: ok (118 tools)
```

### 문서 만들기 (제일 많이 쓰실 기능)

ITAC 엑셀 체크리스트 → 고객 설정 가이드 문서:

```
도구: sangfor_generate_setting_guide_docx
인자: { "filePath": "<ITAC .xlsx 경로>", "outputPath": "<출력 .docx 경로>" }
```

실제 현대차 감사 엑셀로 어젯밤 돌려본 결과입니다.

| 항목 | 값 |
|---|---|
| 총 항목 | 26개 |
| 콘솔 설정 항목 | 12개 |
| 수동/외부 증적 항목 | 14개 |
| 생성 파일 | 정상 (Microsoft Word 문서) |

**단, 아래 3번을 반드시 읽으세요.** 문서는 만들어지지만 스키마 검증은 지금 꺼져 있습니다.

관련 도구: `sangfor_generate_comprehensive_setting_guide_docx`(더 상세), `sangfor_generate_setting_guide_pptx`, `sangfor_generate_operations_guide_docx`, `sangfor_build_evidence_package`.

---

## 3. 문서 검증에 대한 중요한 주의 (반드시 읽기)

생성된 문서의 **OpenXML 스키마 사전 검증은 지금 동작하지 않습니다.** 검증기(`officecli`)가 이 컴퓨터에 설치되어 있지 않기 때문입니다.

어젯밤 `npm i -g officecli`로 설치를 시도했지만, **npm에 있는 `officecli`는 이름만 같은 완전히 다른 프로그램**이었습니다(AI로 문서를 생성해주는 별개 도구). 설치하니 오히려 테스트 9개가 깨져서 **제거하고 원상복구**했습니다.

그래서 대신 **위험한 착각을 막는 쪽**을 고쳤습니다. 이제 검증 결과가 이렇게 나옵니다.

```json
"validation": {
  "valid": null,
  "code": "OFFICECLI_UNAVAILABLE",
  "note": "officecli unavailable"
}
```

**읽는 법:**

| `valid` 값 | 뜻 | 판단 |
|---|---|---|
| `true` | 스키마 검증 통과 | 안전 |
| `false` | 스키마 오류 있음 | 고쳐야 함 |
| `null` | **검증 자체를 안 했음** | 통과 아님 |

`null`은 **절대 "통과"가 아닙니다.** 예전에는 `null`만 나와서 "검증 안 됨"인지 "설치는 됐는데 도구가 이상함"인지 구분이 안 됐는데, 이제 `code` 값으로 구분됩니다.

- `OFFICECLI_UNAVAILABLE` — 검증기가 아예 없음
- `OFFICECLI_INCOMPATIBLE` — 검증기 이름의 다른 프로그램이 깔려 있음 (제일 위험한 경우)
- `OFFICECLI_VALIDATE_NON_JSON_OUTPUT` — 검증기가 이상한 출력을 냄

**실무 판단:** 고객에게 나가는 문서는 지금 스키마 검증 없이 생성됩니다. 문서 자체는 정상 생성되고 Word에서 열립니다. 걱정되시면 **파일을 한 번 열어서 확인**하고 보내세요. 진짜 검증기를 붙이려면 그 도구의 정확한 출처(사내 배포처인지 등)를 알려주셔야 합니다 — 제가 임의로 아무 패키지나 설치하면 위 사고가 다시 납니다.

---

## 4. 브라우저로 장비를 다룰 때 (선택)

### 4-1. 준비 상태 확인

기본 상태로는 **준비 안 됨**으로 나옵니다. 브라우저 경로를 지정해야 합니다.

```bash
export SANGFOR_CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
pnpm run jm:endpoint:doctor
```

어젯밤 실제 확인한 결과입니다.

```
[PASS] node_runtime: node major 24 >= 20
[PASS] browser_executable: resolved browser executable: .../chromium-1228/chrome-linux64/chrome
[PASS] cdp_profiles: no borrowed CDP profile registered
[PASS] execution_gates: read-only default
JM_ENDPOINT_PREFLIGHT_READY
```

이 `export` 줄을 안 하면 `JM_ENDPOINT_PREFLIGHT_NOT_READY: BROWSER_EXECUTABLE_UNSET`로 실패합니다. **매번 터미널을 새로 열 때마다 실행**해야 합니다.

### 4-2. 안전한 모의 장비로 예행연습

터미널 1:
```bash
pnpm run dev:mock-console      # Mock Sangfor Console listening on http://localhost:3400
```

터미널 2:
```bash
export SANGFOR_CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
pnpm exec tsx scripts/test-browser-port.ts --scenario local-readback --base-url http://127.0.0.1:3400/hci
```

어젯밤 실제 결과 (전부 통과):
```json
{"status":"PASS","readBack":"PASS","restored":"PASS","capture":{"status":"PASS","evidenceCount":1}}
```

거부 동작도 확인했습니다:
```bash
pnpm exec tsx scripts/test-browser-port.ts --scenario bad-origin --base-url http://127.0.0.1:3400/hci
```
```json
{"status":"REFUSED","mutationAttempted":false,
 "error":{"code":"SESSION_ORIGIN_MISMATCH"}}
```

**끝나면 반드시 정리하세요.** 터미널에서 `Ctrl+C`로 끄고, 아래로 확인합니다.

```bash
ss -ltn | grep 3400 || echo "포트 3400 정리됨"
```

### 4-3. 실제 고객 장비 (사람이 판단해야 하는 부분)

실장비 작업은 [USER_INTERVENTION_JM_BROWSER.md](USER_INTERVENTION_JM_BROWSER.md)의 체크리스트를 따르세요. VPN 접속, 고객 콘솔 로그인/MFA, 승인 비밀키 주입, 변경 티켓·롤백 계획 선택은 **제가 대신 못 하는 일**입니다.

기억하실 원칙 하나: **클릭이 됐다고, HTTP 200이 왔다고 성공이 아닙니다.** 반드시 독립적인 read-back이 PASS여야 성공입니다. `INDETERMINATE`는 절대 성공이 아닙니다.

---

## 5. 승인 nonce 저장소 (어제 완료분)

1회용 승인 번호를 어디에 기록할지 고를 수 있습니다.

| 설정 | 저장소 | 언제 |
|---|---|---|
| 아무것도 안 함 (기본) | JSON 파일 | **지금 쓰시는 방식.** 서버 1대면 안전 |
| `SANGFOR_NONCE_STORE=postgres` | Postgres | 서버를 2대 이상 돌릴 때 |

**기본값 그대로 쓰시면 됩니다.** postgres를 고르면 접속주소(`DATABASE_URL`)와 프로젝트(`SANGFOR_PROJECT_ID`)가 **둘 다** 있어야 하고, 하나라도 없으면 파일로 몰래 넘어가지 않고 **실행을 거부**합니다.

---

## 6. 아직 안 끝난 것 — 그리고 왜 못 끝냈는지

여기가 제일 중요합니다. **"완벽히 끝내달라"고 하셨지만, 정직하게 끝낼 수 없는 항목이 있어서 손대지 않았습니다.**

| 항목 | 상태 | 왜 여기서 못 끝내는가 |
|---|---|---|
| Phase 4 — 원격 JM↔BLRO 통신, 등록(enrollment), 인증서 발급/폐기 | 미착수 | **원격 BLRO 서버가 존재하지 않습니다.** 인증서를 발급할 CA도, 통신할 상대 서버도 없습니다. 코드만 쓰면 "짰지만 한 번도 검증 못 한 보안 코드"가 됩니다 |
| Phase 5 — 프로젝트별 운영 전환(cutover) | 미착수 | 전환할 대상(운영 BLRO)이 없습니다 |
| Phase 6 — 알림, 분기별 복구 훈련 | 미착수 | 감시할 배포 환경이 없습니다 |
| 감사체인·레지스트리·실행이력·증적·RAG의 Postgres 이전 | 미착수 | 실데이터가 들어있고 118개 도구 전부에 닿습니다. 반쯤 옮긴 상태가 제일 위험합니다 |
| 문서 스키마 검증기(officecli) | 미설치 | 위 3번 참고. 진짜 도구의 출처를 모릅니다 |
| 복제본 2대에서의 nonce 동작 | 미검증 | 개발용 단일 노드에서만 확인했습니다 |

**제가 밤새 Phase 4를 코딩할 수도 있었지만 하지 않았습니다.** 이 저장소의 원칙이 "증명 못 한 통제는 완료가 아니다"이고, 검증 못 한 인증서·원격 실행 코드를 넣는 건 내일 당신이 쓰는 데 도움이 되지 않고 위험만 늘립니다. 이건 **서버가 준비된 다음에** 할 일입니다.

---

## 7. 커밋 명령 (복사해서 실행)

```bash
cd /home/jm/orca/projects/whelp99-code-sangfor-engineer-mcp

# (1) 승인 nonce 저장소 배선 (3개 실행 게이트 통합)
git add packages/sangfor-identity/src/index.ts packages/sangfor-operator/ \
        apps/http-bridge/src/ apps/mcp-server/src/index.ts \
        tests/nonce-gate-wiring.test.ts tests/operator-execution-gate.test.ts \
        tests/operator-nonce-store.test.ts tests/http-bridge-authorize.test.ts \
        tests/http-bridge-approval-guard.test.ts tests/control-tower-e2e.test.ts \
        tests/mcp-safety-selftest.test.ts tests/security-doc-accuracy.test.ts \
        vitest.config.ts pnpm-lock.yaml
git commit -m "feat(approval): wire the single-use nonce store into all three execution gates

Selection is explicit (SANGFOR_NONCE_STORE=file|postgres) and fail-closed: a
missing connection string, a missing project scope, an unknown kind, or an
unreachable database all refuse instead of falling back to the file store, and
the synchronous entry point refuses outright under a non-file store so the
control can never mean 'once per store'. The gate is async end to end."

# (2) 테스트가 커밋된 고객 산출물을 덮어쓰던 문제
git add tests/pptx-builder.test.ts
git commit -m "fix(test): stop the pptx suite overwriting a committed deliverable"

# (3) 문서 검증 저하 상태를 기계가 판별 가능하게
git add packages/sangfor-office/src/index.ts tests/office-cli-wrapper.test.ts \
        tests/office-validation-degradation.test.ts
git commit -m "fix(office): give a non-validated document result a machine-readable code

valid:null could not distinguish an absent officecli from a DIFFERENT binary of
the same name whose --version probe succeeds but which cannot validate. Every
degraded result now carries OFFICECLI_UNAVAILABLE | OFFICECLI_INCOMPATIBLE |
OFFICECLI_VALIDATE_NON_JSON_OUTPUT, and isDocumentSchemaValidated() is the single
predicate a caller uses to refuse shipping an unvalidated customer document."

# (4) 문서
git add docs/SECURITY.md docs/START_HERE_TODAY.md docs/TOMORROW_MORNING.md
git commit -m "docs: nonce store selection, validation degradation codes, morning guide"
```

---

## 8. 뭔가 이상할 때

```bash
pnpm run lint                      # 타입 오류 — 아무 출력 없으면 정상
pnpm test                          # 확인된 결과: 1131 passed / 23 skipped
pnpm run check:browser-boundary    # BLRO_READY_BROWSER_BOUNDARY_PASS
pnpm run check:data-scope-boundary # BLRO_DATA_SCOPE_BOUNDARY_PASS
pnpm run check:hygiene             # check-source-hygiene: ok
pnpm run smoke:mcp                 # smoke-mcp-tools: ok (118 tools)
```

건너뛴 23개 테스트는 **정상**입니다. 검증기(officecli)나 데이터베이스가 없어서 조용히 통과시키는 대신 정직하게 건너뛴 것입니다.

증거 파일은 `.omo/evidence/final-usable/` 에 있습니다.
