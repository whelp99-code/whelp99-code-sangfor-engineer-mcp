# Sangfor Engineer MCP — 향후 6개월 발전 로드맵 (2026-07-08 → 2026-12)

> **For agentic workers:** 이 문서는 다른 에이전트/엔지니어가 세션 교체 후에도 바로 이어받도록 쓴 **핸드오프용 상세 계획서**다. 현재 상태(§1)를 먼저 읽고, "즉시 재개 지점(§8)"부터 손대라. 모든 작업은 §5의 안전 불변식과 §6의 품질 게이트를 암묵적으로 준수한다(위반 시 중단·보고). 실행 순서: `docs/superpowers/plans/2026-07-02-final-goal-master-plan.md`(원본 마스터플랜)의 M0~M7 골격을 계승하되, 이 문서가 2026-07-08 기준 최신 상태·우선순위로 갱신한다.

**North-star:** "필드 엔지니어 1인 대체 → PM." 성공은 데모가 아니라 **대체율(replacementRate)** 로 측정한다 = `field_verified & automatable & tool-covered & evidence-backed 원자 수 / automatable 원자 수` (`@sangfor/competency`). 현재 ≈ **12.5%(2/16)**. 6개월 목표: **≥ 40%**.

**영구선(불변):** AI는 조언·준비·미리보기·검증만. 사람이 되돌릴 수 없는 손과 서명을 소유한다. 자율 비가역 변경·무인 프로덕션 write·자율 롤백은 설계상 범위 밖.

---

## 1. 현재 상태 스냅샷 (2026-07-08 기준, 코드 근거)

### 1.1 완료·머지됨 (mock-first 전 범위 + 품질 하드닝)
| 영역 | 상태 | 근거 |
|---|---|---|
| M0 신뢰 잔여 봉인 | ✅ merge `988a10a` | nonce 단일소비, 원격 write 기본거부, navigate origin 가드, 문서 드리프트 |
| M1 HCI 실행 수직슬라이스(mock) | ✅ merge `9ae447d` | `@sangfor/hci-client`(apply-machine·read-back·audit-ledger), mock OpenStack(quota-silent-noop), MCP 5도구, exit-e2e |
| M2 자문 심화(mock) | ✅ merge `0e215a8` | `@sangfor/config-state`, context_dependent, spec 44항목 |
| control-tower / playbook / 멀티벤더 자문 | ✅ | 각 플랜 100% 커밋, e2e green |
| 품질 하드닝 P0~P2 | ✅ merge `ebc0a0a`까지 | UI 브라우저 회귀스위트(`tests-ui/`+`test:ui`), 학습루프 JSONL 영속화, product-adapters 실행기 seam, wiki action-bound HMAC, 랩IP→env, 문서 드리프트 스윕 |
| M3 실장비 read-only 진단(1차) | ✅ merge `d57b752` | EPP 6.0.4(정상4/판정불가10), CC 3.0.98(정상1/판정불가5) live; IAG 인증+수동 deep-config; M4 read-only(서버29) |

**검증 기준선:** 유닛 431 통과/2 skip(72 파일) · UI 3 통과 · lint 0 · build OK · MCP 도구 ~77개.

### 1.2 진행 중(세션 리밋으로 중단) — **즉시 재개 대상**
- **Task 2 (판정불가 축소)**: EPP 10 + CC 5 판정불가 항목의 실제 값이 어느 API/DOM에 있는지 찾는 **read-only 심화 캡처 에이전트**가 소싱 리포트 작성 중 세션 리밋(11:10pm 리셋)으로 중단. `/tmp/dev-captcha/{EPP,CC}_deep_pool.json`이 부분 생성됐을 수 있음.
- **Task 3 (IAG live deep-config)**: IAG가 Vue SPA라 설정을 API로 노출하는지 DOM 렌더값만 있는지 probe 미완.

### 1.3 블록됨 (장비/인프라 게이트)
- **M4 create-volume write**: SCP `10.80.1.104:4430` 인증·인벤토리(서버29) read-only OK지만 `volumeServiceAvailable=false`(**cinder/volume 미배포=503**). VPN·자격증명으로 해소 불가 — **cinder-enabled SCP 확보가 인프라 선결과제**.
- **P1-1 실 operator 실행기 연결**: seam은 부착됨(기본 무mutation). 실제 operator write 경로는 M4 실장비 검증과 함께 진행 예정.

### 1.4 알려진 잔여 부채
| # | 항목 | 위치 | 처리 방향 |
|---|---|---|---|
| D-a | 수집 스크립트에 랩 비밀번호 하드코딩 fallback | `scripts/device-collect.ts`(env override 됨, 하지만 fallback+git history에 잔존) | env-required fail-closed화 + history 정리(§4 M1) |
| D-b | RAG 로컬 JSON O(n) 스캔 | `@sangfor/rag` | 코퍼스 성장 시에만(§4 M4) |
| D-c | tech-debt-tracker gitignored인데 committed 문서 4곳이 링크 | `AGENTS.md`·`PLANS.md`·`QUALITY-SCORE.md`·design-docs | `docs/TECH-DEBT.md` 승격 or 링크 제거(사용자 정책 결정) |
| D-d | IAG Vue SPA 설정 machine-readable 미노출 | `scripts/iag-diagnose.ts`(수동관찰값 사용) | Task 3(§4 M1) |

---

## 2. 전략 프레임 (우선순위 규칙)
1. **안전/정확성 > 능력.** 게이트+read-back 검증이 존재해야 자동화가 나간다. 안전 스파인 없는 폭은 음의 가치.
2. **read-only 깊이 > write 폭.** 자문/진단을 여러 제품에 걸쳐 깊게 — 신뢰(와 시간절감)의 대부분이 여기 있다.
3. **정직한 측정 > 화려한 데모.** field_verified·evidence-backed 원자만 대체율에 센다.
4. **local-first, human-in-the-loop.** 고객 데이터는 로컬, 비가역 결정엔 사람.
5. **토큰 경제.** 명세 명확한 실행·기계적 grind는 저렴한 모델(Sonnet/Haiku, `chore`/opencode)에 위임; 메인 루프는 계획·안전·리뷰·최종 판정만.

---

## 3. 6개월 마일스톤 개요
| 월 | 마일스톤 | 대체율 목표 | 게이트 |
|---|---|---|---|
| M1 (2026-07) | 실장비 read-only 진단 완성 + 잔여 부채 정리 | 12.5→**20%** | VPN(충족) |
| M2 (2026-08) | 자문 field_verified 승격 + 버전 진실표(M3/M5) | →**28%** | VPN |
| M3 (2026-09) | HCI 실행 슬라이스 field 관통(M4) + 실 executor | →**33%** | **cinder SCP(사용자)** |
| M4 (2026-10) | 운영화(M6) + 신뢰성/관측성 | →**36%** | M3 |
| M5 (2026-11) | 벤더 폭 확대 + PM 워크플로 e2e | →**40%** | — |
| M6 (2026-12) | 보안 리뷰 + 대체율 마일스톤 + 통합 | **≥40%** 고정 | — |

---

## 4. 월별 상세 계획

### M1 (2026-07) — 실장비 read-only 진단 완성 + 부채 정리
**목표:** EPP/CC/IAG 판정불가를 자동수집으로 최대한 줄이고, 자문 진단 파이프라인을 재현가능·안전하게 굳힌다. 수집 스크립트의 시크릿을 제거한다.

- **T1.1 심화 캡처 재개 (Task 2 이어받기).** 중단된 소싱 리포트를 재개 — EPP 판정불가 10개(`securityBaselineRuleCount`, `malwareScanScheduleEnabled`, `vulnDefUpdateAvailable`, `darMonitoringActive`, `endpointIsolationConfigured`, `agentAutoUpdateEnabled`, `quarantineConfigured`, `edrBehaviorMonitoringEnabled`, `deviceControlConfigured`, `exclusionListManaged`)와 CC 5개(`ntpSynced`, `activeEventSources`, `alertChannelConfigured`, `alarmTuningConfigured`, `syslogForwardingConfigured`)가 어느 API 응답의 어느 JSON 경로에 있는지 확정. 미노출은 정직히 "not-machine-exposed". **수용:** 각 항목당 [엔드포인트+JSON경로+실관측값] or [not-machine-exposed] 결론. (read-only, 저렴한 모델 위임)
- **T1.2 safe-nav 정제 (안전 스파인 — 메인 루프 직접).** `packages/sangfor-collector/src/safe-nav.ts`의 denylist가 액션 **버튼**(save/apply/isolate/생성)은 계속 막되, config **뷰 페이지 라벨**(Isolation/Device Control 등)로의 네비게이션은 허용하도록 분리. **불변식:** 뷰 열람은 허용, mutation 버튼 클릭은 여전히 금지. 리팩터 뒤 refusal 테스트로 "Save/Apply/Enable 버튼은 여전히 거부" 증명.
- **T1.3 매퍼 확장.** T1.1이 찾은 필드를 `mapEppPoolToConfigState`/`mapCcPoolToConfigState`(`@sangfor/config-state`)에 추가해 새 observedKey 추출. 없는 값은 매핑하지 않음(INDETERMINATE 유지). `tests/config-state.test.ts`에 fixture 기반 케이스 추가.
- **T1.4 재현가능 심화수집.** T1.1의 탐색을 `scripts/device-collect.ts`(또는 신규 `device-collect-deep.ts`)에 흡수해 1커맨드 재현. `collect_device_config` MCP 도구도 심화 경로 반영.
- **T1.5 IAG 파이프라인 (Task 3).** probe 결과에 따라: (a) API 노출되면 매퍼로 live 소비, (b) DOM만이면 특정 페이지(802.1X/로그보존/웹인증)의 렌더값을 **read-only DOM 스크레이프**하는 수집기 신설 + `iag-diagnose.ts`가 provenance=live로 소비. 불가 항목은 provenance=manual 유지(솔직 라벨).
- **T1.6 시크릿 제거 (D-a).** `scripts/*`의 하드코딩 비밀번호 fallback을 제거하고 env-required fail-closed(`SANGFOR_*_PASSWORD` 없으면 명확히 종료). CODE-REVIEW Blocker(무커밋 시크릿) 해소. git history의 과거 랩 비번은 별도 정리(BFG/filter-repo) 여부 사용자 결정.
- **T1.7 재진단 + 산출물.** EPP/CC/IAG 재진단 → `outputs/diagnosis/*` 갱신, 판정불가 축소 수치 보고.

**M1 수용 기준:** EPP/CC 판정불가가 자동수집으로 유의미하게 감소(가능분 전부 반영, 미노출은 라벨링); IAG live/manual 경계 명확화; 수집 스크립트에 시크릿 0; `npm test && npm run lint && npm run test:ui` green.

### M2 (2026-08) — 자문 field_verified 승격 + 버전 진실표
**목표:** 이미 실장비에서 나온 진단 증거로 자문 원자를 `tested_mock → field_verified`로 승격해 대체율을 실질 상승. 버전델타(M3) 확정.

- **T2.1 competency 원자 승격.** `@sangfor/competency` 원장에서 EPP/CC/IAG 자문·진단 원자에 evidence 링크(`outputs/diagnosis/*` 아티팩트) 부착 → `field_verified`. **불변식:** evidence 없는 승격 금지(코드가 강제).
- **T2.2 버전 진실표(M3 완결).** EPP 6.0.4 / CC 3.0.98 / IAG 13.0.120 / SCP(HCI) 버전을 실장비 read로 확정, 매뉴얼-버전 대조표 작성. 자문 spec의 버전 적용성 검증.
- **T2.3 spec 심화(M5 일부, page-verified).** 실소스(support.sangfor.com 매뉴얼) page-verified 캡처로 각 제품 spec 항목 40→60+ 확대. INDETERMINATE≠PASS·날조금지 준수(출처 없으면 추가 안 함).
- **T2.4 멀티벤더 실장비(있으면).** 랩에 FortiGate/Cisco 있으면 fortios/cisco advisor를 실장비로 field-verify.

**M2 수용 기준:** 대체율 ≥28%(승격 원자에 evidence 링크 검증); 버전 진실표 문서; spec 커버리지 floor 상향.

### M3 (2026-09) — HCI 실행 슬라이스 field 관통 (M4) — ⚠️ 사용자 인프라 선결
**목표:** 되돌릴 수 있는 단일 write(create-volume)를 실장비에서 게이트 통과→read-back 검증→복원까지 관통. 첫 field_verified WRITE.

- **T3.0 (선결·사용자) cinder-enabled SCP 확보.** 현 SCP(10.80.1.104)는 volume 미배포(503). cinder/volumev2 배포된 SCP 또는 랩 확보 필요. **이게 없으면 M3 전체 대기.**
- **T3.1 M4 read-only 재확인.** `hci-real-smoke`로 `volumeServiceAvailable=true` 확인(§8 커맨드).
- **T3.2 실 executor 연결 (P1-1 실경로).** `applyApprovedProductChange`의 executor seam에 operator signed 실행기를 붙여 create-volume 수행. **불변식:** 기존 게이트(승인·`SANGFOR_ALLOW_REAL_EXECUTION`·nonce 단일소비) 전부 통과 + read-back oracle로만 성공 판정(202≠성공) + 실패 시 halt(자동 롤백 금지).
- **T3.3 관통 시나리오.** plan → 승인(HMAC+nonce) → apply(create-volume) → **독립 GET read-back 검증** → 복원(delete-volume, 사람 승인). 감사 원장(hash-chain)에 전 과정 기록. **사람 서명 필수**.
- **T3.4 competency WRITE 원자 승격.** create-volume 원자 → field_verified(evidence=감사원장 runId).

**M3 수용 기준:** 실장비 create-volume이 read-back PASS로 검증되고 복원됨; 모든 게이트 로그로 증명; 대체율 ≥33%; **비가역 단계마다 사람 sign-off 존재**.

### M4 (2026-10) — 운영화(M6) + 신뢰성/관측성
- **T4.1 주기 헬스리포트(M6.3).** launchd/cron으로 HCI/EPP/CC 헬스·자문 주기 실행 → `outputs/`. 실패 시 알림(사람에게).
- **T4.2 대체율 자동갱신(M6.4).** 새 field evidence 생기면 competency 원장 자동 반영 파이프라인.
- **T4.3 관측성.** control-tower에 실행/승인/실패 텔레메트리, sweep 이력 대시보드 강화(이미 UI 회귀 테스트 있음 → 신규 패널도 `tests-ui/`로 커버).
- **T4.4 RAG 스케일 점검(D-b).** 코퍼스 성장 시 O(n) 스캔 지연 측정, 필요 시 인덱스 개선(local-first 유지).
- **T4.5 잔여 영속화 엣지.** control-tower 단일도구 paused-args 등은 의도적 비복구(문서화됨) — 재검토.

**M4 수용 기준:** 주기 점검 무인 동작(사람 sign-off 게이트 유지); 대체율 자동갱신 검증; 대체율 ≥36%.

### M5 (2026-11) — 벤더 폭 + PM 워크플로 e2e
- **T5.1 벤더 확대.** read-only 자문 깊이 우선(원칙#2). 신규 제품 = spec + client mapper 추가(engine 불변), field-verify.
- **T5.2 PM 워크플로 관통.** engagement → 요구분석 → plan → 승인 → apply(가역 write) → verify → 리포트를 실장비로 e2e. playbook으로 정형화.
- **T5.3 field-verified playbook 라이브러리.** 흔한 현장 절차(자문+단일 가역 write)를 검증된 playbook으로 축적.

**M5 수용 기준:** 최소 1개 PM 워크플로가 실장비 e2e; 대체율 ≥40%.

### M6 (2026-12) — 보안 리뷰 + 대체율 마일스톤 + 통합
- **T6.1 전면 보안 리뷰.** write 경로가 라이브가 된 상태로 `/security-review` + 외부 관점(적대적) — 게이트·HMAC·nonce·마스킹·바인드 전수.
- **T6.2 대체율 ≥40% 고정 + 정직성 감사.** field_verified 원자 evidence 재검증(false-field-verified 0).
- **T6.3 문서·런북·핸드오프 품질.** 모든 실장비 절차 런북화, design-docs 갱신.
- **T6.4 회고 + 다음 반기 계획.**

**M6 수용 기준:** 보안 리뷰 blocker 0; 대체율 ≥40% evidence-backed; 문서 드리프트 0(`/oma-docs verify`).

---

## 5. 안전 불변식 (전 기간 강제 — 위반은 중단·보고)
1. **INDETERMINATE ≠ PASS.** 미관측·근거없음은 정상으로 세지 않는다.
2. **2xx ≠ 성공.** write 성공은 독립 read-back PASS로만.
3. **fail-closed.** 시크릿·서비스·파일 부재, 셀렉터 0/다중 매칭 → 거부.
4. **write 게이트.** 모든 write = action-bound HMAC 승인 + `SANGFOR_ALLOW_REAL_EXECUTION`(+비-loopback시 remote-write 플래그) + nonce 단일소비.
5. **자동 롤백 금지.** 실패는 halt+사람 호출.
6. **마스킹 후 영속.** 시크릿은 원장/로그/파인튠 이전에 마스킹. **미마스킹 시크릿 커밋·영속 금지.**
7. **read-only는 mutate 안 함.** 진단/수집은 mutation 버튼 클릭 없이.
8. **사람이 비가역 결정 소유.** 자율 비가역 변경·무인 프로덕션 write·자율 롤백 = 범위 밖.

## 6. 품질 게이트 (태스크 완료 정의)
- `npm test`(무회귀 + 신규 통과) && `npm run lint`(0), 빌드영향 시 `npm run build`, UI영향 시 `npm run test:ui`.
- 안전 경로 변경엔 refusal 테스트. 새 벤더 로직은 engine이 아니라 spec+mapper.
- 새 로직은 app 핸들러가 아니라 package. 의존성 하향(ARCHITECTURE.md). `@sangfor/shared`는 leaf.
- Conventional Commits, 태스크당 1커밋+, 테스트와 구현 동일 커밋. 실장비 write는 사람 sign-off.
- "done"은 증거로만: 실행 커맨드+관측 결과.

## 7. 지표(KPI)와 목표
| 지표 | 현재(2026-07-08) | 6개월 목표 |
|---|---|---|
| 대체율(field_verified & automatable) | ≈12.5% (2/16) | ≥40% |
| field_verified WRITE 능력 수 | 0 | ≥1 (create-volume) |
| 실장비 read-only 진단 제품 | 4 (EPP/CC/IAG/HCI) | +멀티벤더 |
| spec 커버리지(page-verified) | 44항목/floor37 | 60+/floor 상향 |
| 자동 테스트 | 431 유닛+3 UI | 유지+신규 커버 |
| 문서 드리프트 | 0(스윕 완료) | 0 유지 |

## 8. 즉시 재개 지점 (다음 세션 첫 손댈 것)
1. **심화 캡처 재개(T1.1):** 세션 리밋(11:10pm 리셋) 후, VPN 확인 → 중단된 소싱 탐색 재개. `/tmp/dev-captcha/{EPP,CC}_deep_pool.json` 잔존분 확인.
2. **재현 커맨드:**
   - 도달성: `curl -sk -o /dev/null -w "%{http_code}" https://10.80.1.106/`
   - EPP 수집: `SANGFOR_EPP_PASSWORD='<현재비번>' PRODUCT=EPP npx tsx scripts/device-collect.ts` (CAPTCHA는 `/tmp/dev-captcha/EPP.png` 판독→`EPP.code` 기록)
   - EPP 진단: `npx tsx scripts/epp-diagnose.ts`
   - M4 read-only: `SANGFOR_HCI_IDENTITY_URL='https://10.80.1.104:4430/openstack/identity/v2.0' SANGFOR_HCI_TENANT=admin SANGFOR_HCI_USER=admin SANGFOR_HCI_PASSWORD='<scp비번>' npx tsx scripts/hci-real-smoke.ts` → `volumeServiceAvailable` 확인
3. **자격증명:** 실 비밀번호는 env로만 전달, repo/커밋 금지. (EPP 비번은 세션 중 로테이션됨 — 사용자에게 현재값 확인.)

## 9. 사용자 결정 필요 (블로커 해소용)
1. **[M3 선결] cinder/volume 배포된 SCP** 확보 여부·경로. (현 SCP는 volume 503.)
2. **[정책] git history의 랩 비밀번호** 정리 여부(BFG/filter-repo로 rewrite vs 그대로 두기).
3. **[정책] tech-debt-tracker(D-c)** — `docs/TECH-DEBT.md`로 승격(커밋) vs 링크 제거.
4. **[데이터 거버넌스] outputs/diagnosis 커밋 정책** — 고객 장비 config 관측값을 repo에 계속 커밋할지.
5. **[write 승인] 실장비 write 시점** — M3의 create-volume은 사람 서명 후에만 실행(원칙상 항상 확인).

---

## 부록 A — 원본 마스터플랜과의 관계
`2026-07-02-final-goal-master-plan.md`의 M0~M2(mock)·M3~M6(게이트)·M7(규칙)을 계승. 2026-07-08 기준 변화: M0/M1/M2 완료, M3 read-only 1차 완료(EPP/CC/IAG/HCI), M4는 cinder 미배포로 write 대기. 이 문서가 이후 우선순위·상태의 단일 소스.

## 부록 B — 위험 & 완화
| 위험 | 영향 | 완화 |
|---|---|---|
| 실장비 값 자동수집 불가(Vue SPA 등) | 판정불가 잔존 | 정직 라벨(not-machine-exposed) + 필요시 read-only DOM 스크레이프, 억지 채움 금지 |
| cinder SCP 미확보 장기화 | M3 WRITE 대체율 정체 | read-only 깊이(M1/M2)로 대체율 선상승, write는 게이트 뒤 대기 |
| 실장비 write 사고 | 비가역 손상 | 게이트+read-back+사람 서명+가역 대상만, 자동 롤백 금지 |
| 세션 리밋으로 장시간 작업 중단 | 진행 손실 | 증분 커밋, /tmp 풀 보존, §8 재개 지점 유지, 저렴한 모델 위임 |
| 시크릿 유출 | 보안 사고 | env-only, 마스킹, 커밋 금지, history 정리(사용자 결정) |
