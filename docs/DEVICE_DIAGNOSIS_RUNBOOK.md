# 실장비 설정 진단 런북 (Service 3 — 진단)

> AI 자문 모델의 Service 3(진단)을 실장비에서 end-to-end로 수행하는 정식 절차.
> **전 과정 read-only.** AI는 어떤 장비 설정도 변경하지 않는다. 사람이 최종 확인·조치.

## 파이프라인

```
로그인(콘솔 유형별) → ConfigState 추출 → evaluateSpec(제품 매뉴얼 근거 spec) → 한국어 진단 리포트(md/docx)
```

## 1. 로그인 (콘솔 유형별)

| 콘솔 | URL | 계정 주입 | CAPTCHA | 처리 방법 |
|------|-----|----------|---------|----------|
| EPP (Vue SPA) | 10.80.1.106 | `SANGFOR_EPP_PASSWORD` 환경변수 | randcode(있음) | `scripts/device-collect.ts` 실행 후 `/tmp/dev-captcha/EPP.png`를 사람이 확인하고 `/tmp/dev-captcha/EPP.code`에 즉시 입력 |
| CC (Vue SPA) | 10.80.1.107 | `SANGFOR_CC_PASSWORD` 환경변수 | req_captcha(있음) | `scripts/device-collect.ts` 실행 후 `/tmp/dev-captcha/CC.png`를 사람이 확인하고 `/tmp/dev-captcha/CC.code`에 즉시 입력 |
| IAG (ExtJS) | 10.80.1.108 | `SANGFOR_IAG_PASSWORD` 환경변수 | 없음 | 자체서명 인증서 경고를 사람이 승인한 뒤 로그인하고 aside repl로 캡처 |
| 
| **중요:** 이 문서와 저장소에는 실제 비밀번호를 기록하지 않는다. 런북에 남아 있던 credential-like 문자열은 즉시 폐기·교체하고, 유효한 자격증명은 사람이 보안 채널로 주입한다. |
| **실행 전:** 로컬 `.env`에 값을 입력한 뒤 `set -a; source .env; set +a`로 현재 셸에만 주입한다. `SANGFOR_EPP_PASSWORD`, `SANGFOR_CC_PASSWORD`, `SANGFOR_IAG_PASSWORD`, `SANGFOR_DEVICE_SCOPE`, `SANGFOR_CAPTURE_BUNDLE_KEYS`, `SANGFOR_CAPTURE_BUNDLE_ACTIVE_KEY_ID`가 필요하다. `SANGFOR_DEVICE_SCOPE`는 제품명이나 IP가 아닌 lowercase non-PII UUIDv7이어야 한다(예: `018f22e2-79b0-7cc3-8c3c-0f8e5d50a2bf`). `SANGFOR_CAPTURE_BUNDLE_KEYS`는 key id별 32-byte AES key의 base64 JSON이고 active key id가 그 JSON의 key와 일치해야 한다. `.env` 값은 명령행·로그·원장에 넣지 않는다.
| **로그인 실패 처리:** `LOGIN_FAIL`이면 CAPTCHA를 재사용하지 말고 새로고침 후 새 이미지를 확인한다. 3회 실패 시 중단하고 계정 잠금 여부와 자격증명을 사람이 확인한다. 성공 전에는 ConfigState를 생성하거나 승격하지 않는다.
| **CAPTCHA 처리법:** `device-collect.ts`는 CAPTCHA를 새로고침 없이 캡처한 뒤 `ocrCaptcha()`의 Tesseract→LM Studio→OpenAI Vision(설정된 경우)→Hermes fallback을 먼저 사용한다. OCR backend가 없거나 실패하면 `/tmp/dev-captcha/<PRODUCT>.code`에 사람이 정확한 4자리 코드를 입력한다. 로그인 성공 URL을 확인하기 전에는 성공으로 간주하지 않는다.
| **함정:** 재시도 전 `pkill -9 -f chrome-sangfor-debug`는 프로필 싱글톤 락이 확인된 경우에만 사람이 실행한다. connectOverCDP는 `session.cdpEndpoint`(http)를 사용한다.

## 2. ConfigState 추출 (콘솔 유형별 — 방법이 갈린다)

- **Vue SPA (EPP/CC): 콘솔 자신의 인증 XHR 응답 캡처** — `scripts/device-collect.ts`가 로그인+메뉴 순회하며 `POST /api/edrgoweb/v1/{module}/{action}` → `{code,msg,data}` 구조화 JSON을 풀에 저장. `scripts/epp-diagnose.ts`가 풀→flat observed 매핑.
  - 유용 EPP 엔드포인트: `patch/statistics`(isLatest), `vulner/list/homepageVulner`, `baseline/getRule`, `domain_detect/get_domain_info`, `cnapp/.../dar/...`.
  - 직접 API 재호출(page.request)은 CSRF/세션으로 **실패** → 브라우저 자신의 XHR 캡처가 정답.
- **ExtJS (IAG): aside repl `snapshot()`** — Playwright XHR 캡처는 235개 라벨 클릭해도 CGI 2개만 잡힘(ExtJS 최악 케이스). aside snapshot이 렌더된 DOM을 직접 읽어 실 값 추출(버전/HA/세션/자산/보안이벤트). deep config(로그 보존/웹인증/802.1X)는 해당 config 페이지로 aside 네비게이션 필요(미방문 시 정직하게 INDETERMINATE).

## 3. 평가 + 리포트 (MCP 도구)

`sangfor_evaluate_config` 도구:
```json
{ "product": "EPP", "version": "6.0.4",
  "observed": { "patchIsLatest": true, "vulnerabilityCount": 0, ... },
  "docxPath": "outputs/diagnosis/EPP_6.0.4_live_diagnosis.docx" }
```
→ `{ result(요약: 잘못됨/추가필요/판정불가/정상), report(한국어 md), docx }`

**안전 원칙(코드 강제):** INDETERMINATE는 절대 PASS 아님. 미확인 설정값·근거 없는 must는 판정 불가 → 종합 "조치 필요". false-pass 방지.

`sangfor_list_spec_coverage` — 어떤 제품/버전 spec이 있는지. `sangfor_capability_safety` — safety_class(기본 human_only)/maturity.

## 4. Spec 시드 (제품 매뉴얼 근거)

`data/specs/{PRODUCT}/{version}/*.json` — SpecItem: `{observedKey, op, expected, severity(must|recommended), source(매뉴얼 인용)}`. 매뉴얼은 support.sangfor.com에서 수집(→`docs/PROPOSAL_ADDENDUM_A...`, memory). 현재: EPP 6.0.4(14), IAG 13.0.120(5).

## 산출물 예시 (2026-07-01 실장비)

- `outputs/diagnosis/EPP_6.0.4_live_diagnosis.{md,docx}` — 정상5/판정불가1 (patch 최신, 취약점0, 베이스라인 구성; 멀웨어 스케줄 판정불가)
- `outputs/diagnosis/IAG_13.0.120_live_diagnosis.{md,docx}` — 정상1/추가필요1(HA 비활성)/판정불가3

## 다음 개선

- IAG deep config: aside로 Audit/Auth/802.1X 페이지 개별 네비→판정불가 해소.
- EPP 멀웨어 스케줄: Defense 정책 페이지 심화 네비.
- `sangfor_collect_device_config`(`apps/mcp-server/src/index.ts`)로 EPP/CC 풀→ConfigState→evaluate 통합 완료. 남은 갭: IAG(ExtJS) 풀 매퍼 미지원 — deep config는 여전히 aside 네비게이션 필요.
