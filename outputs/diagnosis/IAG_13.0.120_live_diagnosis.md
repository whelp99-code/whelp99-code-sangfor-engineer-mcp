# Sangfor 설정 자문 리포트 — IAG 13.0.120

> ⚠️ **면책**: 본 리포트는 AI가 수집된 제품 매뉴얼을 근거로 생성한 **참고용 자문**입니다. 최종 판단과 적용은 담당 엔지니어의 책임입니다. AI는 어떤 장비 설정도 변경하지 않았습니다(read-only).

- 대상 제품/버전: **IAG 13.0.120**
- 요약: 잘못됨 0 · 추가 필요 1 · 판정 불가 3 · 정상 1
- 종합 판정(ok): **조치 필요**

## 잘못된 설정 (misconfiguration) (0)

_없음_

## 추가로 필요 (missing/recommended) (1)

- **고가용성(HA) 활성화 (가용성 권장)** (기대: true, 실제: false) 
  - 근거: Sangfor IAG v13.0.120 User Manual — System / High Availability
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144

## 판정 불가 (indeterminate — 설정값 미확인/근거 부족) (3)

- **Internet access log retention ≥ 180 days** (기대: 180, 실제: 확인 불가) 
  - 근거: Sangfor IAG v13.0.120 User Manual — Functions / Internet Access Analytics / Log Option
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144&category_id=2633191

- **Web authentication is enabled for user identification** (기대: true, 실제: 확인 불가) 
  - 근거: Sangfor IAG v13.0.120 User Manual — Functions / Access Management / Web Authentication
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144&category_id=2633218

- **802.1X access control configured (recommended for managed LAN)** (기대: true, 실제: 확인 불가) 
  - 근거: Sangfor IAG v13.0.120 User Manual — Functions / Access Management / 802.1X Authentication / 802.1X Access Control
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144&category_id=2633214

## 정상 (ok) (1)

- **미처리 보안 이벤트 수가 0 (권장)** (기대: 0, 실제: 0) 
  - 근거: Sangfor IAG v13.0.120 User Manual — Dashboard / Security
  - 출처: https://support.sangfor.com/productDocument/read?product_id=22&version_id=1144

---

## 사람 최종 확인 (sign-off)

- [ ] 위 잘못된 설정 항목을 담당 엔지니어가 검토하고 조치 여부를 결정함
- [ ] 판정 불가 항목의 실제 설정값을 사람이 직접 확인함
- 담당 엔지니어: ____________  일자: __________


> 수집: 10.80.1.108 라이브 콘솔(ExtJS) — aside repl snapshot (read-only, 2026-07-01). HA Disabled, 동시세션 784, 자산 51/식별 48, 버전 v13.0.120.
