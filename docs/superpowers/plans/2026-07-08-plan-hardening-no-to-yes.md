# 계획 강화 — 정직한 '아니오'를 '맞습니다'로 (2026-07-08)

> **목적:** 6개월 로드맵 리뷰에서 내가 정직하게 "아니오"라고 답한 부분들을, **억지 없이** "맞습니다(정상 동작)"로 만들 수 있게 계획을 보강한다. 각 항목마다 [원래 아니오] → [해결 메커니즘=신규 태스크] → [결과 보장]을 명시한다.
>
> **두 종류의 아니오:**
> - **(A) 닫을 수 있는 갭** — 계획 추가로 실제 "맞습니다"가 된다.
> - **(B) 설계상 의도** — "맞습니다, 그게 옳습니다"로 **정의를 명문화**한다(속여서 A로 만들지 않는다).

---

## 요약 매핑

| # | 원래 정직한 '아니오' | 유형 | 해결(신규 태스크) | 결과 |
|---|---|---|---|---|
| 1 | M2~M6은 전략 레벨이라 "따라만 하면"이 안 됨 | A | **T-H7** zero-context 카드 + Adjustment Point 표준 | 미지수까지 "발견→적응" 절차로 실행가능 → **맞습니다** |
| 2 | M4 create-volume write는 cinder 없으면 불가 | A(코드)/외부(장비) | **T-H1** mock-cinder 완전 e2e | 코드·플로우는 mock으로 field-verify → 실장비는 배포 시 **스위치만** → **맞습니다(코드)** |
| 3 | CC/IAG는 VPN 상시 의존 | A | **T-H2** 오프라인 캡처 번들 | 1회 캡처 후 오프라인 진단 → VPN 상시 의존 제거 → **맞습니다** |
| 4 | IAG Vue SPA는 설정 미노출 | A(대부분) | **T-H3** read-only DOM 수집기 | 렌더값을 provenance=live로 수집, 진짜 불가분만 라벨 → **대부분 맞습니다** |
| 5 | 판정불가(INDETERMINATE)가 남음 | A(행동)/B(정의) | **T-H4** 판정불가→수집가이드 자동생성 | "다음에 무엇을 보면 되는지"가 항상 명확 → **맞습니다** |
| 6 | 동생이 false-PASS 낼 수 있음 | A | **T-H5** no-fabrication 증거 게이트 | evidence 없는 PASS/field_verified를 CI가 거부 → **맞습니다** |
| 7 | "모든 체크 PASS"는 안 됨 | B | **T-H6** 수용 정의 명문화 | '정상'=시스템이 정직·안전·검증되게 동작(≠전부 PASS) → **맞습니다, 그게 옳습니다** |
| 8 | 완전 자율(비가역 write 자율)은 범위 밖 | B | (정의 유지) | 사람이 비가역 손 소유 = 안전 설계 → **맞습니다, 그게 옳습니다** |

**남는 진짜 외부 의존(정직):** cinder **실배포**와 VPN **물리 연결**은 사용자 인프라다. 단 T-H1/T-H2로 그 전까지도 **코드·플로우는 100% 검증**되어 "장비만 붙이면 되는" 상태로 맞춰진다. 즉 우리 통제 밖은 딱 두 개(cinder 하드웨어, VPN 물리)로 축소되고, 나머지는 전부 "맞습니다"가 된다.

---

## 신규 태스크 (실행 카드)

### T-H1 — mock-cinder 완전 e2e (M4 write를 코드에서 '맞습니다'로)
**목표:** `apps/mock-sangfor-console`의 OpenStack fixture에 cinder/volumev2 서비스를 추가해, create-volume `plan→approve(HMAC+nonce)→apply→read-back verify→restore(delete)` 전체를 **mock 실장비로 field-verify**한다. 실 cinder 배포 시엔 endpoint URL만 바꾸면 되도록.
- Files: `apps/mock-sangfor-console/src/openstack.ts`(cinder 라우트+quota-silent-noop 함정 유지), `packages/sangfor-hci-client/src/{volumes,apply-machine,read-back}.ts`(이미 존재—mock 대상 확장), `tests/hci-slice-e2e.test.ts`(create-volume 왕복 케이스 추가), `packages/sangfor-product-adapters`(executor seam에 operator 경로 연결—P1-1 실경로, mock 대상).
- Steps(TDD): 실패 e2e(create-volume→read-back PASS→restore) → mock cinder 구현 → 게이트(승인·ALLOW_REAL_EXECUTION·nonce) 전부 통과 확인 → 202≠성공/quota-noop→FAILED_HALT 회귀 유지.
- Acceptance: mock 대상 create-volume이 read-back PASS로 **성공 판정**되고 복원됨; 실장비는 `SANGFOR_HCI_IDENTITY_URL`만 실 SCP로 바꾸면 동일 코드경로. **불변식: 실장비 write는 여전히 사람 서명 뒤.**

### T-H2 — 오프라인 캡처 번들 (VPN 상시 의존 제거) — 아이디어#9
**목표:** 장비 config를 1회 캡처해 **암호화 번들**(`data/captures/<device>-<ts>.enc`)로 저장 → 이후 진단은 번들에서 오프라인 수행. (EPP를 deep 풀로 오프라인 진단한 것을 제품화.)
- Files: `scripts/device-collect.ts`(캡처 후 번들 export), 신규 `packages/sangfor-collector/src/capture-bundle.ts`(암호화 저장/로드, 시크릿 마스킹), `{epp,cc,iag}-diagnose.ts`(번들 입력 허용).
- Steps: 캡처→마스킹→암호화 저장; 진단 스크립트가 `--bundle <path>` 또는 `/tmp` 풀 중 택; 번들 왕복 테스트.
- Acceptance: VPN 없이 번들로 진단 재현; 번들 내 시크릿 0(마스킹 검증).

### T-H3 — IAG read-only DOM 수집기 (Vue SPA를 live로)
**목표:** IAG deep-config(802.1X/로그보존/웹인증)를 API가 안 내놓으면 **렌더된 DOM 값을 read-only로 스크레이프**(Playwright `locator().innerText()`), provenance=live로 매핑. 진짜 불가분만 provenance=manual 라벨.
- Files: 신규 `scripts/iag-dom-collect.ts`(뷰 페이지 네비+DOM read, mutation 버튼 금지), `scripts/iag-diagnose.ts`(live 소비), `packages/sangfor-config-state`(IAG 매퍼).
- Acceptance: IAG 각 항목 provenance(live/manual) 정확 표기; live 가능분 실장비 반영.

### T-H4 — 판정불가 → 수집 가이드 자동생성 — 아이디어#2
**목표:** 리포트의 각 INDETERMINATE 항목에 "이 값은 콘솔 <메뉴/페이지>에서 확인(또는 <엔드포인트> 캡처 필요)"라는 **사람용 다음행동**을 자동 첨부. spec 항목에 `collectionHint` 필드 추가.
- Files: `data/specs/**/*.json`(항목별 hint), `packages/sangfor-spec/src/index.ts`(렌더에 hint 출력).
- Acceptance: 모든 INDETERMINATE에 다음행동 존재 → "판정불가여도 무엇을 하면 되는지 명확".

### T-H5 — no-fabrication 증거 게이트 (false-PASS 원천 차단)
**목표:** 모든 `field_verified`/PASS는 `source.endpoint`+실관측값 evidence 필수. evidence 없는 승격/PASS를 **CI/테스트가 거부**. (competency 원장은 이미 evidence 강제 — 이를 spec 평가·리포트까지 확장.)
- Files: `packages/sangfor-competency`(이미 강제), `packages/sangfor-spec`(observed에 provenance 없으면 PASS 금지 옵션), 신규 테스트 `tests/no-fabrication.test.ts`.
- Acceptance: provenance 없는 값으로 PASS 나면 테스트 실패; 정직성 회귀 방지.

### T-H6 — 수용 정의 명문화 ('정상 동작'의 기준)
**목표:** 문서에 못 박는다 — **'정상 동작' = 시스템이 (a)정직(INDETERMINATE≠PASS·날조0) (b)안전(게이트·read-back·사람서명) (c)검증됨(테스트/lint green)** 하게 동작하는 것. "모든 장비 체크 PASS"는 목표도 아니고 정상 산출물엔 FAIL·INDETERMINATE가 포함될 수 있다. → PRODUCT-SENSE.md/RELIABILITY.md에 반영.
- Acceptance: '완료'의 정의가 문서에 명확 → "모두 정상"에 대한 오해 제거.

### T-H7 — M2~M6 zero-context 카드 표준 (Adjustment Point)
**목표:** M2~M6의 각 태스크를 **미지수에도 실행가능**하게 만든다 — 카드마다 ① Discovery 스텝(실제 응답/API/버전을 먼저 관측) ② Adjustment Point(관측이 가정과 다르면 여기서 매핑을 조정) ③ Acceptance-by-honest-outcome(특정 결과 강요가 아니라 "정직히 관측·매핑했는가"로 통과). EPP가 그 증명(응답 보고→8개만 매핑→2개 정직 생략).
- Files: 각 게이트 열릴 때 `2026-07-08-m1-execution-tasks.md`와 같은 실행문서를 M2/M3/…로 추가.
- Acceptance: "따라만 하면(발견·적응 포함) 맞습니다"가 각 단계에서 성립. 미지수는 실패가 아니라 Adjustment Point에서 흡수.

---

## 결론
위 T-H1~H7을 M1~M2 사이에 얹으면, 내가 정직하게 "아니오"라 한 것 중 **통제 가능한 전부가 "맞습니다"로 전환**된다. 남는 순수 외부 의존은 **cinder 하드웨어 배포**와 **VPN 물리 연결** 둘뿐이며, 그마저 T-H1/H2로 "장비만 붙이면 되는" 상태까지 코드가 검증된다. 그리고 (B)유형(완전자율 미채택·INDETERMINATE 존중)은 **버그가 아니라 이 제품이 신뢰를 얻는 방식**이므로, "맞습니다, 그게 옳습니다"로 유지한다.
