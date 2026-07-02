# Sangfor 설정 자문 리포트 — IAG 13.0.120

> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).

- 대상 제품/버전: **IAG 13.0.120**
- 요약: 잘못됨 0 · 추가 필요 0 · 환경 의존 1 · 판정 불가 1 · 정상 1
- 종합 판정(ok): **조치 필요**

## 잘못된 설정 (misconfiguration) (0)

_없음_

## 추가로 필요 (missing/recommended) (0)

_없음_

## 환경 의존 (context_dependent — 고객 환경 프로파일 확인 필요, 조건부) (1)

권장 기준과 다르지만, 고객 환경(규모·망분리·컴플라이언스·업무 앱)에 따라 의도된 구성일 수 있습니다. 아래 항목은 잘못된 설정으로 단정하지 않으며, 담당 엔지니어가 환경 프로파일과 대조해 확정해야 합니다.

- **802.1X access control configured (recommended for managed LAN)** (기대: true, 실제: false) 
  - 근거: Sangfor IAG v13.0.120 User Manual — Functions / Access Management / 802.1X Authentication / 802.1X Access Control
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144&category_id=2633214 
  - 관측(수집기 주장, 미검증): IAG 13.0.120 console (engineer visual read) @ 2026-07-03 [manual]

## 판정 불가 (indeterminate — 설정값 미확인/근거 부족) (1)

- **Internet access log retention ≥ 180 days** (기대: 180, 실제: "여유용량기반(capacity-based rotation, 고정 보존일수 아님)") 
  - 근거: Sangfor IAG v13.0.120 User Manual — Functions / Internet Access Analytics / Log Option
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144&category_id=2633191 
  - 관측(수집기 주장, 미검증): IAG 13.0.120 console (engineer visual read) @ 2026-07-03 [manual]

## 정상 (ok) (1)

- **Web authentication is enabled for user identification** (기대: true, 실제: true) 
  - 근거: Sangfor IAG v13.0.120 User Manual — Functions / Access Management / Web Authentication
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144&category_id=2633218 
  - 관측(수집기 주장, 미검증): IAG 13.0.120 console (engineer visual read) @ 2026-07-03 [manual]

## 커버리지 (감사 범위)

- 스펙 항목 3개 중 관측값 미확인 0개
- 스펙 외 관측 키 0개 — 의도 항목 외 설정 없음

---

## 사람 최종 확인 (sign-off)

- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함
- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함
- 담당 엔지니어: ____________  일자: __________


> 수집: 10.80.1.108 IAG 13.0.120 실장비, 담당 엔지니어 육안 확인 (human-observed, 2026-07-03).
> - 로그 보존: **여유용량기반**(고정 보존일수 아님 → ≥180일 요건 보장 여부 판정 불가; 규정 준수가 필요하면 고정 보존기간 정책 검토 권장).
> - 웹 인증: **설정됨**(추후 설정 변경 예정 — 변경 후 재검증 권장).
> - 802.1X: **환경상 불필요**(의도된 미설정 → 환경 의존).
