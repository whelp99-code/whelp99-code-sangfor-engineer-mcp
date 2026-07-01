# 실장비 설정 진단 런북 (Service 3 — 진단)

> AI 자문 모델의 Service 3(진단)을 실장비에서 end-to-end로 수행하는 정식 절차.
> **전 과정 read-only.** AI는 어떤 장비 설정도 변경하지 않는다. 사람이 최종 확인·조치.

## 파이프라인

```
로그인(콘솔 유형별) → ConfigState 추출 → evaluateSpec(제품 매뉴얼 근거 spec) → 한국어 진단 리포트(md/docx)
```

## 1. 로그인 (콘솔 유형별)

| 콘솔 | URL | 계정 | CAPTCHA | 방법 |
|------|-----|------|---------|------|
| EPP (Vue SPA) | 10.80.1.106 | admin / `Itac123!@#` | randcode(있음) | `scripts/device-login.ts` — captcha PNG 저장→`.code` 대기(내가 vision으로 읽음)→입력 |
| CC (Vue SPA) | 10.80.1.107 | admin / `Itac123!@#` | req_captcha(있음) | 동일 |
| IAG (ExtJS) | 10.80.1.108 | admin / `Itac123#@!` | 없음 | aside repl (자체서명 인증서: "고급"+`#proceed-link`, 제출은 password `.press('Enter')`) |

**CAPTCHA 처리법:** 새로고침 없이 라이브 captcha를 스크린샷 → vision(Claude)이 읽음 → 즉시 입력. captcha 오류는 계정 잠금과 무관.
**함정:** 재시도 전 `pkill -9 -f chrome-sangfor-debug`(프로필 싱글톤 락). connectOverCDP는 `session.cdpEndpoint`(http).

## 2. ConfigState 추출 (콘솔 유형별 — 방법이 갈린다)

- **Vue SPA (EPP/CC): 콘솔 자신의 인증 XHR 응답 캡처** — `scripts/device-collect.ts`가 로그인+메뉴 순회하며 `POST /api/edrgoweb/v1/{module}/{action}` → `{code,msg,data}` 구조화 JSON을 풀에 저장. `scripts/epp-diagnose.ts`가 풀→flat observed 매핑.
  - 유용 EPP 엔드포인트: `patch/statistics`(isLatest), `vulner/list/homepageVulner`, `baseline/getRule`, `domain_detect/get_domain_info`, `cnapp/.../dar/...`.
  - 직접 API 재호출(page.request)은 CSRF/세션으로 **실패** → 브라우저 자신의 XHR 캡처가 정답.
- **ExtJS (IAG): aside repl `snapshot()`** — Playwright XHR 캡처는 235개 라벨 클릭해도 CGI 2개만 잡힘(ExtJS 최악 케이스). aside snapshot이 렌더된 DOM을 직접 읽어 실 값 추출(버전/HA/세션/자산/보안이벤트). deep config(로그 보존/웹인증/802.1X)는 해당 config 페이지로 aside 네비게이션 필요(미방문 시 정직하게 INDETERMINATE).

## 3. 평가 + 리포트 (MCP 도구)

`sangfor.evaluate_config` 도구:
```json
{ "product": "EPP", "version": "6.0.4",
  "observed": { "patchIsLatest": true, "vulnerabilityCount": 0, ... },
  "docxPath": "outputs/diagnosis/EPP_6.0.4_live_diagnosis.docx" }
```
→ `{ result(요약: 잘못됨/추가필요/판정불가/정상), report(한국어 md), docx }`

**안전 원칙(코드 강제):** INDETERMINATE는 절대 PASS 아님. 미확인 설정값·근거 없는 must는 판정 불가 → 종합 "조치 필요". false-pass 방지.

`sangfor.list_spec_coverage` — 어떤 제품/버전 spec이 있는지. `sangfor.capability_safety` — safety_class(기본 human_only)/maturity.

## 4. Spec 시드 (제품 매뉴얼 근거)

`data/specs/{PRODUCT}/{version}/*.json` — SpecItem: `{observedKey, op, expected, severity(must|recommended), source(매뉴얼 인용)}`. 매뉴얼은 support.sangfor.com에서 수집(→`docs/PROPOSAL_ADDENDUM_A...`, memory). 현재: EPP 6.0.4(6), IAG 13.0.120(5).

## 산출물 예시 (2026-07-01 실장비)

- `outputs/diagnosis/EPP_6.0.4_live_diagnosis.{md,docx}` — 정상5/판정불가1 (patch 최신, 취약점0, 베이스라인 구성; 멀웨어 스케줄 판정불가)
- `outputs/diagnosis/IAG_13.0.120_live_diagnosis.{md,docx}` — 정상1/추가필요1(HA 비활성)/판정불가3

## 다음 개선

- IAG deep config: aside로 Audit/Auth/802.1X 페이지 개별 네비→판정불가 해소.
- EPP 멀웨어 스케줄: Defense 정책 페이지 심화 네비.
- device-collect + aside를 단일 MCP 도구(`sangfor.collect_device_config`)로 통합(현재는 스크립트 + evaluate_config 도구).
