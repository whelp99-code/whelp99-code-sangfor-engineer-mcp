# 부록 A — 보안제품 AI 자문 모델 (제안서 v1 확장)

> 버전: v1.1 / 추가 토론 결과
> 작성일: 2026-07-01
> 기반작: `docs/PROPOSAL_FIELD_ENGINEER_AUTOMATION_v1.md` (이전 6축 토론 결론을 그대로 계승)
> 산출 방식: 5개 축 멀티에이전트 설계·적대적 비평·종합 (워크플로 `sangfor-advisory-model`, 11 에이전트, ~59만 토큰) + 디스크 자산 실측 교차검증

---

## 0. 무엇이 바뀌나

이전 제안서는 보안제품(EPP/IAG/CC/NDR)의 자동 설정변경(write)을 "비결정성 최악"이라며 **뒤로 미뤘다**. 이번 추가 토론은 이를 **미룸 → 영구 치환**으로 격상한다:

> **보안제품은 처음부터 AI가 장비를 바꾸지 않는다.** AI는 시니어 엔지니어/PM 역할로 **read-only 자문 3서비스**(가이드 / 검증 / 진단)를 제공하고, **장비 설정과 최종 적용은 전적으로 사람**이 한다.

이 모델은 이전 토론의 안전 결론(안전 비대칭·read-back oracle·fail-closed·false-pass=0)과 **완전 정합**하며, "IAG 인증정책 오변경 = 전사 인터넷 차단" 같은 비가역 사고 경로를 **AI 손에서 원천 제거**한다.

---

## 1. 결정적 발견 — 이건 아키텍처 문제가 아니라 "데이터·출처" 문제다

5축 비평을 **디스크 실측**으로 교차검증한 결과, 이 모델의 진짜 제약은 코드가 아니라 **기준 데이터·출처의 구조적 부재**다:

| 사실 | 함의 |
|------|------|
| 보안제품 콘솔 매뉴얼은 **IAG v13.0.80 단 1종**. EPP/CC 폴더엔 hDR·세일즈덱·데이터시트만(콘솔 매뉴얼 **0종**) | 환각 방지의 핵심 안전장치인 **인용(citation) 게이트**가 EPP/CC에선 데이터 부재로 작동 불능 |
| `Configuration checklist 2025` / `Recommended & Max Config`는 전부 **HCI/SCP/SKE 가상화용**, 보안제품 하드닝 baseline 아님 | 보안제품 "절대 misconfiguration 판정" 불가 → 오탐 양산 또는 전부 indeterminate |
| 코드(`product-guides.ts`)는 IAG **v13.0.120** / EPP v6.0.4 / CC v3.0.98C, 디스크 매뉴얼은 IAG **v13.0.80**, 실장비는 미확인 | **3중 버전 불일치가 이미 자산에 박힘.** 마이너 빌드에서도 메뉴 라벨/위치가 바뀜 |
| EPP/IAG/CC 설정 **백업 export 실포맷 샘플 0건** | 백업 파서를 설계할 수가 없음(평문 KV vs 암호화 바이너리 vs 독점포맷 미상) |
| `verifier/src/index.ts:379` `ok = failed===0 && (... || manual>0)` | **활성 false-pass 버그** — `manual_required`만 있는 런·observe 런이 `ok=true`(거짓 "검증됨" 신호) |

> **결론:** 스키마·렌더러·바인딩 엔진 골격은 1.5~2주면 선다. 그러나 **그 골격을 의미 있게 채울 데이터가 없다.** "값은 데이터(매뉴얼 인용)에서만"으로 안전을 확보한 바로 그 순간, 데이터 부재가 산출물을 못 만들게 한다. 그래서 1차는 **매뉴얼이 실재하는 IAG v13.0.80**에만 슬라이스를 좁히고, EPP/CC·절대판정·백업파서는 **디스커버리 게이트** 뒤로 보낸다.

---

## 2. 자문 3서비스 모델

| 서비스 | 입력 | AI가 하는 일 | 사람이 하는 일 | 산출물 |
|--------|------|-------------|---------------|--------|
| **① 가이드 제공** | ITAC Excel 요구사항 / 고객 자유텍스트 + 대상 제품·**정확 빌드** | capabilityId↔ProcedureRecipe 결정적 선택(tested 버전 정확일치만 GREEN), 요구 파라미터를 recipe 슬롯에 바인딩(**값은 recipe 데이터에서만**, LLM은 슬롯추출·윤색만), 매뉴얼 근거 인용 강제, DOCX/PPTX 정밀 렌더 | 장비 실제 버전 read-only 확인, `NEEDS_INPUT` 슬롯 확정, 가이드 검수 후 **직접 설정·최종 적용** | 한국어 정밀 설치·설정 가이드(step별 입력값·허용범위·기본값·근거·검증포인트, 면책 헤더, 미검증버전 적색배너) |
| **② 설정 후 검증** | 엔지니어의 명시적 "설정 완료" 신호 + observed 설정값(1차: 사람이 붙여넣기) + IntendedSpec | IntendedSpec vs observed 항목별 **PASS/FAIL/INDETERMINATE** 결정론 판정(INDETERMINATE는 절대 PASS 아님), severity로 **misconfig vs missing 분리**, 근거·증거·신뢰도·oracle 경계 첨부 | expected 값 sign-off, "설정 완료" 트리거, INDETERMINATE 직접 확인, 리포트 검토 후 **최종 확정** | 한국어 검증 리포트(잘못됨/추가필요/판정불가/정상 분리 + expected vs observed + 증거 + 사람 최종확정란) |
| **③ 기존 설정 진단** | 백업파일 1개 **또는** 스크린샷 PNG 묶음(오프라인 단건이 주 시나리오) + 고객 환경 프로파일(규모/AD/망분리/컴플라이언스) | ConfigState 추출(**DOM 1차 > backup > vision 보조**, 민감값 마스킹), ITAC 감사 미흡행→설정권장 환류, **5분류**(misconfig/missing/ok/indeterminate/**context_dependent**), critical+OCR출처는 자동 INDETERMINATE | 진단 입력 제공, 환경 프로파일 입력, AI추정 misconfig **시니어 사인오프**, 권장 채택 결정 | 한국어 진단 리포트(①잘못됨 ②추가필요 ③판정불가(사유) ④환경의존(조건부) ⑤정상, coverage% 노출, ITAC 행 추적). 서비스①로 환류 가능 |

**5축이 합의한 단일 안전 토대:** 세 서비스가 공유하는 **`IntendedSpec`(의도 사양) 단일 데이터 계약** — 가이드의 step이 `specItemId`를 발급하고, 검증이 그 spec을 입력으로 받고, 진단이 같은 severity 분류축을 쓴다. 이걸 먼저 못박으면 세 축이 동형으로 정렬된다.

---

## 3. AI ↔ 사람 경계 (이 모델의 핵심 안전장치)

**AI가 절대 안 하는 것 (6):**
1. 어떤 경로로도 장비 설정을 변경하지 않는다 — 전 경로 read-only, `fillFormFields`/Apply 코드경로를 검증 패키지에서 **물리적으로 제거**
2. 값을 창작하지 않는다 — 입력값/허용범위/기본값은 **ProcedureRecipe 데이터(매뉴얼 근거)** 에서만, LLM은 슬롯추출·윤색만
3. 근거 없는 기준으로 단정하지 않는다 — 출처 없는 expected는 build 실패 또는 `needsSeniorReview`
4. INDETERMINATE를 PASS로 셈하지 않는다 — 추출실패·규칙부재·신뢰도미달·매칭≠1은 절대 정상으로 안 흘림
5. 보안제품 **절대 misconfiguration을 단정하지 않는다** — 환경 의존은 `context_dependent`로 분리, OCR출처 critical은 자동 INDETERMINATE
6. 고객 환경을 임의 추론하지 않는다 — 프로파일은 사람 명시 입력 강제

**사람이 반드시 하는 것 (6):** ① 장비 직접 설정·최종 적용 ② 실제 빌드 버전 read-only 확인 ③ "설정 완료" 명시 트리거(중간상태 검증 방지) ④ AI추정 expected·misconfig **시니어 sign-off** ⑤ `NEEDS_INPUT`·INDETERMINATE 채우기 ⑥ 환경 프로파일 입력·권장 채택 결정

> 핵심: **정밀도가 주는 과신**으로 "AI의 자신만만한 오답"이 사람 손을 거쳐 사고로 재진입하는 경로를 막는다. 모든 불확실성을 숨기지 않고(fail-closed = 경고를 숨기지 않음), 모든 비가역 판단의 최종 게이트를 사람에게 넘긴다.

---

## 4. 축별 1차 판정

| 축 | 판정 | 근거 |
|----|------|------|
| **설정 후 검증 (서비스②)** | **include-now (범위 한정)** | 5축 중 유일하게 include-now. `:379` false-pass 교정은 즉시·무조건 가치. IntendedSpec이 단일 계약 |
| 현재 설정 추출 (서비스③ 입력) | **include-now (축소)** | "오프라인 PNG/백업 단건 → DOM우선+vision보조 → 근거달린 ConfigState" 최소 경로만. 라이브 캡처·백업파서·전제품 keymap defer |
| 설정 가이드 제공 (서비스①) | **defer → IAG 슬라이스만 축소 include** | citation 게이트가 EPP/CC 매뉴얼 부재로 작동 불능. 매뉴얼 실재하는 IAG v13.0.80로만 |
| 진단: 잘못됨/추가필요 (서비스③ 판정) | **defer** | 보안제품 기계검증 baseline 부재. 1차는 **ITAC 감사환류** + **HCI/SCP 절대판정 파일럿**으로만 슬라이스 |
| 기준 지식 KB | **defer** | 방향은 옳으나 baseline 자료·백업포맷 두 블로커. 스키마와 "읽기전용 가이드 KB"만 include |

---

## 5. 첫 산출물 (지금 시작)

> **서비스② 검증 판정 코어 + 안전 교정 + IntendedSpec 단일 계약 + IAG v13.0.80 슬라이스**

**구성:**
1. **`verifier:379` false-pass 버그 즉시 교정** — `manual_required`/INDETERMINATE는 절대 PASS로 셈하지 않음, observe 런은 `ok` 무조건 false
2. **`IntendedSpec`(VerificationSpec/SpecItem) zod 스키마 신설** — `severity`로 misconfig vs missing 분리, `menuPath`는 ADAPTERS 단일 진실원 import, `expected`에 출처·신뢰등급 의무
3. **PASS/FAIL/INDETERMINATE evaluate 결정론 엔진** (LLM 불개입)
4. **한국어 검증 리포트 DOCX** — 잘못됨/추가필요/판정불가 분리 + expected 출처·신뢰등급 + 사람 sign-off 게이트
5. **IAG v13.0.80 `auth_source`/`internet_policy` 2 capability spec 시드** — 유일하게 매뉴얼이 실재해 인용 게이트가 실제로 작동하는 지점

입력은 **사람이 붙여넣은 observed**로 시작 → webui 자동추출 없이도 end-to-end 동작.

**왜 이것인가:** 5축 중 검증축만 include-now를 받음. false-pass 교정은 즉시 가치(현재 코드가 사람에게 거짓 "검증됨" 신호를 주는 활성 버그). IntendedSpec은 가이드·검증·진단이 공유하는 단일 계약. IAG v13.0.80은 환각방지 인용 게이트를 진짜로 검증할 수 있는 **유일한** 지점(데이터 부재 우회). read-only·결정론·사람 sign-off 전제라 **치명도 0**.

**Exit Criteria:**
- `:379` false-pass가 회귀테스트로 영구 차단(manual/INDETERMINATE/observe가 `ok=true`를 절대 못 냄)
- IAG v13.0.80 2 capability에 대해 사람 붙여넣기 observed만으로 PASS/FAIL/INDETERMINATE 한국어 리포트 e2e 생성
- 모든 spec expected가 IAG v13.0.80 매뉴얼 섹션/페이지로 역추적, 출처 없는 expected는 misconfig 단정 불가
- 리포트가 '잘못됨'과 '추가필요'를 별 섹션 분리 + 사람 sign-off란 강제
- webui 자동추출·confidence 라우팅·백업파서는 **불포함(defer 명시)**

---

## 6. 신규 아키텍처 (자문 모델 1차)

```
신규
  packages/sangfor-spec/          IntendedSpec(VerificationSpec/SpecItem) zod 스키마 — 가이드·검증·진단 공유 단일 계약
                                  (menuPath는 ADAPTERS import, expected에 출처·신뢰등급, AI추정은 needsSeniorReview)
  data/specs/IAG/13.0.80/{auth_source,internet_policy}.spec.json   매뉴얼 인용 시드
수정
  packages/sangfor-verifier/src/index.ts:379   ok 로직 교정(false-pass 차단) + evaluate.ts(PASS/FAIL/INDETERMINATE 결정론)
  packages/sangfor-product-adapters/src/verification-report-docx.ts   한국어 잘못됨/추가필요/판정불가 분리 리포트
후속 (디스커버리 통과 후)
  packages/sangfor-knowledge/src/procedure-recipes.ts   서비스① 정밀 절차(FieldSpec/Precondition/VerifyPoint/Citation)
  packages/sangfor-config-state/                        서비스③ ConfigState 추출(DOM>backup>vision, 마스킹)
  data/safety/ , data/competency/                       이전 제안서 Phase 0 자산과 공유
```

---

## 7. 교차 리스크 (Top 6)

| # | 리스크 | 완화 |
|---|--------|------|
| 1 | **환각/오진이 read-only인데도 사람 손을 통해 사고로 재진입** (틀린 가이드/오진을 현장이 신뢰 → 전사 차단). *정밀도가 신뢰를 과잉부여하는 역설* | 값은 매뉴얼 근거 데이터에서만, LLM은 윤색만. 근거 없으면 build 실패/needsSeniorReview. 산출물 1페이지에 제품·빌드·검증범위·면책 헤더. 시니어 sign-off |
| 2 | **기준 데이터·출처의 구조적 부재** (보안제품 매뉴얼 IAG 1종, 베이스라인 HCI용, 백업포맷 0건) | IAG v13.0.80로만 1차. EPP/CC defer. 진단은 절대기준 대신 **ITAC 인간채점(△/X)을 좌표계로** 우회. HCI/SCP는 checklist 실재→절대판정 파일럿 |
| 3 | **3중 버전 불일치** (코드 vs 디스크 vs 실장비) | semver 보간 폐기, **tested 빌드 정확일치만 GREEN·그외 RED**. 파이프라인 앞단 read-only 버전 식별. export 1건으로 실장비 진실 확정 |
| 4 | **민감값 유출** (LDAP bind 비번/RADIUS 시크릿/인증서 키가 git·RAG·OpenAI vision으로) | 실샘플 커밋 금지(합성 fixture만). 마스킹을 zod·머지 단계에 강제. 외부 vision은 마스킹 후에도 **온프레(LM Studio/Hermes) 강제**, OpenAI는 명시 opt-in |
| 5 | **자동 추출 신뢰도 신호 부재 + fail-open 메뉴** (ocrCaptcha는 confidence 미생성, navigateMenu는 부분매칭 첫요소 클릭) | 1차는 자동 webui 추출 배제(붙여넣기/백업 입력). confidence는 self-consistency(다중샘플 일치율). vision/ocr는 must에서 항상 INDETERMINATE. CC/NDR은 ExtJS 아님→제품별 추출기 |
| 6 | **법적/책임 경계** (read-only여도 "당신 설정이 틀렸다"는 진단서는 전문가 의견 → 오진 시 책임) | 산출물에 유효기간·면책·"최종 판단은 담당 엔지니어" 의무화. misconfig 단정은 시니어 2차 리뷰. AI추정 기준은 advisory 라벨 |

---

## 8. 성공 지표 (1차)

- **false-pass = 0** (INDETERMINATE/추출실패/규칙부재/manual을 PASS로 셈한 건수 0, 회귀테스트 영구 게이트 — `:379` 버그 부활 불가)
- **인용 무결성 100%** (모든 expected/입력값이 실재 매뉴얼 섹션/페이지로 역추적, 근거 없이 misconfig 단정 0)
- **버전 정합 강제율 100%** (산출물에 제품·정확빌드·검증범위 명시, tested 외 버전이 RED 없이 GREEN으로 나간 건수 0)
- **사람 게이트 통과율 100%** (모든 비가역 판단에 사람 sign-off 기록, AI 단독 확정 0)
- **서비스② IAG 슬라이스 e2e 동작** (붙여넣기 observed만으로 잘못됨/추가필요/판정불가 한국어 리포트 생성)
- **진단 분리 정확도** (misconfig vs missing vs context_dependent 골든셋 대비, 절대기준 없는 항목 misconfig 과대보고 0)
- **민감값 마스킹 누락 = 0** (산출물·fixture·로그·색인·외부전송 평문 잔류 0)

---

## 9. 디스커버리 게이트 + 결정 필요 사항

**명시적 디스커버리 게이트 (통과 전 EPP/CC·백업파서·절대판정 전부 보류):**
1. **백업 export 권한·포맷 스파이크 (1주):** `admin/sangfor`가 export 권한을 갖는가? export가 평문 KV인가 암호화/바이너리/독점인가? → 백업 트랙 전체 진행/보류 분기
2. **실장비 진실 버전 확정:** IAG .108 / EPP .106 / CC .107 실제 빌드 확인 → `product-guides.ts` v13.0.120 vs 디스크 v13.0.80 모순 통일
3. **EPP/CC 콘솔 매뉴얼 확보 경로:** 본사 엔지니어 인터뷰 / internal 문서 요청 / 화면 역공학 중 무엇으로 채울지, 또는 EPP/CC 무기한 보류 결정

**사용자 결정 필요 (추가):**
4. `IntendedSpec`/`ConfigState` 단일 계약의 소유 패키지(`sangfor-spec` 신설 vs verifier 확장) — 3축 공유라 조인키(`capabilityId↔specItemId`) 거버넌스 선합의
5. canonical configKey taxonomy 권위 정의자(백업키·OCR라벨·매뉴얼용어·menuPath가 모두 다른 명명) — 백업포맷 확보 후 후속과제
6. **HCI/SCP 절대판정 파일럿을 진단축 1차에 포함할지** (checklist 실재로 보안제품보다 절대판정 가능 — 별개 트랙, 우선순위 결정)
7. 외부 vision API(OpenAI) opt-in 허용 범위(온프레 강제 vs 정확도 트레이드오프, 고객/민감도별)
8. 산출물 면책·유효기간·시니어 리뷰 게이트의 제품화 수준(법적 책임 경계 의무화 범위)

---

## 10. 이전 로드맵과의 관계 (재정렬)

- **보안제품 자동 write 트랙 = 로드맵에서 완전 삭제.** 그 자리를 read-only 자문 3서비스가 영구 치환.
- **HCI/SCP 자동 write 트랙 = 이전 결론 그대로 존속** (OpenAPI GET read-back 결정론적 + checklist 실재). 진단축의 **절대판정 파일럿은 보안제품이 아니라 HCI/SCP에서 먼저.**
- **Phase 0**(키 공간 통일 `ENDPOINT_SECURE/EPP` 정규화, read-only 기반)은 자문 모델의 `IntendedSpec`/`ConfigState` 단일 계약의 **선행조건으로 유지·강화.**
- **디스커버리 게이트**(백업포맷·버전·매뉴얼)가 새 로드맵의 명시적 게이트로 추가.

> **순서:** [지금] 서비스② 검증코어 + IntendedSpec + `:379` 교정 → [병행 디스커버리] 백업포맷/버전/매뉴얼 → [통과 후] 서비스① IAG 정밀가이드, 서비스③ ITAC 환류 → [HCI 트랙] 절대판정 파일럿 → [장기] EPP/CC 매뉴얼 확보 시 확장.
> 자문 모델은 보안제품 자동 write를 **대체**하고, HCI/SCP 자동 write와 **병존**한다.

---

## 11. 다음 단계

1. **§9의 디스커버리 게이트 1·2** (백업포맷 스파이크 + 실장비 버전 확인) — EPP/CC 어떤 트랙도 시작 전 필수
2. **§9 결정 4·6 회신** (단일 계약 소유 패키지, HCI 절대판정 파일럿 포함 여부)
3. 확정 시 → 첫 산출물(서비스② 검증코어 + IAG 슬라이스)을 `superpowers:brainstorming` 기반 상세 설계 후 착수. `:379` 교정은 단독으로도 즉시 가치라 선행 가능.

---

*본 부록은 제안서 v1을 기반작으로 확장한 추가 토론 결과다. v1과 함께 읽으며, §9 결정 회신에 따라 통합본 v2에서 우선순위를 확정한다.*
