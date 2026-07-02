# Sangfor 설정 자문 리포트 — ENDPOINT_SECURE 6.0.4

> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).

- 대상 제품/버전: **ENDPOINT_SECURE 6.0.4**
- 요약: 잘못됨 0 · 추가 필요 0 · 환경 의존 0 · 판정 불가 9 · 정상 3
- 종합 판정(ok): **조치 필요**

## 잘못된 설정 (misconfiguration) (0)

_없음_

## 추가로 필요 (missing/recommended) (0)

_없음_

## 환경 의존 (context_dependent — 고객 환경 프로파일 확인 필요, 조건부) (0)

권장 기준과 다르지만, 고객 환경(규모·망분리·컴플라이언스·업무 앱)에 따라 의도된 구성일 수 있습니다. 아래 항목은 잘못된 설정으로 단정하지 않으며, 담당 엔지니어가 환경 프로파일과 대조해 확정해야 합니다.

_없음_

## 판정 불가 (indeterminate — 설정값 미확인/근거 부족) (9)

- **보안 베이스라인(Compliance Baseline) 규칙이 1개 이상 구성됨** (기대: 1, 실제: 확인 불가) 
  - 근거: Athena EPP 6.0.4 User Manual — Compliance Check / Baseline
  - 출처: support.sangfor.com EPP 6.0.4 User Manual

- **정기 멀웨어 검사 스케줄이 활성화됨** (기대: true, 실제: 확인 불가) 
  - 근거: Athena EPP 6.0.4 User Manual — Defense / Malware Scan
  - 출처: support.sangfor.com EPP 6.0.4 User Manual

- **Data-at-Risk(민감데이터) 모니터링 활성** (기대: true, 실제: 확인 불가) 
  - 근거: Athena EPP 6.0.4 User Manual — Data at Risk
  - 출처: support.sangfor.com EPP 6.0.4 User Manual

- **엔드포인트 격리 정책 구성됨** 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Response / Endpoint Isolation

- **에이전트 자동 업데이트 활성** 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Update / Agent Update Policy

- **격리(quarantine) 정책 구성됨** 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Response / Quarantine

- **EDR 행위 모니터링 활성** 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Defense / EDR Behavior Monitoring

- **디바이스 컨트롤 정책 구성됨(환경 의존)** 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Defense / Device Control

- **예외(exclusion) 목록 관리됨(환경 의존)** 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Policy / Exclusions

## 정상 (ok) (3)

- **취약점/패치 DB가 최신 상태 (Vulnerability patch DB is up to date)** (기대: true, 실제: true) 
  - 근거: Athena EPP 6.0.4 User Manual — Vulnerabilities / Patch Management
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/patch/statistics @ 2026-07-02T16:20:40.709Z [live-xhr]

- **미조치 취약점 수가 0 (권장)** (기대: 0, 실제: 0) 
  - 근거: Athena EPP 6.0.4 User Manual — Vulnerabilities / Vuln List
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/vulner/list/homepageVulner @ 2026-07-02T16:20:40.709Z [live-xhr]

- **취약점 정의 DB에 미적용 업데이트 없음** (기대: false, 실제: false) 
  - 근거: Athena EPP 6.0.4 User Manual — Vulnerabilities / Version
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/vulner/list/version @ 2026-07-02T16:20:40.709Z [live-xhr]

## 커버리지 (감사 범위)

- 스펙 항목 12개 중 관측값 미확인 9개 (security_baseline_configured, malware_scan_schedule_enabled, dar_monitoring_active, endpoint_isolation_policy_present, agent_auto_update_enabled, quarantine_policy_present, edr_behavior_monitoring_enabled, device_control_policy_present, exclusion_list_managed)
- 스펙 외 관측 키 1개 (감사 대상: maliciousDomainBlockCount)

---

## 사람 최종 확인 (sign-off)

- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함
- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함
- 담당 엔지니어: ____________  일자: __________


> 수집: 10.80.1.106 라이브 콘솔 XHR 15개 엔드포인트 (read-only, 2026-07-03). 로그인=aside(캡차 워크플로), 추출=Chrome CDP(앱 자신의 인증 XHR 캡처 — aside는 XHR/CSRF 한계로 추출 불가).
> 관측 4값: patchIsLatest=최신, vulnDefUpdateAvailable=false(정의 최신), vulnerabilityCount=0, maliciousDomainBlockCount=35.
> 미도달(판정불가): baseline/getRule(보안 베이스라인 규칙), DAR 모니터링, 그리고 exists-기반 항목(격리/자동업데이트/격리정책/EDR/디바이스컨트롤/예외) — 해당 콘솔 페이지 미방문. 억지 판정 안 함.
