# Sangfor 설정 자문 리포트 — CYBER_COMMAND 3.0.98

> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).

- 대상 제품/버전: **CYBER_COMMAND 3.0.98**
- 요약: 잘못됨 0 · 추가 필요 0 · 환경 의존 0 · 판정 불가 5 · 정상 1
- 종합 판정(ok): **조치 필요**

## 잘못된 설정 (misconfiguration) (0)

_없음_

## 추가로 필요 (missing/recommended) (0)

_없음_

## 환경 의존 (context_dependent — 고객 환경 프로파일 확인 필요, 조건부) (0)

권장 기준과 다르지만, 고객 환경(규모·망분리·컴플라이언스·업무 앱)에 따라 의도된 구성일 수 있습니다. 아래 항목은 잘못된 설정으로 단정하지 않으며, 담당 엔지니어가 환경 프로파일과 대조해 확정해야 합니다.

_없음_

## 판정 불가 (indeterminate — 설정값 미확인/근거 부족) (5)

- **NTP 동기화(상관분석 품질의 근간)** (기대: true, 실제: 확인 불가) 
  - 근거: Cyber Command 3.0 User Manual — System / NTP
  - 출처: support.sangfor.com CC 3.0 User Manual

- **이벤트 소스가 1개 이상 활성** (기대: 1, 실제: 확인 불가) 
  - 근거: Cyber Command 3.0 User Manual — Events / Event Sources
  - 출처: support.sangfor.com CC 3.0 User Manual

- **알림 채널(Email/SMS/Syslog) 구성** (기대: true, 실제: 확인 불가) 
  - 근거: Cyber Command 3.0 User Manual — Alerts / Notification
  - 출처: support.sangfor.com CC 3.0 User Manual

- **알람 노이즈 튜닝 구성됨(환경 의존)** 
  - 근거: Sangfor Cyber Command 3.0.98 User Manual — Alarm / Tuning

- **syslog 로그 전달 구성됨** 
  - 근거: Sangfor Cyber Command 3.0.98 User Manual — System / Syslog

## 정상 (ok) (1)

- **정기 리포트 스케줄 구성됨** (기대: undefined, 실제: true) 
  - 근거: Sangfor Cyber Command 3.0.98 User Manual — Report / Scheduled Report 
  - 관측(수집기 주장, 미검증): POST /apps/secvisual/home/home/get_report_tag @ 2026-07-07T10:41:30.863Z [live-xhr]

## 커버리지 (감사 범위)

- 스펙 항목 6개 중 관측값 미확인 5개 (ntp_synced, event_sources_active, alert_channel_configured, alarm_noise_tuning_present, syslog_forwarding_present)
- 스펙 외 관측 키 9개 (감사 대상: systemVersion, timezone, isVersionExpired, isCertExpired, virusLibExists, clusterMasterOffline, clusterModeEnabled, linkWorkOrderEnabled, linkWorkOrderPort)

---

## 사람 최종 확인 (sign-off)

- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함
- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함
- 담당 엔지니어: ____________  일자: __________


> 수집: 10.80.1.107 라이브 콘솔 XHR 23개 엔드포인트 (read-only)
