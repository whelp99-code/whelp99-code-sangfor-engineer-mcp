# Sangfor 설정 자문 리포트 — ENDPOINT_SECURE 6.0.4

> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).

- 대상 제품/버전: **ENDPOINT_SECURE 6.0.4**
- 요약: 잘못됨 1 · 추가 필요 1 · 환경 의존 2 · 판정 불가 1 · 정상 9
- 종합 판정(ok): **조치 필요**

## 잘못된 설정 (misconfiguration) (1)

- **보안 베이스라인(Compliance Baseline) 규칙이 1개 이상 구성됨** (기대: 1, 실제: 0) 
  - 근거: Athena EPP 6.0.4 User Manual — Compliance Check / Baseline
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

## 추가로 필요 (missing/recommended) (1)

- **Data-at-Risk(민감데이터) 모니터링 활성** (기대: true, 실제: false) 
  - 근거: Athena EPP 6.0.4 User Manual — Data at Risk
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

## 환경 의존 (context_dependent — 고객 환경 프로파일 확인 필요, 조건부) (2)

권장 기준과 다르지만, 고객 환경(규모·망분리·컴플라이언스·업무 앱)에 따라 의도된 구성일 수 있습니다. 아래 항목은 잘못된 설정으로 단정하지 않으며, 담당 엔지니어가 환경 프로파일과 대조해 확정해야 합니다.

- **디바이스 컨트롤 정책 구성됨(환경 의존)** (기대: true, 실제: false) 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Defense / Device Control 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

- **예외(exclusion) 목록 관리됨(환경 의존)** (기대: true, 실제: false) 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Policy / Exclusions 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

## 판정 불가 (indeterminate — 설정값 미확인/근거 부족) (1)

- **취약점 정의 DB에 미적용 업데이트 없음** (기대: false, 실제: 확인 불가) 
  - 근거: Athena EPP 6.0.4 User Manual — Vulnerabilities / Version
  - 출처: support.sangfor.com EPP 6.0.4 User Manual

## 정상 (ok) (9)

- **취약점/패치 DB가 최신 상태 (Vulnerability patch DB is up to date)** (기대: true, 실제: true) 
  - 근거: Athena EPP 6.0.4 User Manual — Vulnerabilities / Patch Management
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/patch/statistics @ 2026-07-02T17:21:04.103Z [live-xhr]

- **미조치 취약점 수가 0 (권장)** (기대: 0, 실제: 0) 
  - 근거: Athena EPP 6.0.4 User Manual — Vulnerabilities / Vuln List
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/vulner/list/homepageVulner @ 2026-07-02T17:21:04.103Z [live-xhr]

- **정기 멀웨어 검사 스케줄이 활성화됨** (기대: true, 실제: true) 
  - 근거: Athena EPP 6.0.4 User Manual — Defense / Malware Scan
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

- **엔드포인트 격리 정책 구성됨** (기대: true, 실제: true) 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Response / Endpoint Isolation 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

- **에이전트 자동 업데이트 활성** (기대: true, 실제: true) 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Update / Agent Update Policy 
  - 관측(수집기 주장, 미검증): EPP console General Policies (human read) @ 2026-07-03 [engineer-observed ⚠ 미확인 수집기]

- **격리(quarantine) 정책 구성됨** (기대: true, 실제: true) 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Response / Quarantine 
  - 관측(수집기 주장, 미검증): EPP General Policies > Realtime Protection / Anti-Malware (UI read) @ 2026-07-03 [dom-scrape]

- **EDR 행위 모니터링 활성** (기대: true, 실제: true) 
  - 근거: Sangfor Endpoint Secure 6.0.4 User Manual — Defense / EDR Behavior Monitoring 
  - 관측(수집기 주장, 미검증): EPP General Policies > Realtime Protection / Anti-Malware (UI read) @ 2026-07-03 [dom-scrape]

- **악성 도메인 탐지 활성 (malicious domain detection active)** (기대: true, 실제: true) 
  - 근거: Athena EPP 6.0.4 User Manual — Detection and Response / Malicious Domain Detection
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/domain_detect/get_domain_info @ 2026-07-02T17:21:04.103Z [live-xhr]

- **자산 인벤토리 분류 구성됨 (asset inventory classified)** (기대: 1, 실제: 5) 
  - 근거: Athena EPP 6.0.4 User Manual — Endpoint Inventory / Asset Classification
  - 출처: support.sangfor.com EPP 6.0.4 User Manual 
  - 관측(수집기 주장, 미검증): POST /api/edrgoweb/v1/asset/inventory/classify @ 2026-07-02T17:21:04.103Z [live-xhr]

## 커버리지 (감사 범위)

- 스펙 항목 14개 중 관측값 미확인 1개 (vuln_defs_current)
- 스펙 외 관측 키 1개 (감사 대상: maliciousDomainBlockCount)

---

## 사람 최종 확인 (sign-off)

- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함
- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함
- 담당 엔지니어: ____________  일자: __________


> 수집: 10.80.1.106 EPP 6.0.4 (2026-07-03). Read-only. 캡처=CDP XHR(patch/vuln/domain/asset), 정책값=담당 엔지니어 콘솔 육안(baseline=0규칙, 멀웨어스케줄=on, DAR=off, 격리정책=구성, 자동업데이트=on, 디바이스컨트롤=없음, 예외목록=없음).
> quarantine=구성(격리 자동조치)·EDR 행위모니터링=on(실시간 파일보호)은 safe-nav로 WebUI 직접 확인(버튼 클릭 없음).
