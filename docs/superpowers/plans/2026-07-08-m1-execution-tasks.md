# M1 실행 태스크 (동생 에이전트용 상세 분해) — 2026-07-08

> **읽는 법:** 이 문서는 `2026-07-08-six-month-roadmap.md`의 **M1**을 "다른(저렴한) 에이전트가 아무 사전지식 없이 바로 실행"할 수 있게 태스크 카드로 쪼갠 것이다. 각 카드는 **Files / Interfaces / Steps(TDD) / Commands / Acceptance** 를 갖는다. 순서는 의존성 순. §5 안전 불변식·§6 품질 게이트(로드맵)는 전부 암묵 준수. `grep`은 `/usr/bin/grep` 사용.
>
> **레퍼런스 구현 = T-M1-EPP(완료, 커밋 `1371a72`).** CC/IAG는 이 커밋의 diff를 그대로 본떠라: `packages/sangfor-config-state/src/index.ts`(매퍼 keymap 확장), `scripts/epp-diagnose.ts`(shallow+deep 풀 union), `tests/config-state.test.ts`(fixture 케이스). **바로 개발하려면 `git show 1371a72` 부터 읽어라.**

**선행 조건(장비 태스크 공통):** FortiClient VPN 연결 필요. 확인 = `curl -sk -o /dev/null -w "%{http_code}" https://10.80.1.107/` 가 000이 아니어야. 000이면 사용자에게 재연결 요청(BLOCKED). 자격증명은 **env로만**(repo/커밋 금지): CC `SANGFOR_CC_PASSWORD`, IAG `SANGFOR_IAG_PASSWORD`, EPP `SANGFOR_EPP_PASSWORD`(세션마다 로테이션될 수 있으니 사용자에게 현재값 확인).

---

## T-M1-EPP — EPP 판정불가 축소 ✅ 완료 (커밋 `1371a72`)
결과: 판정불가 10→2(pass 10/fail 2/indet 2). 남은 2개(`malwareScanScheduleEnabled`, `endpointIsolationConfigured`)는 machine-readable 출처 없어 정직하게 INDETERMINATE 유지. **CC/IAG의 템플릿이므로 diff를 읽고 그대로 따라 할 것.**

---

## T-M1-CC — CC 판정불가 5개 축소 (⚠️ VPN 필요)
**목표:** CC 3.0.98 판정불가 5개(`ntpSynced`, `activeEventSources`, `alertChannelConfigured`, `alarmTuningConfigured`, `syslogForwardingConfigured`)를 실장비 심화캡처 + 매퍼 확장으로 줄인다. **주의: `alertChannelConfigured`·`alarmTuningConfigured`는 이미 `CC_KEYMAP`에 있다**(엔드포인트 `POST /apps/secvisual/alarm/alarm_policy/on_list`) — 그 페이지만 캡처되면 자동 매핑. 나머지 3개만 신규 keymap 필요.

**Files:**
- 캡처: `/tmp/dev-captcha/CC_deep_pool.json` (신규, 장비에서)
- Modify: `packages/sangfor-config-state/src/index.ts` (`CC_KEYMAP`에 항목 추가)
- Modify: `scripts/cc-diagnose.ts` (shallow+deep 풀 union — epp-diagnose와 동일 패턴)
- Modify: `tests/config-state.test.ts` (CC fixture 케이스에 신규 키 assert)

**Interfaces:** `mapCcPoolToConfigState(pool, {collectedAt, collector})` → `{observed, mappedKeys, ...}`. `CC_KEYMAP` 항목 형태 = `{ key, endpoint(전체 'POST /...'), pick: (d)=>value }`. **CC keymap은 EPP와 달리 prefix 없이 full endpoint를 쓴다**(그래서 `full` 필드 불필요).

**Steps:**
1. **(장비, read-only) 심화 캡처.** `scripts/device-collect.ts` 참고해 `/tmp` 탐색 스크립트로 CC의 System 하위 config 뷰 페이지를 연다: 시간/NTP · 이벤트소스/자산연동 · **알람 정책**(`alarm/alarm_policy/on_list` XHR 유발) · Syslog/로그전달. 캡처된 XHR을 `/tmp/dev-captcha/CC_deep_pool.json`에 저장. CC 콘솔 로딩 60~90초 느림·로그인 false-positive 주의(대시보드 진입으로 로그인 확인). CAPTCHA는 Read(비전)→`.code` 기록. **버튼(save/apply/enable) 클릭 금지.**
2. **응답 구조 확인.** `node -e "const p=require('/tmp/dev-captcha/CC_deep_pool.json'); Object.keys(p).forEach(k=>console.log(k))"` 로 캡처 엔드포인트 확인. 5개 키 각각의 값이 어느 응답의 어느 필드인지 실제 JSON을 보고 확정(추정·날조 금지). 값 없으면 not-machine-exposed로 남긴다.
3. **매퍼 확장.** `CC_KEYMAP`에 신규 3개 추가(값이 실제로 있는 것만):
   - `ntpSynced` ← NTP 설정 응답의 동기화 상태 필드
   - `activeEventSources` ← 이벤트소스 목록 응답의 활성 개수/배열 length
   - `syslogForwardingConfigured` ← Syslog 설정 응답의 enable 필드
   `pick` 은 값 없으면 `undefined` 반환(→ 자동 생략 → INDETERMINATE). **fabricate 금지.**
4. **diagnose union.** `scripts/cc-diagnose.ts`가 `{...shallow, ...deep}` 풀을 읽도록 수정(`git show 1371a72 -- scripts/epp-diagnose.ts` 그대로 본뜸).
5. **fixture 테스트.** `tests/config-state.test.ts`의 CC describe에 신규 키 3개를 inline fixture로 assert(값 매핑 + source.endpoint). 미노출 키는 `not.toHaveProperty`로.
6. **재진단.** `npx tsx scripts/cc-diagnose.ts` → `outputs/diagnosis/CC_3.0.98_*` 갱신.

**Commands / Acceptance:**
```
npx vitest run --config vitest.config.ts tests/config-state.test.ts   # green
npm test && npm run lint                                              # 무회귀 + 0
```
수용: CC 판정불가가 축소(가능분 매핑, 미노출은 라벨링); 신규 매핑 전부 실관측 근거; 전체 스위트 green. **EPP와 동일하게 커밋 1개 → chore로 FF 머지.**

---

## T-M1-IAG — IAG live deep-config 파이프라인 (⚠️ VPN 필요, probe 선행)
**문제:** `scripts/iag-diagnose.ts`는 라이브 풀을 안 쓰고 엔지니어 수동관찰값(provenance=manual)을 하드코딩한다(주석: "Vue SPA does not expose these settings as machine-readable fields"). live 캡처는 인증+라이선스 1엔드포인트만 나왔다.

**Steps:**
1. **(장비) probe.** IAG deep-config(802.1X, 로그보존, 웹인증) 페이지를 열어 **XHR로 값이 나오는지** 확인. 나오면 → 5(a), Vue SPA라 DOM 렌더값만이면 → 5(b).
2a. **API 노출 시:** `mapIagPoolToConfigState`(신설 or 기존) 매퍼에 keymap 추가 + `iag-diagnose.ts`가 live 풀 소비(provenance=live). EPP/CC 패턴 동일.
2b. **DOM만일 시:** 특정 페이지의 렌더된 설정값을 **read-only DOM 스크레이프**하는 수집기(`scripts/iag-dom-collect.ts` 신규 or `device-collect`에 DOM 모드) — Playwright `page.locator(...).innerText()` 로 값 읽기(클릭=네비만, mutation 버튼 금지). 값을 provenance=live로 매핑.
3. **불가 항목은 provenance=manual 유지**(솔직 라벨, 억지 채움 금지).

**Acceptance:** IAG 리포트의 각 항목에 provenance(live/manual)가 정확히 표기됨; live 가능분은 실장비 값 반영; `npm test && npm run lint` green.

---

## T-M1-SAFENAV — safe-nav 뷰/버튼 분리 (안전 스파인, ⚠️ 메인 루프/신중)
**문제:** `packages/sangfor-collector/src/safe-nav.ts`의 `isSafeNavLabel`이 액션 단어(isolate/격리/생성...)를 포함한 **뷰 페이지 라벨**(Endpoint Isolation, Device Control)까지 막아 심화 네비를 차단한다. 뷰 열람은 read-only라 안전 — mutation **버튼** 클릭만 막으면 된다.

**Files:** Modify `packages/sangfor-collector/src/safe-nav.ts`; Test `tests/`(신규 or 기존 safe-nav 테스트).

**Steps (TDD):**
1. 실패 테스트: `isSafeNavLabel('Endpoint Isolation')` 는 true(뷰 네비 허용) 기대, `isSafeNavLabel('Save')`/`'Apply'`/`'격리 실행'` 은 false(버튼 거부) 기대.
2. 구현: 좌측/상단 **네비 메뉴 라벨**과 **액션 버튼**을 구분. 예 — nav 메뉴 라벨은 허용, denylist는 버튼 텍스트에만 적용(수집기가 nav 클릭과 버튼 클릭을 다른 경로로 처리하도록). 또는 denylist를 "정확히 이 단어로 끝나는 버튼형" 으로 좁히되, **삭제/저장/적용/생성/enable/isolate 실행형은 반드시 계속 거부**.
3. refusal 테스트로 "mutation 버튼은 여전히 거부" 증명(무회귀).

**Acceptance:** 뷰 네비 라벨 허용 + 모든 mutation 버튼 거부; `npm test` green. **불변식: 이 변경이 write 버튼 클릭 가능성을 절대 열지 않음**(리뷰 필수).

---

## T-M1-SECRETS — 수집 스크립트 랩 비밀번호 제거 (tech-debt #D-a)
**문제:** `scripts/device-collect.ts` 등이 `pass: process.env.X ?? 'Itac123...'` 로 랩 비번을 fallback 하드코딩(env override는 됐으나 소스+git history에 잔존). CODE-REVIEW Blocker(무커밋 시크릿).

**Files:** Modify `scripts/device-collect.ts`(+ 유사 스크립트 `epp-*`, `cc-*`, `iag-*`, `hci-real-smoke.ts` 점검).

**Steps:**
1. 하드코딩 fallback 제거 → env-required fail-closed: `const pass = process.env.SANGFOR_EPP_PASSWORD; if (!pass) { console.error('set SANGFOR_EPP_PASSWORD'); process.exit(1); }` 형태(제품별).
2. `/usr/bin/grep -rnE "Itac123|Sangfor123" scripts/` 로 잔여 0 확인.
3. **git history 정리(사용자 결정):** 과거 커밋의 랩 비번은 BFG/`git filter-repo` rewrite 여부를 사용자에게 확인(로드맵 §9-2). 강제로 history 손대지 말 것.

**Acceptance:** `grep`으로 소스 내 랩 비번 0; 스크립트는 env 없으면 fail-closed; 실행은 env로 정상.

---

## T-M1-DEEPCOLLECT — 심화수집 재현가능화 (선택, CC/IAG 안정화 후)
**목표:** 임시 탐색 스크립트로 하던 심화 네비게이션을 `scripts/device-collect.ts`(또는 `device-collect-deep.ts`)에 흡수해 `PRODUCT=EPP DEEP=1 ...` 1커맨드로 재현. `collect_device_config` MCP 도구도 심화 경로 반영.

**Acceptance:** 1커맨드로 deep 풀 재생성; 문서(runbook)에 절차 기록.

---

## 완료 정의(M1 전체)
- EPP ✅ / CC · IAG 판정불가 축소(가능분) 및 provenance 정직 라벨.
- safe-nav 뷰/버튼 분리(안전 무회귀) · 스크립트 시크릿 0.
- `npm test`(무회귀+신규 통과) · `npm run lint`(0) · UI영향 시 `npm run test:ui`.
- 각 태스크 커밋 1+ → **chore로 FF 머지**(지난 세션 패턴). 실장비 write는 이 단계에 없음(전부 read-only).
- **대체율 갱신은 M2**(evidence 부착 후 field_verified 승격).
