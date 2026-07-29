# 전체 계획 검토 및 개발 순서 체크리스트

최종 갱신: 2026-07-29
검토 기준 브랜치: `integration/pr001-security-followups`
검토 기준: `a83bd7c` 계획 완료 보고 → `3bc51d4` IAG 진단 코드 체크포인트
판정: **APPROVE_WITH_CONDITIONS**

이 문서는 흩어진 계획을 다시 실행하기 위한 단일 체크리스트다. 기존 계획의 역사와 완료 증거는 보존하되, 자동 테스트가 있다는 이유만으로 실제 런타임 통합이나 외부 실증을 완료로 간주하지 않는다.

## 1. 결론

- Registry, lifecycle, approval primitive, local store, observer capture, encrypted bundle, research, mirror, MCP 8개, CLI 2개는 구현과 자동 검증이 있다.
- 기존 완료 보고의 `PR-001A~PR-012 완료`, `REQ-01~REQ-24 완료` 표기는 **자동 인수 테스트 범위의 완료**로만 해석해야 한다.
- Fact→Spec 안전 경계, LM-08 서명 확인, 여러 learning method의 실제 observer 연결은 계획의 런타임 완료 조건을 충족하지 못했다.
- 내부 TypeScript `FactService`, MCP `sangfor.collect_facts`, 범용 `/tools/call` 브리지는 존재하지만, 사용자가 요청한 **전용 REST API와 OpenAPI 생성은 미착수**다.
- IAG 13.0.120 수동 관측 진단은 `3bc51d4`에서 완료됐으며, 자동 DOM 수집기와 INDETERMINATE 수집 가이드는 별도 미완료 항목이다.
- 실제 장비·VPN·FortiOS 8.0·PostgreSQL 실증은 계속 `BLOCKED` 또는 `NOT_RUN`이다.

## 2. 문서 정본과 역사 문서

### 현재 정본

| 문서 | 역할 | 처리 원칙 |
|---|---|---|
| [PR-001 진행 현황](./2026-07-27-pr001-progress.md) | 과거 완료 보고와 검증 기록 | 현재 HEAD와 런타임 통합 상태를 반영하기 전에는 최종 상태 정본으로 단독 사용하지 않는다. |
| [Learning Strategy Observer 계획](./plans/2026-07-23-learning-strategy-observer.md) | REQ-01~25와 PR-001A~012 계약 | 요구사항·실패 경계 정본으로 유지한다. 아래 체크리스트가 현재 구현 상태를 교정한다. |
| [최종 검증 보고서](./results/final-verification-a83bd7c.md) | `a83bd7c` 시점 증거 | 역사 증거로 유지한다. `5257534` 이후 변경을 검증한 증거로 재사용하지 않는다. |

### 참고·레거시 계획

| 문서 | 분류 | 남겨 쓸 내용 |
|---|---|---|
| `2026-07-08-six-month-roadmap.md` | 레거시 포트폴리오 | 장기 순서와 외부 의존성 |
| `2026-07-08-m1-execution-tasks.md` | 레거시 실행 참고 | M1 초기 작업 분해 |
| `2026-07-08-plan-hardening-no-to-yes.md` | 보안·정직성 요구 정본 | T-H1~T-H7 완료 정의 |
| `2026-07-08-feature-backlog.md` | 아이디어 풀 | 현재 우선순위에 자동 편입하지 않는다. |

`2026-07-02-final-goal-master-plan.md`와 control-tower, playbook, multi-vendor 개별 구현 계획은 완료된 역사 문서다. 이 문서의 미완료 목록과 충돌할 경우 이 체크리스트의 현재 상태를 우선한다.

## 3. 계획-저장소 동기화 체크포인트

- [x] `a83bd7c` 이후 `5257534`에서 observer data path를 `data/` 아래로 고정했다.
- [x] `data/captures/*.enc` 실제 저장 위치, 파일 모드 `0600`, git ignore, Keychain decrypt round-trip을 실환경에서 확인했다.
- [x] IAG 진단 변경을 독립 작업 단위 `3bc51d4`로 마감하고 새 검증 기준점을 기록했다.
- [x] [PR-001 진행 현황](./2026-07-27-pr001-progress.md)에 `3bc51d4` 재동기화 체크포인트와 완료 범위 교정을 추가했다.
- [ ] observer 계획 본문의 오래된 분해 대기 표기 10건은 구현 작업으로 재활성화하지 말고, 후속 체크포인트에서 역사 표기임을 명시한다.

`3bc51d4`의 IAG 변경은 수동 sanitized observation을 엄격히 파싱하고 보고서를 생성하는 advisory 작업이다. 이것은 learning observer의 method driver, CDP 자동 수집, Fact API 또는 전용 REST API 완료 증거가 아니다.

## 4. 전체 상태표

상태 정의:

- `DONE`: 저장소에 런타임 구현이 있고 해당 경계를 검증했다.
- `AUTOMATED`: 자동·synthetic 경계는 완료했지만 현재 실환경 증거가 없다.
- `IN_PROGRESS`: 일부 구현은 있으나 계획의 런타임 완료 조건을 충족하지 못했다.
- `DRIFTED`: 완료 보고와 실제 구현이 중요한 계약에서 다르다.
- `UNTOUCHED`: 전용 구현이 없다.
- `BLOCKED`: 외부 인프라나 명시적 승인이 필요하다.

### Learning Strategy Observer REQ

| 범위 | 상태 | 현재 증거와 남은 일 |
|---|---|---|
| REQ-01~07 registry/version/DSL/store/lifecycle/approval/resolver | DONE | strict registry, truth transition, CAS, lifecycle, durable nonce, exact resolver 구현과 테스트가 있다. |
| REQ-08~10 CDP/passive capture/encrypted bundle | DONE | loopback CDP, structural capture, AES-GCM bundle과 실환경 round-trip이 있다. 최종 배포 전에 E2E를 다시 실행한다. |
| REQ-11 LM-01 | IN_PROGRESS | synthetic facade는 있으나 non-synthetic 경로는 `SYNTHETIC_ONLY`; 공식 GET/HEAD transport가 없다. |
| REQ-12 LM-02 | IN_PROGRESS | 미승인 실행 차단은 DONE. 승인 후 실제 transport는 placeholder다. |
| REQ-13 LM-03 | IN_PROGRESS | synthetic ExtJS store만 있고 실제 store 연결은 없다. |
| REQ-14 LM-04 | IN_PROGRESS | synthetic DOM만 있고 observer/CDP 세션과 연결되지 않았다. |
| REQ-15 LM-05 | DONE | bounded local JSON/CSV import가 있다. |
| REQ-16 LM-06 | IN_PROGRESS | inbound stream은 synthetic-only다. |
| REQ-17 LM-07 | IN_PROGRESS | local OCR provider가 없다. |
| REQ-18 LM-08 | DRIFTED | raw SHA-256 값은 signed typed confirmation이 아니다. HMAC, 만료, action binding, single-use nonce가 필요하다. |
| REQ-19 Fact API | IN_PROGRESS | 내부 `FactService`와 MCP 표면은 있다. 실제 method 실행, 구체적인 `partial`, 전용 네트워크 API가 없다. |
| REQ-20 Observer-only Spec gate | DRIFTED | adapter가 registry map만 만들고 exact spec load/evaluate, digest/truth eligibility, complete provenance를 한 production boundary에서 강제하지 않는다. |
| REQ-21~22 research/mirror | AUTOMATED | stale workflow, local outbox, retry/DLQ가 구현됐다. live evidence의 대체물은 아니다. |
| REQ-23 MCP | DONE | learning tool 8개, 전체 85 tools 등록이 있다. |
| REQ-24 CLI | DONE | `strategy`, `observe` CLI가 등록됐다. |
| REQ-25 pilot honesty | DONE / BLOCKED | 허위 PASS 거부는 DONE. CC/IAG/FortiOS 실제 pilot는 `BLOCKED`/`NOT_RUN`이다. |

### 기존 hardening 및 제품 표면

| 항목 | 상태 | 현재 판단 |
|---|---|---|
| T-H1 mock-cinder E2E | DONE / BLOCKED | mock read-back flow는 완료. 실제 cinder 장비 write는 외부 차단이다. |
| T-H2 offline capture bundle | DONE | `capture-bundle.v1`과 `data/captures/*.enc`로 통합됐다. |
| T-H3 IAG read-only DOM collector | IN_PROGRESS | 수동 JSON 관측 진단은 있다. 자동 live DOM collector는 없다. |
| T-H4 INDETERMINATE collection guide | UNTOUCHED | 미관측 항목 목록은 있으나 다음 수집 행동을 생성하는 기능은 없다. |
| T-H5 no-fabrication evidence gate | IN_PROGRESS | 일부 learning/competency 경계는 증거를 요구한다. 범용 `evaluate_config`에서 provenance 없는 값의 PASS를 전역 차단하지 못한다. |
| T-H6 acceptance definition | DONE | INDETERMINATE와 외부 pilot 상태를 PASS와 분리한다. |
| T-H7 M2~M6 zero-context cards | IN_PROGRESS | 개별 계획은 있으나 현재 실행 순서와 adjustment point의 단일 정본이 없었다. 이 문서가 상위 체크리스트 역할을 시작한다. |
| Generic HTTP bridge | DONE | `/health`, `/tools`, `/tools/call`과 fail-closed tool guard가 있다. |
| Dedicated REST/OpenAPI | UNTOUCHED | 제품별 versioned route와 repository-owned OpenAPI 문서/생성기가 없다. |
| IAG 13.0.120 manual diagnosis | DONE | `3bc51d4`에서 strict parser, CLI, spec/report 교정과 focused 검증을 완료했다. |
| External pilots | BLOCKED | VPN, 실제 장비, FortiOS 8.0, 운영 CDP, PostgreSQL 접근이 필요하다. |

### 4.1 Legacy M0~M7 마일스톤 상세

이 표의 `M0~M7`은 2026-07-02 마스터플랜의 역사 마일스톤이다. 아래 `Wave 0~7` 실행 순서와 이름이 비슷하지만 서로 다른 축이다.

| 마일스톤 | 현재 상태 | 구현·검증 범위 | 남은 게이트 |
|---|---|---|---|
| M0 신뢰 잔여 봉인 | PASS | `FileNonceStore`, action-bound HMAC 승인, 비-loopback write 차단, navigate origin guard, 문서 드리프트 회귀가 구현됐다. | 신규 API에서도 같은 primitive를 우회하지 않아야 한다. |
| M1 HCI 수직 슬라이스 | PASS (mock) | Keystone/Cinder 계약 catalog, mock OpenStack, `@sangfor/hci-client`, audit ledger, `X-Client-Token` 멱등성, quota silent-noop 탐지, read-back E2E가 있다. | cinder-enabled 실장비 create-volume은 M4 외부 게이트다. |
| M2 자문 3서비스 심화 | PASS (historical baseline) | `sangfor.collect_device_config`, context-dependent 판정, 출처를 가진 40+ spec baseline이 있다. | 전역 provenance/no-fabrication과 Learning Fact→Spec 경계는 별도 DRIFTED 항목이다. |
| M3 실장비 read-only | HISTORICAL PASS / CURRENT BLOCKED | EPP 6.0.4, CC 3.0.98 read-only 및 IAG manual deep-config의 과거 증거가 기록됐다. | 현재 접근으로 재실증하거나 pilot maturity를 갱신하지 않았으므로 신규 증거는 `BLOCKED`/`NOT_RUN`이다. |
| M4 HCI 실장비 write | BLOCKED | read-only inventory까지는 증거가 있다. | cinder/volume service가 있는 SCP와 명시적 사람 승인 필요. 2xx가 아니라 read-back PASS가 완료 조건이다. |
| M5 field spec 심화 | IN_PROGRESS / NOT_RUN | 일부 EPP/CC/IAG spec과 version truth 자산은 있다. | 정확한 실장비 버전, page-verified source, field evidence로 60+ 확대·승격 필요. |
| M6 운영화·대체율 | NOT_RUN | health/report/competency 기반 구성요소는 존재한다. | 승인 유지형 주기 실행, 관측성, evidence-backed 대체율 자동 갱신의 운영 실증 필요. |
| M7 위임 확대 규칙 | GOVERNANCE | 빌드 마일스톤이 아니라 evidence에 따라 위임을 넓히는 반복 규칙이다. | M3~M6 증거 없이 권한을 자동 확대하지 않는다. |

### 4.2 보안·안전 8대 fail-closed 규칙

| # | 규칙 | 상태 | 회귀 기준 |
|---|---|---|---|
| 1 | HMAC 승인 서명과 action binding | PASS | 다른 action/target/revision의 서명을 재사용할 수 없다. |
| 2 | durable nonce 1회 소비 | PASS | 정상 사용 후 replay와 동시 이중 소비를 거부한다. 거부된 요청은 nonce를 먼저 태우지 않는다. |
| 3 | 비-loopback 원격 write 기본 차단 | PASS | signed approval이 있어도 explicit remote-write opt-in 없이는 거부한다. |
| 4 | navigate origin guard | PASS | 허용 origin 밖 이동과 모호한 UI target은 중단한다. |
| 5 | read-back oracle | PASS | HTTP 2xx는 성공이 아니며 read-back 불일치·미관측은 PASS가 아니다. |
| 6 | tool annotation·서비스 catalog fail-closed | PASS | annotation 또는 catalog identity가 없으면 read-only로 추측하지 않고 거부한다. |
| 7 | 감사 원장·artifact secret masking | PASS | credential/token/cookie/raw secret을 persistence 전에 masking한다. |
| 8 | provenance/no-fabrication | IN_PROGRESS | Learning eligibility 일부는 PASS지만 범용 evaluator에서 provenance 없는 bare value의 PASS를 전역 차단해야 한다. |

### 4.3 MCP 85-tool 전수 분류

분류 정본은 `apps/mcp-server/src/index.ts`의 `DESTRUCTIVE_TOOLS`, `WRITE_TOOLS`, `annotationsFor()`와 실제 `listTools()` 결과다. 현재 값은 **Destructive 7 + Write 37 + Read-only 41 = 85**다. 과거 `6/30/49` 집계와 점 표기(`sangfor.hci.apply_create_volume`)는 현재 코드와 맞지 않는다.

#### Destructive — 7

```text
sangfor.hci_delete_volume
sangfor.apply_approved_product_change
sangfor.execute_console_action
sangfor.execute_console_action_live
sangfor.apply_wiki_update
sangfor.apply_obsidian_wiki_update
sangfor.apply_github_wiki_update
```

#### Local-write/device-read — 37

```text
sangfor.hci_apply_create_volume
sangfor.generate_product_change_plan
sangfor.import_excel_requirement_list
sangfor.generate_excel_based_change_plan
sangfor.generate_setting_guide_docx
sangfor.generate_setting_guide_pptx
sangfor.generate_operations_guide_pptx
sangfor.generate_operations_guide_docx
sangfor.generate_comprehensive_setting_guide_docx
sangfor.generate_comprehensive_operations_guide_docx
sangfor.capture_screenshots
sangfor.generate_all_guides
sangfor.ingest_document
sangfor.learn_sources
sangfor.generate_config_plan
sangfor.request_approval
sangfor.start_operator_session
sangfor.kill_session
sangfor.generate_evidence_report
sangfor.submit_feedback
sangfor.extract_lesson
sangfor.propose_wiki_update
sangfor.approve_wiki_update
sangfor.create_eval_case_from_feedback
sangfor.create_finetune_dataset
sangfor.create_finetune_job_spec
sangfor.run_planner_eval
sangfor.pm_create_engagement
sangfor.pm_add_work_item
sangfor.pm_acquire_device
sangfor.pm_release_device
sangfor.attach_observation_session
sangfor.manage_learning_capture
sangfor.collect_facts
sangfor.research_learning_strategy
sangfor.validate_learning_strategy
sangfor.promote_learning_strategy
```

#### Read-only advisory — 41

```text
sangfor.products
sangfor.hci_inventory
sangfor.hci_health_report
sangfor.hci_plan_create_volume
sangfor.hci_verify_volume
sangfor.discover_product_console
sangfor.collect_product_config
sangfor.analyze_customer_requirements
sangfor.map_requirements_to_products
sangfor.dry_run_product_change
sangfor.verify_product_change
sangfor.search_manuals
sangfor.get_manual_section
sangfor.search_wiki
sangfor.rag_search
sangfor.rag_index_summary
sangfor.store_health
sangfor.analyze_project
sangfor.validate_config_plan
sangfor.read_console_state
sangfor.read_live_console_state
sangfor.verify_result
sangfor.validate_finetune_dataset
sangfor.evaluate_config
sangfor.list_spec_coverage
sangfor.advisor_fortios
sangfor.advisor_fortios_advanced
sangfor.advisor_cisco_iosxe
sangfor.advisor_cisco_iosxe_advanced
sangfor.collect_device_config
sangfor.capability_safety
sangfor.field_engineer_coverage
sangfor.suggest_rca
sangfor.recommend_sizing
sangfor.pm_status
sangfor.pm_events
sangfor.pm_report
sangfor.integration_guide
sangfor.check_version
sangfor.list_learning_strategies
sangfor.resolve_learning_strategy
```

`sangfor.kill_session`은 현재 device destructive가 아니라 local-write로 분류된다. 반대로 `sangfor.execute_console_action`, 두 외부 wiki apply tool이 destructive에 포함된다. 이름이나 분류가 바뀌면 annotation 테스트와 이 인벤토리를 같은 변경에서 갱신한다.

### 4.4 현재 아키텍처 토폴로지

- Apps: **5개** — `mcp-server`, `http-bridge`, `control-tower`, `operator-console`, `mock-sangfor-console`
- Packages: **35개** — 과거 34개 표기는 현재 디렉터리 수와 맞지 않는다.

```text
cisco-client, cisco-spec, fortios-client, fortios-spec,
sangfor-approval, sangfor-chrome, sangfor-collector, sangfor-competency,
sangfor-config-state, sangfor-evals, sangfor-evidence, sangfor-feedback,
sangfor-finetune, sangfor-hci-client, sangfor-integration, sangfor-knowledge,
sangfor-learning-strategy, sangfor-observer, sangfor-operator, sangfor-planner,
sangfor-pm, sangfor-pptx, sangfor-product-adapters, sangfor-rag, sangfor-rca,
sangfor-runs, sangfor-safety, sangfor-screenshot, sangfor-sizing, sangfor-spec,
sangfor-store, sangfor-verifier, sangfor-version, sangfor-wiki, shared
```

### 4.5 Learning Strategy와 품질 실측

- REQ-01~10, 15, 21~24는 구현/자동 검증 상태다.
- REQ-11~14, 16~17, 19는 실제 transport/composition 기준 `IN_PROGRESS`다.
- REQ-18과 REQ-20은 계획 계약과 실제 구현이 달라 `DRIFTED`다.
- REQ-25 honesty gate는 PASS지만 실제 pilot는 `BLOCKED`/`NOT_RUN`이다.
- 7단계 lifecycle, outbox/DLQ, `strategy`/`observe` CLI, MCP learning tools 8개는 구현돼 있다.

최신 전체 IAG remediation 검증 기록은 **97 files passed, 1 skipped; 664 tests passed, 2 skipped**, `pnpm run lint` PASS, `pnpm run build` PASS다. 제시된 `71 files / 432 tests`는 과거 수치이므로 현재 품질 기준으로 사용하지 않는다. 이 문서 보강은 문서-only 변경이라 전체 suite를 다시 실행하지 않았고, 아래 문서 검증만 새로 수행한다.

## 5. 자체 API 완료 정의

다음 셋은 자체 API 완료가 아니다.

- 내부 TypeScript `FactService`
- MCP tool `sangfor.collect_facts`
- 범용 proxy `POST /tools/call`

자체 API를 `DONE`으로 바꾸려면 아래를 모두 충족해야 한다.

- [ ] `/api/v1` 아래에 안정적인 resource route가 있다.
- [ ] OpenAPI 3.1 계약을 저장소가 소유하고, 실행 코드 또는 tool schema에서 재현 가능하게 생성한다.
- [ ] 공개 route는 기존 tool guard와 동일하거나 더 강한 인증·승인 정책을 통과한다. IAG 진단은 pure read-only, facts 수집은 local-write/device-read로 구분한다.
- [ ] OpenAPI request/response schema와 실제 handler가 drift하지 않는 자동 테스트가 있다.
- [ ] Fact query 결과는 `complete | partial | conflict | unavailable` 네 상태와 provenance를 보존한다.
- [ ] IAG diagnosis는 누락값을 `INDETERMINATE`로 유지하고 2xx 자체를 성공 판정으로 쓰지 않는다.
- [ ] write/active replay tool은 API allowlist에서 기본 제외하고, 별도 승인 정책 없이는 노출하지 않는다.
- [ ] credential, cookie, token, raw secret을 request log·report·runtime JSON에 저장하지 않는다.
- [ ] 기존 MCP 85-tool 계약과 CLI 동작이 회귀하지 않는다.

권장 최소 route:

| Method | Route | 역할 | 기본 정책 |
|---|---|---|---|
| `GET` | `/api/v1/openapi.json` | 현재 API 계약 제공 | `getOpenApiSpec`; bridge token 정책 적용 |
| `POST` | `/api/v1/facts/query` | product/version/fact query | `queryFacts`; local-write/device-read, signed approval 필수 |
| `POST` | `/api/v1/iag/diagnose` | sanitized IAG observation 평가 | `diagnoseIag`; pure read-only, 누락은 INDETERMINATE |

### 5.1 Canonical transport 계약

`POST /api/v1/facts/query`는 계획 §3.11의 `FactQueryRequest`와 `FactQueryResult`를 정본 DTO로 사용한다. 현재 코드의 `scope`, `context`, caller-supplied `methodResults` 형태를 공개 계약으로 승격하지 않는다.

요청 DTO:

```ts
interface FactQueryRequest {
  firmwareTruthId: string;
  registryDigest: string;
  environment: 'lab' | 'poc' | 'customer' | 'production';
  deviceScope: string;
  factIds: string[];
  capabilityIds?: string[];
  sessionHandle?: string;
  credentialRef?: string;
  evidencePolicy: 'standard' | 'audit';
  allowCanary?: boolean; // default false
}
```

- `methodResults`는 서버가 method driver에서 생성하며 client input에서 거부한다.
- `credentialRef`는 process-local lookup key만 허용한다. username/password/token/cookie/authorization과 raw credential 값은 schema와 handler 양쪽에서 거부한다.
- 응답은 `resolution`, `observations`, 5개 count의 `coverage`, `runRef`, `evidenceFiles`, optional `bundleRef`를 포함한다.
- observation은 `complete | partial | conflict | unavailable` 중 하나이며 eligibility, collectedAt, evidence file/digest, validation을 보존한다.
- `conflict`는 HTTP 오류가 아니라 `200` domain result다. 원문 후보값 대신 최소 2개의 keyed digest 후보를 반환한다.

facts transport envelope는 `{ request: FactQueryRequest, approval: SignedApproval }`로 고정한다. `SignedApproval`은 기존 bridge approval schema를 그대로 재사용하고 action을 `{type:'bridge.tool-call', target:'sangfor.collect_facts'}`에 bind한다. loopback에서도 approval을 필수로 하고, non-loopback은 `SANGFOR_ALLOW_REMOTE_WRITE=true` 없이는 추가로 거부한다. nonce는 모든 다른 검사가 끝난 뒤 1회 소비한다.

`POST /api/v1/iag/diagnose` 요청은 현재 strict parser의 `IagLiveObservation`을 정본으로 한다.

```ts
interface IagDiagnosisRequest {
  schemaVersion: 'iag-live-observation.v1';
  product: 'IAG';
  firmwareVersion: '13.0.120';
  observed: Partial<Record<
    'logRetentionDays' | 'webAuthEnabled' | 'credentialWebAuthEnabled' |
    'dot1xEnabled' | 'securityEventsCount' | 'haEnabled',
    number | boolean
  >>;
  observedAt: string;   // canonical ISO-8601
  evidenceSource: string; // trimmed printable ASCII, max 256
}
```

응답은 `{schemaVersion:'iag-diagnosis.v1', product, firmwareVersion, observedAt, summary, items, unobservedItems, report}`로 고정한다. 공급되지 않은 observed key는 만들지 않고 `unobservedItems`/`INDETERMINATE`로 남긴다. 이 route는 domain pure function만 호출하고 파일·세션·장비 상태를 쓰지 않는다.

공통 오류 envelope는 `{error:{code,message,requestId}}`다. `message`는 secret과 내부 경로를 masking한다.

| HTTP | 코드 | 의미 |
|---|---|---|
| `400` | `INVALID_INPUT` | JSON/schema/additional property/secret-like input 거부 |
| `401` | `AUTH_REQUIRED` | bridge token 누락·불일치 |
| `403` | `APPROVAL_REQUIRED` / `APPROVAL_REJECTED` / `REMOTE_WRITE_REFUSED` | facts route 승인·bind 정책 거부 |
| `422` | `IDENTITY_UNRESOLVED` / `SPEC_UNAVAILABLE` | exact registry/version/spec precondition 실패 |
| `503` | `TRANSPORT_UNAVAILABLE` | authorized observer/device transport 사용 불가 |
| `500` | `INTERNAL_ERROR` | masking된 예상 밖 오류 |

HTTP `2xx`는 transport 성공일 뿐이며 observation 또는 diagnosis의 PASS를 의미하지 않는다.

## 6. 개발 순서

각 단계는 앞 단계의 완료 조건을 충족한 뒤 시작한다. Critical safety boundary보다 API 노출을 먼저 만들지 않는다.

### Wave 0 — 현재 IAG 작업 마감과 기준점 교정

- [x] IAG 변경 파일만 review했다.
- [x] category anchor, Open Auth/credential 분리, retention local baseline 문구를 확인했다.
- [x] omitted fact가 PASS로 승격되지 않는 회귀 테스트를 유지했다.
- [x] focused test, full test, lint, build를 실행했다.
- [x] 사용자 요청에 따라 `3bc51d4`로 독립 커밋했다.
- [x] 진행 현황 문서에 `3bc51d4` 기준점을 추가했다.

완료 기준: IAG 변경이 별도 단위로 검증되고, learning observer 완료 주장과 혼합되지 않는다.

### Wave 1 — P0 Fact→Spec production safety boundary

- [ ] exact registry snapshot과 verified firmware truth를 입력으로 강제한다.
- [ ] eligible lifecycle과 complete provenance를 통과한 observation만 evaluator에 전달한다.
- [ ] product variant→Spec code/specVersion exact join 후 confined `loadSpec`을 호출한다.
- [ ] no-match, partial, conflict, unavailable, digest mismatch는 생략해 `INDETERMINATE`로 만든다.
- [ ] `productVariant`가 non-null인데 exact mapping이 없으면 fail-closed로 거부한다. `productVariant === null`인 경우에만 legitimate `defaultSpecMapping`을 유지한다.
- [ ] MCP/CLI/향후 REST가 같은 composition service를 사용하고 우회 경로가 없음을 테스트한다.
- [ ] 기존 config-state/advisor 결과가 불변임을 회귀 검증한다.

완료 기준: REQ-20/PR-002가 tests-only adapter가 아니라 실제 호출 경로에서 enforce된다.

### Wave 2 — P0 LM-08와 전역 no-fabrication gate

- [ ] LM-08에 shared HMAC approval primitive를 사용한다.
- [ ] typed action binding, expiry, nonce consume-once, replay rejection을 적용한다.
- [ ] unsigned·expired·replayed confirmation은 evidence eligibility에 들어가지 못하게 한다.
- [ ] provenance 없는 bare observed value가 `PASS`나 `field_verified`가 되지 못하게 한다.
- [ ] 기존 valid provenance 경로의 PASS는 유지한다.

완료 기준: REQ-18과 T-H5가 정상·위조·만료·재사용·동시성 테스트를 모두 통과한다.

### Wave 3 — Fact 실행 모델과 IAG domain core 추출

- [ ] `FactService`가 실제 method driver를 실행하고 네 상태를 모두 생성하도록 한다.
- [ ] stop condition, conflict cause, unavailable cause를 안전한 structured error로 반환한다.
- [ ] 현재 `scripts/iag-live-observation.ts`의 parser/evaluator core를 domain package로 이동한다.
- [ ] CLI는 domain core를 호출하는 thin adapter로 유지한다.
- [ ] report rendering과 API response가 같은 진단 결과 모델을 사용한다.

완료 기준: REQ-19가 synthetic fixture뿐 아니라 실제 domain composition에서 complete/partial/conflict/unavailable을 낸다.

### Wave 4 — 전용 REST와 OpenAPI 생성

- [ ] HTTP bridge의 기존 auth, loopback/token 정책, `authorizeToolCall`을 재사용한다.
- [ ] `/api/v1/openapi.json`, `/api/v1/facts/query`, `/api/v1/iag/diagnose`를 구현한다.
- [ ] OpenAPI 3.1 schema 생성기를 추가하고 stable operationId를 고정한다.
- [ ] IAG diagnose는 pure read-only handler만 허용한다. facts query는 `sangfor.collect_facts` local-write/device-read annotation과 signed approval을 강제하고 다른 write tool은 dedicated route에서 거부한다.
- [ ] malformed body, unknown product/version, missing provenance, auth failure를 fail-closed로 테스트한다.
- [ ] generated contract snapshot과 handler integration test를 추가한다.
- [ ] MCP 85-tool smoke와 generic `/tools/call` 회귀를 확인한다.

완료 기준: 사용자가 OpenAPI 문서를 받아 별도 클라이언트를 생성하고, 세 route를 실제 HTTP로 호출할 수 있다.

### Wave 5 — Learning method 실제 observer 연결

- [ ] LM-01 공식 same-origin GET/HEAD transport를 citation과 endpoint allowlist에 연결한다.
- [ ] LM-03 ExtJS store와 LM-04 DOM을 existing CDP observer session에 연결한다.
- [ ] LM-06 inbound stream의 bounded read-only source를 구현한다.
- [ ] LM-07 local OCR provider와 review-required boundary를 구현한다.
- [ ] synthetic 결과를 live evidence로 승격하지 않는 테스트를 유지한다.
- [ ] LM-02 active replay는 별도 사용자 승인과 공식 endpoint 계약 전까지 placeholder/blocked로 둔다.

완료 기준: REQ-11/13/14/16/17이 `SYNTHETIC_ONLY`가 아닌 authorized read-only fixture 또는 실제 observer E2E를 통과한다.

### Wave 6 — IAG 자동 수집과 수집 가이드

- [ ] manual sanitized JSON fallback을 유지한다.
- [ ] existing Chrome/CDP 세션에서 read-only DOM 값을 수집한다.
- [ ] 클릭, 저장, 설정 변경, credential 추출을 금지한다.
- [ ] provenance에 source selector/path, observedAt, product/version을 기록한다.
- [ ] INDETERMINATE 항목별 다음 수집 위치·방법·필요 권한을 생성한다.
- [ ] 관측 불가와 설정 미준수를 구분한다.

완료 기준: T-H3/T-H4가 실제 IAG 화면에서 read-only 수집 또는 정직한 collection guide로 종료된다.

### Wave 7 — 외부 pilot와 실장비 검증

- [ ] CC/IAG VPN 접근 probe를 실행한다.
- [ ] FortiOS 8.0 lab identity와 official endpoint를 확인한다.
- [ ] cinder-enabled SCP에서 read-back verified write를 승인 후 수행한다.
- [ ] 운영 CDP E2E에서 attach 대상, PID/page, storage/endpoint mutation 불변을 확인한다.
- [ ] PostgreSQL mirror pilot를 실행한다.
- [ ] evidence digest와 exact product/version identity를 pilot manifest에 기록한다.
- [ ] 접근 불가 시 `BLOCKED`, 실행 전이면 `NOT_RUN`; 근거 없는 PASS는 금지한다.

완료 기준: 각 pilot가 독립 증거와 함께 PASS/BLOCKED/NOT_RUN 중 하나로 정직하게 기록된다.

## 7. 파일 소유권 가이드

| Wave | 주 변경 범위 | 금지 또는 주의 |
|---|---|---|
| 0 | `scripts/iag-*`, IAG specs, diagnosis report, focused tests | learning observer 상태와 합쳐서 커밋하지 않는다. |
| 1 | `packages/sangfor-product-adapters`, config-state/spec composition, tests | `@sangfor/shared` 계약이나 기존 spec loader confinement를 약화하지 않는다. |
| 2 | learning strategy confirmation, approval primitive 사용부, evaluator gate | nonce/signature 검사를 테스트 편의로 우회하지 않는다. |
| 3 | learning `FactService`, IAG domain core, CLI adapter | domain logic을 HTTP/CLI에 중복 구현하지 않는다. |
| 4 | `apps/http-bridge`, OpenAPI module, HTTP integration tests | 기존 generic bridge guard를 복제·우회하지 않는다. |
| 5~6 | learning drivers, observer, IAG collector | active replay와 credential extraction을 read-only 수집에 섞지 않는다. |
| 7 | acceptance fixtures, runbook, evidence metadata | 실제 secret이나 raw customer data를 커밋하지 않는다. |

## 8. 단계별 검증 사다리

아래에 아직 없는 테스트 파일은 해당 Wave의 산출물로 먼저 추가한 뒤 실행한다. 모든 focused command의 기대 결과는 exit `0`, listed file 전부 PASS, changed-boundary skip `0`이다.

1. 아래 변경 경계 focused tests
2. `pnpm run lint`
3. `pnpm run build`
4. 영향받은 integration/E2E
5. 최종 배포·통합 시 전체 gate

### Wave별 focused 명령

Wave 0:

```bash
pnpm exec vitest run --config vitest.config.ts tests/iag-live-diagnosis.test.ts tests/spec-iag-seed.test.ts tests/spec-report.test.ts
```

Wave 1 (`tests/learning-spec-production-boundary.test.ts` 신규):

```bash
pnpm exec vitest run --config vitest.config.ts tests/learning-spec-adapter.test.ts tests/learning-spec-production-boundary.test.ts tests/spec-loader.test.ts tests/spec-report.test.ts
```

Wave 2 (`tests/no-fabrication-gate.test.ts` 신규):

```bash
pnpm exec vitest run --config vitest.config.ts tests/lm07-ocr.test.ts tests/approval-primitives.test.ts tests/no-fabrication-gate.test.ts
```

Wave 3 (`tests/learning-fact-service.test.ts`, `tests/iag-diagnosis-domain.test.ts` 신규):

```bash
pnpm exec vitest run --config vitest.config.ts tests/learning-fact-service.test.ts tests/iag-diagnosis-domain.test.ts tests/iag-live-diagnosis.test.ts
```

Wave 4 (`tests/http-bridge-api.test.ts`, `tests/http-bridge-openapi.test.ts` 신규):

```bash
pnpm exec vitest run --config vitest.config.ts tests/http-bridge-api.test.ts tests/http-bridge-openapi.test.ts tests/http-bridge-guard.test.ts tests/http-bridge-authorize.test.ts tests/http-bridge-approval-guard.test.ts
pnpm run smoke:mcp
```

Wave 5~6 (새 driver/collector 테스트를 명시된 이름으로 추가):

```bash
pnpm exec vitest run --config vitest.config.ts tests/lm01-fortios.test.ts tests/lm03-extjs.test.ts tests/lm05-import.test.ts tests/lm07-ocr.test.ts tests/observer-session.test.ts tests/iag-dom-collector.test.ts tests/collection-guide.test.ts
pnpm run test:observer:e2e
```

Wave 7은 외부 접속·실장비 write를 포함하므로 임의의 범용 shell command로 자동화하지 않는다. 아래 항목은 **MANUAL**이며 [운영 런북](../LEARNING_STRATEGY_OBSERVER_RUNBOOK.md)의 승인 창과 local evidence root 안에서만 수행한다.

| Pilot | 실행 계약 | 필수 evidence | 성공/차단 판정 |
|---|---|---|---|
| CC/IAG VPN | 승인된 운영자가 VPN 연결과 대상 reachability를 확인 | `<evidenceRoot>/cc-iag/access-probe.json`, observedAt, 대상 digest | 연결·권한 확인 시 다음 수집 진행; 부재는 `BLOCKED` + reason code |
| FortiOS 8.0 | 승인된 lab에서 exact product/version과 official endpoint를 read-only 확인 | `<evidenceRoot>/fortios/identity.json`, official citation, SHA-256 | exact 8.0 identity와 endpoint 일치 시 진행; 아니면 `BLOCKED` |
| cinder read-back write | action-bound single-use approval 후 create 1회와 read-back 1회 수행 | `<evidenceRoot>/cinder/approval-receipt.json`, request digest, before/after/read-back JSON | read-back PASS만 성공; 2xx-only/불일치/무승인은 `BLOCKED` 또는 실패 |
| 운영 CDP | existing Chrome 세션에 attach하고 passive capture invariants 확인 | encrypted bundle, page/PID, mutation deltas, capture summary | attach target exact, storage/endpoint mutation `0`, page/PID invariant true |
| PostgreSQL mirror | 승인된 mirror DB에서 additive write와 idempotent retry 확인 | `<evidenceRoot>/postgres/mirror-run.json`, row identity/count, retry/DLQ result | local canonical 불변과 idempotent mirror가 확인될 때만 PASS |

MANUAL 수행 후 자동 검증:

```bash
pnpm exec vitest run --config vitest.config.ts tests/learning-pilot-manifest.test.ts
pnpm run test:observer:e2e
```

기대 결과는 두 명령 exit `0`이다. 외부 의존성이 없을 때도 manifest가 근거 있는 `BLOCKED`/`NOT_RUN`을 기록하면 honesty gate는 PASS할 수 있지만 pilot 자체는 PASS가 아니다. 실제 pilot PASS에는 regular non-symlink evidence, confined path, SHA-256 일치, exact product/version identity가 모두 필요하다.

focused 결과에는 실행 명령, test file 수, passed/skipped test 수, exit code를 완료 체크포인트에 기록한다. 신규 파일을 아직 만들지 않은 Wave의 명령을 현재 실행하지 않는다.

### 최종 gate

```bash
pnpm test
pnpm run lint
pnpm run build
pnpm run test:observer:e2e
pnpm run smoke:mcp
```

API Wave 추가 기대 결과:

- [ ] token 실패 `401`, facts approval 실패 `403`, remote-write policy 실패 `403`, nonce replay 실패 `403`
- [ ] OpenAPI schema/handler drift test와 stable operationId 3개 검증
- [ ] `/api/v1/facts/query` complete/partial/conflict/unavailable test
- [ ] `/api/v1/iag/diagnose` PASS/MISSING/INDETERMINATE test
- [ ] secret masking 및 persistence negative test

## 9. 의사결정 및 외부 게이트

- [ ] LM-02 active replay를 열기 전 공식 endpoint, citation, action-bound approval 범위를 사용자가 승인한다.
- [ ] dedicated API 외부 bind를 열기 전 token/TLS/reverse-proxy 운영 정책을 확정한다. 기본값은 loopback fail-closed다.
- [ ] cinder write, VPN 연결, 실제 customer 장비 접근은 별도 실행 승인을 받는다.
- [ ] PostgreSQL을 source of truth로 승격하지 않는다. local-first canonical + optional mirror 원칙을 유지한다.

## 10. 즉시 실행 순서

1. **Wave 0:** 현재 IAG remediation 검증과 상태 문서 교정
2. **Wave 1:** REQ-20 Fact→Spec production safety boundary
3. **Wave 2:** REQ-18 HMAC/nonce 및 전역 no-fabrication gate
4. **Wave 3:** Fact method execution과 IAG domain core
5. **Wave 4:** 전용 REST/OpenAPI 생성
6. **Wave 5:** LM-01/03/04/06/07 실제 read-only observer 연결
7. **Wave 6:** IAG 자동 DOM 수집과 INDETERMINATE collection guide
8. **Wave 7:** 외부 pilot와 승인된 실장비 검증

API를 먼저 보여주는 것이 목표여도 Wave 1~2는 생략하지 않는다. 안전 경계가 없는 API는 기존 내부 결함을 더 넓게 노출할 뿐이다.

## 11. 검토 기록

- 2026-07-29: 전체 계획 문서 machine check를 수행했다. 대부분 `vague=0`, `incomplete=0`; hardening 문서의 vague 1건과 observer 계획의 오래된 PENDING 10건은 문서 drift로 분류했다.
- 2026-07-29: Luna inventory로 현재 정본, 레거시 참고, 완료 역사 문서를 분리했다.
- 2026-07-29: Terra repo-vs-plan audit에서 REQ-20, REQ-18, 실제 method transport, 전용 REST/OpenAPI 결손을 확인했다.
- 2026-07-29: IAG·MCP inventory focused gate는 `5 files, 20 tests passed`; lint/build PASS다. 직전 IAG remediation 전체 gate는 `97 files passed, 1 skipped; 664 tests passed, 2 skipped`다.

## 12. 완료 보고 체크리스트

- [ ] 변경 파일 목록을 기록했다.
- [ ] focused test 명령과 결과를 기록했다.
- [ ] lint/build 결과를 기록했다.
- [ ] 해당 Wave의 real-surface QA를 기록했다.
- [ ] 실행하지 않은 외부 검증을 명시했다.
- [ ] known limitation과 다음 Wave를 기록했다.
- [ ] 요청된 경우에만 commit/push/PR을 수행했다.
- [ ] worktree의 unrelated change를 보존했다.
