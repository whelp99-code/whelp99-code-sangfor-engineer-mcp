# 1차 제안서 — Sangfor 필드 엔지니어 자동화 (보안제품 + HCI/SCP)

> 버전: v1 (1차 / 초안)
> 작성일: 2026-07-01
> 대상 저장소: `sangfor-engineer-mcp` (branch `chore/standalone-adoption`, 커밋 `c15ad49`)
> 산출 방식: 코드 전수 분석(→ `docs/PROJECT_ARCHITECTURE.md`) + 6개 전문 축 멀티에이전트 설계·적대적 비평·종합
> 참고자료: DB 학습본(KB 카탈로그/product tables), 외장드라이브 `/Volumes/My Passport/00. Attached` 제품 문서(특히 **HCI/SCP OpenAPI 가이드**), 각 제품 User Manual / POC Guide

---

## 0. 한 줄 요약

> **새 기능을 늘리는 제안이 아니다.** 1차의 본질은 ① 실행기를 *fail-closed*로 교정하고 ② 검증을 *read-back(설정값 재조회)* 으로 재정의하며 ③ 가장 결정론적인 **HCI/SCP에서 read-only 운영자동화 → 단 하나의 가역 write**까지 사람 개입 없이 안전하게 *적용·검증·복원*하는 수직 슬라이스를 관통하는 것이다.
> "필드 엔지니어 1인 대체"는 **측정 가능한 자동화 표면이 실재한 뒤에** 붙인다. 1차 성공의 기준은 *대체율*이 아니라 **단일 가역 변경을 사람 없이 안전하게 적용·검증·복원했는가**이다.

---

## 1. 배경 — 어디까지 됐고, 무엇이 비어 있나

현재 시스템은 **감사(ITAC 체크리스트) 대응 → 제품 매핑 → 변경계획 → 설정/운영 가이드(DOCX/PPTX) 생성**까지 완결되어 있다. 위험도 분류·승인 4필드 게이트·dry-run 기본값·RAG·피드백 루프·Chrome CDP 로그인/메뉴/폼 자동화 *원시(primitive)* 도 갖춰져 있다.

**비어 있는 단 하나의 계층: "실제 장비를 설치·설정하는 실행(execution)".**

코드가 그대로 말해준다:

| 증거 위치 | 상태 |
|-----------|------|
| `product-adapters/src/index.ts:623` | `applyApprovedProductChange`가 승인·게이트만 통과시키고 `mutationPerformed:false`로 **mutation 직전 정지** ("Real executor is not attached") |
| `operator/src/index.ts:372` | `type` 핸들러가 필드 불일치 시 `offsetParent!==null`(첫 보이는 input)으로 **엉뚱한 필드에 값을 써넣는 blind-write** |
| `operator/src/index.ts:356` | `click`이 `textContent` 전역 매칭 — ExtJS SPA에서 동명 텍스트 오클릭 |
| `verifier/src/index.ts:229` | 검증이 `manual_required`만 반환, 구조화 diff 없음 |
| `planner` / rollback | `rollbackPlanId`는 텍스트 필드일 뿐 **역연산 실행기 부재** |
| HCI/SCP `apiCatalogStatus:'ready'` | 실은 **문자열 카탈로그만** 존재, HTTP 클라이언트 0 |

**목표(사용자 확정):**
1. 보안제품(EPP/IAG/CC/NDR) 설정·운영 자동화
2. HCI/SCP 전체 구성·운영 자동화
3. 최종: **필드 엔지니어 1인 대체** → 그다음 **PM 대체**

---

## 2. 핵심 진단 — 6개 축의 비평이 한 점으로 수렴했다

독립적으로 설계·비평한 6개 축 중 **3개(실행·안전 계층, HCI/SCP, 지식·학습)가 같은 선후관계를 못박았다:**

1. **신뢰할 수 있는 검증 oracle은 화면 diff가 아니라 read-back뿐이다.**
   ExtJS 동적 DOM은 실시간 위젯(알람 배지·그래프·세션 수) 때문에 before/after 화면이 *항상* 다르다. 화면 diff로 합격 판정하면 → 영구 false-halt에 빠지거나, noise 필터를 풀면 *서버 저장은 실패했는데 화면만 바뀐 가짜 성공*을 통과시킨다. **안전장치처럼 보이는 가속페달.**

2. **"레시피를 만들면 apply가 안전해진다"는 착시.**
   아무리 정교한 레시피도, 실행기가 `offsetParent` blind-write와 `firstMatch` 폴백을 가진 한 잘못된 셀렉터를 *조용히 실행하고 `ok:true`를 반환*한다. 안전은 (a) 실행기 **fail-closed**(매칭 0건 또는 2건+이면 즉시 abort)와 (b) **구조화 read-back**으로 "의도한 셀렉터 = 실제 바뀐 것" 등가를 강제할 때만 생긴다.

3. **안전 비대칭이 순서를 지배한다.**
   읽기/문서는 틀려도 안전하지만, 설정 적용은 한 번 틀리면 고객 장비가 **비가역**으로 망가진다. (예: IAG 인증/프록시 정책 한 줄 오변경 → 전사 인터넷·로그인 즉시 차단. dry-run으로 안 잡힘.)

> 그래서 1차는 **HCI/SCP**(OpenAPI로 표면이 확정 → GET read-back·멱등·202 폴링이 결정론적)에서 시작하고, **IAG/EPP webui**(동적 ID·동명 텍스트·blind-write의 최악 비결정성)는 뒤로 미룬다.

---

## 3. 설계 원칙 (1차 전 범위에 강제)

1. **Read-back oracle 전용:** 모든 verify는 독립 세션의 read-back(API GET 또는 재로그인 후 설정 재조회)으로만. read-back 경로가 없는 capability는 **자동 apply 대상에서 제외.** 화면 diff는 보조 증거로만.
2. **실행기 fail-closed:** 셀렉터 매칭이 정확히 1건이 아니면 abort. `:372` blind-write 제거. mutation 셀렉터는 고신뢰 등급(stablePath/data-attr)만, text-partial·OCR 좌표클릭은 **write에서 금지.**
3. **가역성이 write 순서를 정한다:** `create-volume`처럼 가역적·self-lockout 없는 단일 op로 파이프라인 전체를 먼저 검증. `create-server`·`prune/delete`·비가역·self-lockout op는 그 뒤로.
4. **측정과 안전의 진실원 분리:** 진척용 메타데이터(`maturity`)와 안전용 가드(`safety_class`)를 **물리적으로 다른 파일**에. 대체율을 부풀리려는 압력이 안전 가드를 약화시키지 못하게.
5. **가드가 실행보다 먼저:** 키 공간 통일·human-only allowlist·감사 원장을 실행기보다 **선행** 배치.
6. **감사 원장 의무화:** write가 시작되는 순간부터 모든 API 요청/응답 원문을 시크릿 마스킹한 채 보존(법적 증빙).

---

## 4. 축별 갭 진단과 보강안 (요약)

| 축 | 핵심 갭 | 1차 보강안 | 1차 판정 |
|----|---------|-----------|---------|
| **HCI/SCP 자동화** | OpenStack/Janus HTTP 클라이언트·이중 인증·멱등·plan/apply 상태기계 전무 | `@sangfor/hci-openstack-client`(read-only 우선) + read-back + ops-monitor + plan(diff)까지 | **include-now (범위 축소)** — read-only·단일 가역 write만, prune/delete·비가역 op defer |
| **보안제품(EPP/IAG/CC/NDR)** | capability×제품×버전 결정론적 액션 레시피·셀렉터 안정화·실행기 부재 | 레시피 DSL + 인터프리터 + 4단 LocatorSpec + store 스냅샷/diff. 단 **키 공간 통일·셀렉터 신뢰등급·`:372` 폴백 제거·read-only 슬라이스부터** | **include-now (조건부)** — mutation·비공식 XHR API 디스커버리·자동 역방향 rollback defer |
| **실행·검증·롤백·신뢰 (공통)** | ChangePlan→ActionRecipe 번역, 상태기계, 자동롤백, diff 임계 정지, 세션 라이프사이클 전무 | read-back oracle 재정의 + capability 안전등급 분류 + Prisma 감사로그(write 제외) | **defer** — oracle을 read-back으로, 롤백을 백업/스냅샷 기반으로 재정의 전엔 write 계층 1차 제외 |
| **필드엔지니어 역량 모델** | 업무 라이프사이클 분류·자동화 커버리지·KPI·핸드오프 프로토콜 전무 | taxonomy를 **안전 가드 allowlist(기본 deny)** 로 재정의한 축소판만 | **defer (부분 include-now)** — 안전 allowlist는 include, coverage%·KPI·대시보드는 defer |
| **PM 대체 로드맵** | Engagement/WBS/리소스/리스크/게이트·오케스트레이터 전무 | 도메인 3모델(Engagement/WorkItem/PmEvent, 무결성) + 실 이벤트 적재 + read-only 타임라인만 | **defer (좁게 include-now)** — CPM/자동 dispatch/gate 엔진/외부 CRM은 drop에 가까운 defer |
| **지식·학습 준비도** | 실행 지식(셀렉터/API/검증/롤백)이 코드에 하드코딩·분산, 버전 태깅·레시피 eval 부재 | 레시피 스키마 + exact lookup + **미존재 시 apply 하드차단**. ★OpenAPI docx 우선 인제스트 | **include-now (범위 축소)** — 단 "실행기 fail-closed"·"read-back primitive" 두 선행과 묶여야 안전 가치 |

> **공통 결론:** 6축 중 *어느 것도* "지금 바로 write 자동화 풀가동"을 지지하지 않는다. 모두 **안전 토대를 먼저 박고, read-only로 가치를 내고, 단일 가역 write로 패턴을 증명**하라고 수렴한다.

---

## 5. 첫 관통 슬라이스 (Vertical Slice)

> **HCI/SCP × `create-volume`(또는 metadata update) 단일 가역 write를 read-back oracle 기반으로 `plan → approve → apply → verify → 복원`까지 관통.**

**왜 이것인가:** HCI/SCP는 OpenAPI(Keystone v2.0 + Nova/Cinder/Neutron)로 표면이 확정 → GET read-back·`X-Client-Token` 멱등이 webui보다 압도적으로 결정론적. `create-volume`류는 **가역적**(삭제로 역연산)이고 **자기 관리세션을 끊지 않으며**(self-lockout 없음), 멱등키→202 태스크 폴링→verify 재수집→단일 역연산이라는 파이프라인 전체를 **최저 위험**으로 검증한다. 이 슬라이스가 패턴을 고정하면 나머지는 대부분 **코드 변경 없는 레시피/엔드포인트 데이터 추가**로 수평 확장된다.

**범위:**
- 실장비 HCI 콘솔에서 **Janus public-key + Keystone serviceCatalog 핸드셰이크 실캡처**로 auth 확정 (추측 코드 금지, 이 spike가 전체 게이트)
- `@sangfor/hci-openstack-client`: read-only 표면(GET servers/volumes/networks/images, tasks 폴링) + 단 하나의 가역 mutation
- read-back primitive(구조화 상태조회), operator **fail-closed 교정**, apply 상태기계 1줄기
- 승인 4필드 + `SANGFOR_ALLOW_REAL_EXECUTION` 게이트 유지하되 `:623` 정지점을 executor 호출로 교체
- Prisma 감사 원장(ChangeRun/ActionLog/Snapshot, 시크릿 마스킹)
- `mock-sangfor-console`에 OpenStack/Janus 픽스처로 무위험 회귀 후 실장비 read-only smoke

**Exit Criteria:**
1. mock에서 `create-volume` 멱등(같은 키 재시도 중복생성 0), 202 폴링, verify 일치, 실패 시 단일 역연산 통과
2. 실장비 HCI read-only smoke(GET inventory + read-back)가 인증 갱신 포함 안정
3. fail-closed 증명: 모호 셀렉터(2건 매칭) 주입 시 write가 abort + 장비 무변경
4. 사람 개입 0회로 apply→verify→복원 완주, 전체가 마스킹된 채 원장에 기록
5. read-back 값 ≠ 기대값이면 자동 halt + 사람 호출 (**false-pass 0**)

---

## 6. 단계별 로드맵

| Phase | 목표 | 핵심 워크스트림 | 기간 | 합격 게이트 |
|-------|------|----------------|------|------------|
| **0 — 안전 토대 + 인증 spike** (선행, 무위험) | write가 올라설 바닥을 먼저 | ① HCI 인증 핸드셰이크 실캡처 ② operator **fail-closed**(`:356` firstMatch, `:372` blind-write 제거) ③ **키 공간 통일**(ENDPOINT_SECURE/EPP/epp, capabilityId vs stepId → ADAPTERS 단일 진실원) ④ `safety_class` vs `maturity` 파일 분리 ⑤ Prisma 감사 원장 + 마스킹 | 2–3주 | auth 캡처 성공, fail-closed가 모호 셀렉터 abort 증명, 레시피 경로 충돌 0, 마스킹 원장 적재 |
| **1 — HCI/SCP read-only 운영자동화** | write 없이 목표2의 절반 달성 + read-back oracle 신뢰 확보 | read-only client(GET + Gnocchi + tasks) + TokenManager 자동갱신, read-back primitive, ops-monitor → DOCX 운영점검 리포트, plan(diff) 출력(apply/delete 코드경로 차단), human-only allowlist(기본 deny) | 3–4주 | 실장비 헬스 리포트 안정 산출, read-back=콘솔값 일치, delete op 생성 자체 불가, allowlist 가드 작동 |
| **2 — 단일 가역 write 관통** (첫 슬라이스 본체) | `create-volume` 파이프라인 전체를 mock→실장비 read-only | apply 상태기계 + `X-Client-Token` 멱등 + 202 폴러, `:623`→executor, verify=read-back 정확일치+자동 halt, 변경 전 백업/스냅샷 의무, 장비 advisory lock + 유지보수윈도우 | 3–4주 | 첫 슬라이스 Exit Criteria 전부 |
| **3 — 레시피 KB + 보안제품 read-only** | 검증된 패턴을 레시피로 외부화, IAG/EPP는 read-only부터 | ActionRecipe 스키마(ExtJS 1급: grid/combobox/form-item, 셀렉터 유일성) + exact lookup + **미존재=apply 하드차단**, verifier/adapters 하드코딩 맵→레시피 이관(1:1 동등 회귀), EPP/IAG read-only collect, NDR 공식 카탈로그 read만 | 4–6주 | 보안제품 read-only e2e 안정, 레시피 미존재 시 하드차단, 이관 레시피 1:1 동등 |
| **4 — 보안제품 단일 가역 write + 광역 무변경 증명** | 보안제품도 가역 write 관통, 단 음성증명 안전망 | mutation 셀렉터 tier1~2만, **광역 diff**(화면 전체+audit log 행 → expected & no-collateral일 때만 통과), capability 가역성 3분류(reversible/compensating/irreversible), self-lockout은 human-only 영구, 전용 서비스계정 | 4–6주 | reversible write 1건 광역 diff 통과, 오셀렉터 시 collateral 잡아 halt, irreversible/self-lockout 자동실행 차단 |
| **5 — PM 데이터 골격** (엔진 아님) | 실행계층 닫힌 뒤 PM 데이터를 오늘부터 적재 | Prisma 3모델(Engagement/WorkItem/PmEvent, 해시체인 무결성), 실 PmEvent 적재, device occupancy 1개, read-only 타임라인 뷰, 일정은 추정 금지·관찰 기록 | 2–3주 | 실 변경마다 무결성 PmEvent 적재, 점유 충돌 가시화. CPM/자동dispatch/gate엔진/CRM은 **착수 안 함(defer 유지)** |

*총 누적 예상: 약 18–26주. Phase 0 인증 spike 결과에 따라 재추정.*

---

## 7. 신규 아키텍처 (1차 범위)

```
기존 packages/* (유지)
  └─ product-adapters / operator / chrome / approval / shared / store / rag / knowledge / ...

신규 (1차)
  packages/hci-openstack-client/   OpenStack·Janus 클라이언트
    auth.ts            Janus public-key + Keystone v2.0 token, TokenManager(만료 60s 전 자동갱신)
    client.ts          undici HttpClient, TLS-skip, X-Auth-Token/X-Client-Token 자동주입, 재시도/rate-limit
    services/{keystone,nova,cinder,neutron,glance,gnocchi,janus-tasks}.ts
  packages/hci-config/
    schema.ts          zod desiredState
    reconcile.ts       diff → PlannedAction[] (1차: plan 출력까지, delete op 생성 불가)
    apply-machine.ts   PENDING→VALIDATING→APPLYING(202 폴링)→VERIFYING(read-back)→SUCCEEDED|ROLLED_BACK
    ops-monitor.ts     헬스/임계치 → 운영점검 리포트
  packages/sangfor-recipes/        (Phase 3~) 데이터 전용: recipes/{product}/{capability}.{version}.json
  packages/sangfor-actuator/       (Phase 3~) interpreter / locator(신뢰등급) / apply / diff

수정
  product-adapters/src/index.ts:623  정지점 → executor 호출 (게이트 유지)
  operator/src/index.ts:356,372      fail-closed 교정 (firstMatch/blind-write 제거)
  prisma/schema.prisma               + ChangeRun / ActionLog / Snapshot (+ Phase5: Engagement/WorkItem/PmEvent)
  apps/mcp-server                    + hci_plan_config / hci_apply_config / hci_verify_config / hci_health_report

안전 자산 (실행기보다 선행)
  data/safety/human-only-allowlist.yaml   기본 deny, 자동실행 허용 atom만 명시 (가드 전용)
  data/competency/maturity.yaml           진척 측정 전용 (가드와 물리 분리)
```

---

## 8. 교차 리스크와 완화 (Top 8)

| # | 리스크 | 완화 |
|---|--------|------|
| 1 | **화면 diff oracle** → false-halt 또는 가짜 성공 | verify는 독립 세션 read-back으로만. read-back 없는 capability는 자동 apply 제외 |
| 2 | **operator blind-write(`:372`) + 폴백** → 엉뚱한 필드에 쓰고 Apply | Phase 0 하드 선행 fail-closed. mutation 셀렉터 tier1~2만, write에서 OCR/partial 금지 |
| 3 | **reconcile prune/delete (state 없는 name 매칭)** → 고객 운영 VM 비가역 삭제 | 1차에서 delete op **생성 자체 차단**. provenance 저널 없이는 후속에도 불허 |
| 4 | **인증 핸드셰이크 단일 실패점** (패딩/알고리즘 미상) | Phase 0 실장비 캡처 spike를 전체 게이트로. 캡처 전 auth 코드 금지 |
| 5 | **자동 역연산 롤백 = 두 번째 mutation** (부분생성/self-lockout/비가역) | 1차는 단일 가역 op에만. 상위 안전망=변경 전 백업/스냅샷 의무. irreversible은 human-only |
| 6 | **안전 가드 ↔ 진척 측정이 같은 진실원** → 대체율 부풀리기가 가드 약화 | maturity와 safety_class 물리 분리. coverage는 교집합만, field_verified는 실장비 증거 링크 필수 |
| 7 | **in-memory 세션 ↔ 영속 메타 불일치** → 죽은 세션에 dispatch | DB엔 sessionId+heartbeat만, dispatch 전 라이브 헬스체크 강제 |
| 8 | **동시성** (사람·스케줄러 동시 작업, 공유 실장비) | 장비 단위 advisory lock을 executor 진입조건에. 점유 사유 PmEvent 기록, 유지보수윈도우 외 차단 |

---

## 9. 성공 지표 (1차)

- **핵심(대체율 아님):** 단일 가역 변경을 사람 개입 0회로 `apply→read-back verify→복원` 완주한 비율
- **안전 게이트 작동률:** 모호 셀렉터·human-only atom·prune 시도가 코드레벨 차단된 비율 — 목표 **100%, false-pass 단 1건도 실패**
- **read-back 정합성:** verify 값 = 실제 콘솔값 일치율 (false-pass = 0이 합격)
- **감사 완전성:** 모든 mutation 요청/응답 원문이 마스킹된 채 원장에 남은 비율 (100%)
- **운영자동화 커버리지:** 수동 HCI 운영점검 항목 중 read-only 자동 리포트로 대체된 항목 수
- **확장 효율:** 신규 capability 1건 추가 시 코드 변경량 (목표: 레시피/엔드포인트 데이터 추가만)
- **정직한 대체 진척:** `maturity=field_verified AND safety_class=auto_allowed` 교집합 atom 수 / 전체 (**MCP 툴 존재 ≠ 대체**)
- *MTTR·자동완료율 등 수기 KPI는 1차 제외* (자동화할 게 실재한 뒤 부착)

---

## 10. 결정이 필요한 사항 (사용자 입력 요청)

1. **인증 spike 일정/접근:** 실장비 HCI 콘솔에서 Janus public-key + Keystone serviceCatalog 핸드셰이크를 누가·언제 캡처? (전체 게이트)
2. **첫 가역 write:** `create-volume`(자원 생성/삭제로 명확, 쿼터 영향) vs `metadata update`(가볍지만 verify 신호 약함) — 실장비 read-back이 또렷한 쪽으로.
3. **타깃 버전 고정:** HCI 6.9/6.10/6.11, IAG 13.0.80/13.0.120 중 **실장비 실버전 = 외장드라이브 매뉴얼 버전**이 일치하는 조합 (field_verified 가능 조건).
4. **실장비 성격:** EPP/CC/IAG 3대가 다수 고객 POC/운영 **공유**인지 **전용 lab**인지. (device lock 강도, 운영 중 readonly 허용 여부)
5. **서비스 계정:** 단일 `admin/sangfor` 대신 **전용 서비스계정**을 고객 콘솔에 생성 가능한지. (audit에서 사람 vs 봇 구분, 책임 경계 — Phase 4 전 결정)
6. **법무/계약:** 고객 production 자동 mutation 사전동의·책임경계·변조불가 감사로그 요건. **진짜 블로커는 기술이 아니라 이 절차.** 1차를 lab 한정할지, 특정 고객 동의 하 production read-only까지 갈지.
7. **비공식 API:** EPP/CC 내부 XHR 디스커버리를 EULA 리버스엔지니어링 금지 관점에서 영구 **drop**할지, 벤더 **공식 API 요청 트랙**으로 전환할지.

---

## 11. 다음 단계 (이 제안서 승인 후)

1. **§10의 7개 결정사항 회신** — 특히 1·3·6은 Phase 0 착수 전 필수.
2. 결정 확정 시 → `superpowers:brainstorming` 기반으로 **Phase 0 상세 설계** + `docs/PROJECT_ARCHITECTURE.md`에 신규 패키지 계약 추가.
3. Phase 0 인증 spike → 성공 시 전체 effort 재추정, 실패 시 인증 방식 재조사(이 spike가 모든 후속의 의미를 좌우).

---

### 부록 A. 산출 근거
- 코드 전수 분석: `docs/PROJECT_ARCHITECTURE.md` (apps/packages 전 파일)
- 6축 멀티에이전트 설계+적대적 비평+종합 (워크플로 `sangfor-fieldeng-proposal`, 13 에이전트, ~100만 토큰)
- 1차 자료: 외장드라이브 `5. HCI/API_HCI_SCP_open-api...docx`(엔드포인트 표면 확정), HCI 6.10 User Manual, SCP POC test guide 6.9.0, IAG v13 User Manual/POC Guide, EPP Athena 6.0.4, CC v3.0.98C; DB 학습 KB 카탈로그(EPP 36/NDR 21/IAG·SWG/HCI) + product tables

### 부록 B. 1차에서 의도적으로 *제외*한 것 (defer/drop)
- prune/delete, `create-server` 등 비가역·고위험 op
- 자동 역방향 롤백(가역 단일 op 외)
- 전체 선언형 클러스터 구축(클러스터 join·aStor 풀·HA/DRS·라이선스 WebUI 폴백)
- 비공식 XHR API 디스커버리(EPP/CC)
- PM 엔진(CPM·자동 dispatch·gate 상태기계·외부 CRM) — 데이터 골격만 Phase 5
- coverage%·KPI 대시보드·MTTR (자동화 표면 실재 후)

*본 제안서는 1차(초안)이며, §10 결정사항 회신에 따라 v2에서 범위·일정·우선순위를 확정한다.*
