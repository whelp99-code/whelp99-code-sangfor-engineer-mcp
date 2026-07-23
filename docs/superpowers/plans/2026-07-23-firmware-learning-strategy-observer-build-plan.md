# 펌웨어 정밀 학습전략 DB 및 범용 콘솔 관측 플랫폼 구축계획서

- **Status:** Active
- **작성일:** 2026-07-23
- **Owner:** Codex / Repository Maintainer
- **Related:** `ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`, `docs/MULTIVENDOR.md`, `docs/PRODUCT-SENSE.md`

## 1. 목표와 구축 범위

### 목표

제품·정확한 펌웨어·UI/API fingerprint별로 검증된 수집 전략을 선택하고, 이미 로그인된 콘솔 세션에서 read-only 사실을 수집하여 기존 Spec 평가로 전달하는 플랫폼을 구축한다.

완료 결과는 다음과 같다.

- M01~M08 수집 방법과 R01~R04 연구 방법을 공통 플랫폼으로 제공한다.
- 로컬 파일 DB를 정본으로 사용하고 PostgreSQL은 선택적 통계·검색 미러로 사용한다.
- MCP 도구 8개와 CLI 2개를 제공한다.
- CC 3.0.98C와 IAG 13.0.120은 현장 검증, FortiOS 8.0.0은 실제 랩 검증을 수행한다.
- exact match와 검증된 observation만 Spec에 전달하며 나머지는 `INDETERMINATE`로 유지한다.
- 장비 설정 변경, 로그인 자동화, 자격증명 저장은 수행하지 않는다.

### 규모 및 현재 기준선

- 판정: **Tier XL**
- 근거: MUST 25개, 예상 변경 85~105개 파일, Prisma migration 1개, 원시 관측·실장비 세션을 다루는 R4 내재 위험
- 현재 검증:
  - `pnpm test`: 432 passed, 2 skipped
  - `pnpm run lint`: PASS
  - `pnpm run build`: PASS
  - `pnpm run smoke:mcp`: PASS, 현재 77 tools
- 현재 브랜치는 `main`보다 1커밋 뒤에 있고 사용자 소유 PPTX와 실장비 출력이 변경된 상태다. 구현은 최신 `main` 기반 별도 worktree와 `codex/learning-strategy-observer-v1` 브랜치에서 수행하며 기존 변경을 stash·삭제·복사하지 않는다.

### 범위 밖

- 장비 설정 쓰기·자동 rollback·브라우저 클릭·로그인 자동화
- Operator Console 또는 Control Tower UI
- arbitrary web crawler와 MCP 내부 인터넷 검색
- cloud OCR/vision, 임의 JS·shell·`page.evaluate` recipe
- M05 Export 버튼 클릭 또는 다운로드 자동 실행
- 전체 제품과 ITAC 100개 항목의 현장 검증
- 자동 `field_verified` 승격
- 중앙 DB에 캡처 payload, 쿠키, 토큰, IP, serial, 고객 식별자 저장
- 별도 승인 없는 GitHub push·PR·merge·운영 배포

## 2. 목표 아키텍처와 고정 계약

### 계층 구조

1. L1 `@sangfor/learning-strategy`
   - 전용 vendor/product registry, exact firmware identity, method DSL, Fact 계약, 파일 DB, lifecycle, HMAC approval, resolver를 소유한다.
   - 기존 unknown→HCI normalizer와 Product Adapter를 import하지 않는다.
2. L2 `@sangfor/observer`
   - Playwright의 existing-CDP 연결, read-only facade, 캡처·암호화, M01~M08 driver를 구현한다.
   - 기존 operator session 또는 CAPTCHA OCR helper를 재사용하지 않는다.
3. L3 Product Adapter/App
   - observer 결과를 기존 Spec 입력으로 변환한다.
   - resolver miss 시 기존 정적 `api-first/webui-first/hybrid` 정보를 `unverified_hint`, `nonEligible`로만 반환한다.
4. Persistence Adapter
   - 로컬 outbox를 PostgreSQL에 at-least-once로 미러링한다.
   - DB 장애가 정본 로컬 transaction을 실패시키지 않는다.

### 제품·펌웨어 identity

```ts
type VendorCode = 'SANGFOR' | 'FORTINET' | 'CISCO';
type CanonicalProductCode =
  | 'EPP' | 'IAG' | 'CC' | 'HCI_SCP' | 'NDR'
  | 'FORTIOS' | 'IOSXE';

interface FirmwareIdentity {
  vendor: VendorCode;
  product: CanonicalProductCode;
  versionRaw: string;
  versionFamily: string;
  revision: string | null;
  buildId: string | null;
  hotfix: string | null;
  uiFingerprint: string | null;
  apiFingerprint: string | null;
}
```

- 알 수 없거나 `CC`/`NDR`처럼 모호한 alias는 `UNSUPPORTED_PRODUCT` 또는 `AMBIGUOUS_PRODUCT`로 거부한다.
- `3.0.98C`와 `3.0.98E`, build·hotfix 차이는 서로 다른 identity다.
- 기존 숫자 기반 `compareVersions`는 upgrade advisory용으로 유지하고 exact resolver에는 사용하지 않는다.
- fingerprint는 canonical JSON으로 정규화한 안정적 descriptor만 SHA-256 처리한다.
  - 포함: raw build ID, asset manifest ID, framework/version, 정규화 route signature, API schema signature
  - 제외: hostname, IP, origin, serial, license, 사용자·고객값, DOM text/value, 시간, counter, token
- Strategy는 `supportedFingerprints[]` allowlist를 소유하며 필요한 UI/API fingerprint가 하나라도 일치하지 않으면 자동 사용하지 않는다.

### Strategy와 lifecycle

- `StrategyRevision` payload는 생성 후 불변이다.
- 상태는 append-only `LifecycleEvent`를 fold하여 계산한다.
- 상태 전이:

| 현재 | 다음 | 필수 증적 |
|---|---|---|
| `draft` | `researched` | R01~R04 중 유효 evidence와 사람 HMAC |
| `researched` | `lab_verified` | 실제 랩 target의 exact 검증과 사람 HMAC |
| `lab_verified` | `device_verified` | exact 물리/가상 장비 1대 검증과 사람 HMAC |
| `device_verified` | `field_verified` | 현장 성공 1회, 필수 fact 완전성, 사람 HMAC |
| 활성 상태 | `stale` | HMAC 또는 검증된 integrity/mutation safety event |
| 모든 비종료 상태 | `deprecated` | 사람 HMAC |
| `stale` | `deprecated` | 사람 HMAC |

- `stale` revision은 복구하지 않고 `derivedFromRevisionId`를 가진 새 `draft`를 만든다.
- `deprecated`는 종료 상태다.
- 일반 fingerprint mismatch, no-match, incomplete 결과는 revision을 자동 stale 처리하지 않는다. `stale_candidate` evidence만 남긴다.
- exact safety invariant 위반이나 mutation signal은 즉시 noneligible 처리하고, event store가 정상일 때만 system stale event를 기록한다.

환경별 사용 조건:

| 상태 | 사용 가능 범위 |
|---|---|
| `draft` | 사용 불가 |
| `researched` | canary·설명만, Spec 입력 불가 |
| `lab_verified` | exact `lab`만 |
| `device_verified` | 검증된 opaque UUIDv7 `deviceScope`의 `lab/poc/customer`, production 제외 |
| `field_verified` | exact `lab/poc/customer/production` |
| `stale/deprecated` | 사용 불가 |

승격 서명은 `SANGFOR_LEARNING_APPROVAL_SECRET`의 base64 32-byte key를 사용한다. canonical payload는 domain, entity, revision ID, content hash, from/to, evidence digest, nonce, expiry를 포함한다. `timingSafeEqual`, durable single-use nonce, expiry, cross-transition replay 거부를 적용한다. 서명 생성은 MANUAL CLI만 제공하며 MCP는 검증만 한다.

### Resolver와 method chain

- 합성 순서는 `product/firmware default → capability override → fact override`다.
- overlay 규칙:
  - omitted: 상위 값 상속
  - array: 전체 교체
  - `null`: nullable로 선언된 필드만 허용
  - overlay 후 전체 strict schema 재검증
- 같은 scope에 active revision이 둘 이상이면 tie-break하지 않고 `AMBIGUOUS_STRATEGY`로 거부한다.
- near-version은 candidate만 반환하며 observation·Spec 평가에는 절대 들어가지 않는다.
- fact별 ordered method chain을 사용한다.
  - `not_applicable`, `not_observed`: 다음 method 진행
  - `complete`: 종료
  - `partial`: 해당 fact를 partial로 종료
  - `blocked`, `integrity_error`, `mutation_signal`: 전체 run 중단
- 둘 이상의 complete observation 값이 다르면 precedence로 덮지 않고 `conflict`로 반환한다. signed M08 확인 전까지 Spec 입력을 금지한다.
- `complete`는 required path·cardinality 충족, truncation 없음, parse warning 없음으로 정의한다.

### M01~M08 strict declarative DSL

Recipe에는 임의 코드, 함수명, regex, shell, URL host, header value를 넣을 수 없다. 중앙 interpreter만 좁은 `ReadOnlyFacade`를 받으며 raw Playwright `Page`/`Context`는 driver에 노출하지 않는다.

| 코드 | v1 동작과 금지 |
|---|---|
| M01 | official citation이 있는 same-origin GET/HEAD와 제한된 JSON key path만 허용 |
| M02 | exact+promoted recipe의 GET/HEAD 및 명시적 read-only POST template만 replay; PUT/PATCH/DELETE, 임의 body/header, retry 금지 |
| M03 | 이미 로드된 ExtJS store의 allowlisted `storeId`·field만 읽음; load/sync/call 금지 |
| M04 | allowlisted DOM/ARIA selector·attribute만 읽음; click/focus/scroll/value mutation 금지 |
| M05 | 사람이 미리 저장한 JSON/CSV만 allowlisted import root에서 streaming parse; symlink/path traversal 금지 |
| M06 | 이미 존재하는 WS/SSE의 inbound frame listener만 사용; send/new WebSocket/new EventSource 금지 |
| M07 | local-only OCR provider, recipe ROI와 고정 type parser만 사용; pixel·원문 OCR text 저장 및 단독 자동 PASS 금지 |
| M08 | typed observation digest에 대한 reviewer·identity·nonce·expiry 서명만 허용; forged boolean과 free-form secret 금지 |

M05 한도는 파일 50MiB, 100,000 rows, 256 fields/row, 문자열 64KiB, parse timeout 30초다.

### 브라우저·캡처 보안

- CDP endpoint는 `localhost`, `127.0.0.0/8`, `::1`만 허용한다.
- target origin과 일치하는 열린 page가 정확히 1개일 때만 attach한다.
- `newPage`, `newContext`, `goto`, login, page close를 금지한다.
- attach 전후 page count, URL, 외부 Chrome 생존 여부가 동일해야 한다.
- 모든 MCP 입력은 strict Zod와 `additionalProperties:false`를 적용하고 username/password/token/cookie/authorization 필드를 handler에서도 거부한다.
- 자격증명은 사전 설정된 process-local `credentialRef`로만 조회하고 contract·로그·파일에 포함하지 않는다.

산출물 명칭은 `sanitized encrypted capture bundle`로 고정한다.

- recipe allowlist에 포함된 response path·column·frame 값만 저장한다.
- unknown payload는 값이나 raw hash가 아니라 secret hard-deny 후의 sanitized structural skeleton만 keyed digest 처리한다.
- Authorization, Cookie, Set-Cookie, token, password, secret 계열은 recipe가 요청해도 폐기한다.
- 최초 연구 캡처는 구조만 저장하고, draft allowlist 작성 후 재캡처해야 값이 저장된다.
- 구조적 최소화 후 AES-256-GCM 암호화를 수행한다. plaintext 임시 파일은 만들지 않는다.
- keyring:
  - `SANGFOR_CAPTURE_BUNDLE_KEYS='{"key-id":"<base64-32-byte>"}'`
  - `SANGFOR_CAPTURE_BUNDLE_ACTIVE_KEY_ID='<key-id>'`
- bundle metadata에는 key ID, 96-bit nonce, tag, AAD digest, schema version, 생성·만료일, ciphertext digest만 둔다.
- 기본 보존 기간 30일, 기본 bundle 상한 100MiB, item 상한 2MiB, event 상한 10,000개다.
- runtime directory는 `0700`, 파일은 `0600`으로 생성한다.
- 삭제는 `observe purge`의 dry-run이 기본이며 `--execute --before <ISO>`와 검증된 exact root가 모두 있어야 한다. MCP 삭제 도구는 제공하지 않는다.

### 파일 DB와 PostgreSQL 미러

로컬 정본:

- seed/catalog: `data/learning-strategies/`
- mutable DB: `data/runtime/learning-strategies/`
- capture: `data/runtime/learning-captures/`
- immutable revision, lifecycle event, evidence, run, mirror outbox와 generation manifest로 구성
- cross-process exclusive lock, schema version, generation CAS, content hash 검증
- temp fsync → rename → directory fsync 순서
- corrupt file, lock timeout, generation conflict는 fail-closed
- repair는 immutable record를 검증한 뒤 MANUAL `strategy audit --repair`로만 수행

PostgreSQL mirror 모델:

- `LearningMethodCatalog`
- `LearningFirmwareProfile`
- `LearningStrategyRevision`
- `LearningLifecycleEvent`
- `LearningEvidence`
- `LearningRun`
- `LearningMirrorReceipt`

Migration은 additive 1개다. DB에는 sanitized metadata, coverage, latency, status, method code, content/evidence digest만 저장한다. deviceScope는 caller가 제공한 non-PII UUIDv7의 digest만 저장하고 bundle path·payload는 저장하지 않는다.

로컬 transaction과 outbox 생성은 같은 lock/generation commit에서 수행한다. Mirror는 event ID unique upsert, 최대 10회 exponential retry, 이후 DLQ로 이동한다. DB 장애 시 일반 로컬 명령은 `mirrorStatus: pending`으로 성공하며 명시적 `mirror-sync`만 실패 exit code를 반환한다.

### Fact API

```ts
interface FactQueryRequest {
  identity: FirmwareIdentity;
  environment: 'lab' | 'poc' | 'customer' | 'production';
  deviceScope: string;             // opaque UUIDv7
  factIds: string[];
  capabilityIds?: string[];
  sessionHandle?: string;
  credentialRef?: string;
  evidencePolicy: 'standard' | 'audit';
  allowCanary?: boolean;           // default false; true여도 noneligible
}

interface FactObservation {
  factId: string;
  value?: unknown;
  status: 'complete' | 'partial' | 'conflict' | 'unavailable';
  methodCode: `M0${1|2|3|4|5|6|7|8}`;
  recipeRevisionId: string;
  eligibility: 'eligible' | 'human_review_required' | 'ineligible';
  collectedAt: string;
  evidenceRefs: string[];
  validation: string[];
}

interface FactQueryResult {
  resolution:
    | 'exact' | 'canary_required' | 'research_required'
    | 'blocked' | 'ambiguous';
  observations: FactObservation[];
  coverage: {
    requested: number;
    complete: number;
    partial: number;
    conflict: number;
    unavailable: number;
  };
  runRef: string;
  evidenceRefs: string[];
  bundleRef?: string;
}
```

Spec adapter는 exact identity, eligible lifecycle, complete, provenance, method eligibility를 모두 만족한 observation만 기존 observed map에 넣는다. M07 단독 결과, unsigned M08, partial/conflict/unavailable는 key 자체를 생략하여 기존 evaluator가 `INDETERMINATE`를 반환하게 한다.

### MCP 8개와 CLI 2개

| MCP 도구 | 핵심 계약 | Annotation |
|---|---|---|
| `sangfor.list_learning_strategies` | ID/vendor/product/version/status filter와 cursor pagination | readOnly |
| `sangfor.resolve_learning_strategy` | exact resolution, selected revision, canary candidate와 miss reason | readOnly |
| `sangfor.attach_observation_session` | loopback CDP와 exact 1-page attach, ephemeral handle 반환 | local write |
| `sangfor.manage_learning_capture` | `start/stop`, capture ID와 encrypted bundle summary 반환 | local write |
| `sangfor.collect_facts` | `FactQueryRequest → FactQueryResult` | local write/device read |
| `sangfor.research_learning_strategy` | supplied official citation·capture evidence로 draft와 benchmark 생성 | local write |
| `sangfor.validate_learning_strategy` | evidence 검증과 eligible next-state 반환, 승격은 하지 않음 | local write |
| `sangfor.promote_learning_strategy` | immutable revision과 signed lifecycle event 승격 | local write |

list/resolve를 제외한 6개를 `WRITE_TOOLS`에 등록한다. 8개 모두 `destructiveHint:false`이며 실제 device-write tool로 분류하지 않는다.

CLI:

- `pnpm strategy -- list|resolve|research|validate|approval-payload|approval-sign|promote|audit|mirror-sync`
- `pnpm observe -- capture|collect|purge`

`approval-sign`은 secret을 argv·stdout·로그에 노출하지 않고 secure input 또는 env에서 읽어 mode `0600` approval 파일만 만든다. Exit code는 `0 성공`, `2 입력 오류`, `3 precondition/resolution`, `4 보안·승인`, `5 store/mirror`, `6 capture/transport`, `7 partial/conflict/unavailable`로 고정한다.

## 3. MUST 요구사항과 인수 기준

| REQ | P | 정상 인수 | 실패 인수 |
|---|---:|---|---|
| REQ-01 Product registry | P0 | 명시된 vendor/product가 canonical code로 결정됨 | unknown·모호 alias는 HCI fallback 없이 거부 |
| REQ-02 Exact identity | P0 | raw version·build·fingerprint 모두 같은 profile만 exact | `3.0.98C/E`, missing/drift는 canary/no-match |
| REQ-03 Catalog/DSL | P0 | M01~M08, R01~R04 recipe가 strict parse됨 | 코드·shell·host·unknown key는 거부 |
| REQ-04 Local store | P0 | concurrent writer 후 generation과 모든 record가 보존됨 | lock/CAS/corrupt 오류 시 write·resolve 모두 중단 |
| REQ-05 Revision/lifecycle | P0 | immutable revision과 event fold가 허용 상태를 산출 | 역전·skip·reactivation은 거부 |
| REQ-06 Approval | P0 | action-bound 유효 HMAC가 event 1회를 생성 | wrong domain·expired·replay nonce는 상태 불변 |
| REQ-07 Resolver | P0 | default→capability→fact overlay가 deterministic | same-scope 중복과 invalid merged DSL은 ambiguous |
| REQ-08 Existing session | P0 | 열린 exact page 1개에만 attach하고 detach 후 browser 유지 | remote CDP·0/2+ page·credential field는 거부 |
| REQ-09 Passive capture | P0 | XHR/fetch, DOM/ARIA, iframe/shadow, inbound stream 구조 수집 | unknown value, oversized item, unsafe action은 미저장 |
| REQ-10 Encryption/retention | P0 | 최소화된 bundle만 AES-GCM으로 저장되고 30일 만료됨 | missing key·bad tag·redaction failure 시 파일 미생성 |
| REQ-11 M01 | P1 | official same-origin GET/HEAD가 eligible fact를 생성 | citation/endpoint/credential 부재 시 unavailable |
| REQ-12 M02 | P0 | promoted exact read-only request만 1회 replay | 미등록 POST와 모든 PUT/PATCH/DELETE 차단 |
| REQ-13 M03 | P1 | loaded ExtJS store의 allowlisted field만 추출 | store 없음·load/sync 시도는 unavailable/blocked |
| REQ-14 M04 | P1 | unique selector의 허용 DOM/ARIA 값만 추출 | duplicate/hidden credential/mutation action 차단 |
| REQ-15 M05 | P1 | root 내 bounded JSON/CSV를 streaming parse | symlink·traversal·확장자·크기·timeout 위반 거부 |
| REQ-16 M06 | P1 | 기존 inbound WS/SSE frame의 허용 field만 추출 | send/create 시도 또는 malformed frame은 중단 |
| REQ-17 M07 | P1 | local ROI OCR가 typed, review-required 결과 생성 | provider 없음 또는 OCR-only 결과는 Spec 비적격 |
| REQ-18 M08 | P0 | signed typed human confirmation이 observation을 확정 | unsigned·replayed·expired confirmation은 비적격 |
| REQ-19 Fact API | P0 | 모든 요청 fact가 네 상태 중 하나로 반환됨 | method stop condition과 원인이 안전한 오류로 반환 |
| REQ-20 Spec gate | P0 | exact+eligible+complete만 기존 evaluator에 전달 | 나머지는 key 생략 및 `INDETERMINATE` |
| REQ-21 Research | P1 | R01~R04가 draft·benchmark·evidence gap을 생성 | official source 없는 후보는 승격 불가 |
| REQ-22 DB mirror | P1 | local event가 idempotent하게 PostgreSQL에 반영 | DB 장애 시 local 성공·outbox pending·explicit sync 실패 |
| REQ-23 MCP surface | P1 | 정확히 8개 신규 이름·schema·annotation 등록 | extra property와 secret field는 handler에서 거부 |
| REQ-24 CLI surface | P1 | 두 CLI의 명령·exit code·dry-run 계약 준수 | secret argv, implicit purge, ambiguous exit 금지 |
| REQ-25 Pilot gates | P0 | CC/IAG field, FortiOS actual lab evidence가 목표 maturity 도달 | 접근·증적 부재는 PASS가 아니라 `NOT_RUN/BLOCKED` |

## 4. 구현 순서와 검증

### PR 그래프

모든 PR은 기본적으로 순차 실행한다. 공통 Change Budget은 직접 수정 ≤12파일, 신규 ≤8파일, production 논리 ≤500줄, migration ≤1개다. 초과 시 구현 전에 PR을 분할한다.

| PR | 수직 결과 | 분해 상태 |
|---|---|---|
| PR-001 | exact identity, DSL, store, lifecycle, HMAC, resolver의 security-first foundation | DETAIL 확정 |
| PR-002 | draft→signed researched→exact resolve→fixture observation→Spec INDETERMINATE, 이어 lab fixture→PASS 경계 | SUB 확정 |
| PR-003 | M01 FortiOS synthetic fixture와 direct read-only facade | `DECOMPOSITION: PENDING — PR-002 실제 계약명 확인 후` |
| PR-004 | existing-CDP session, passive structural capture, encrypted bundle | `DECOMPOSITION: PENDING — PR-003 facade 확정 후` |
| PR-005 | M02와 CC 3.0.98C synthetic recipe | `DECOMPOSITION: PENDING — capture 계약 확정 후` |
| PR-006 | M03/M04와 IAG 13.0.120 fixtures | `DECOMPOSITION: PENDING — R03 framework adapter 경계 확인 후` |
| PR-007 | M05 JSON/CSV와 M06 inbound stream | `DECOMPOSITION: PENDING — common method harness 확정 후` |
| PR-008 | M07 local ROI와 M08 signed confirmation | `DECOMPOSITION: PENDING — evidence eligibility 계약 확정 후` |
| PR-009 | R01~R04 research, benchmark, stale-candidate workflow | `DECOMPOSITION: PENDING — 8개 method 결과 모델 고정 후` |
| PR-010 | Prisma additive migration과 local outbox mirror | `DECOMPOSITION: PENDING — canonical schema 고정 후` |
| PR-011 | MCP 8개, CLI 2개, Product Adapter fallback integration | `DECOMPOSITION: PENDING — 모든 domain service 완료 후` |
| PR-012 | mock/e2e/security hardening, runbook, autonomous acceptance | `DECOMPOSITION: PENDING — 최종 surface 고정 후` |

### PR-001 상세

대상:

- CREATE: `/Users/jmpark/Playground/whelp99-code-sangfor-engineer-mcp/packages/sangfor-learning-strategy/package.json`
- CREATE: 같은 package의 `src/contracts.ts`, `src/store.ts`, `src/resolver.ts`, `src/index.ts`
- MODIFY: `/Users/jmpark/Playground/whelp99-code-sangfor-engineer-mcp/packages/sangfor-version/src/index.ts`
- MODIFY: `/Users/jmpark/Playground/whelp99-code-sangfor-engineer-mcp/tsconfig.json`
- CREATE: `tests/learning-contracts.test.ts`, `tests/learning-store.test.ts`, `tests/learning-resolver.test.ts`
- FORBIDDEN: shared product normalizer, Product Adapter, operator, chrome OCR, execution approval gate 변경

SUB:

1. PR-001-SUB-001 — product/identity/fingerprint
   - `parseFirmwareIdentity`, `sameFirmwareIdentity`, `canonicalizeFingerprintDescriptors`
   - C/E/build/hotfix 분리와 PII descriptor 거부 테스트
2. PR-001-SUB-002 — strict 계약과 recipe DSL
   - 25개 requirement에 필요한 Zod schema, Fact 계약, 8개 MCP input/output schema
   - 모든 schema `.strict()`, overlay 후 재검증
3. PR-001-SUB-003 — store/lifecycle/approval/resolver
   - atomic commit, lock/CAS/fsync, immutable revision, lifecycle fold
   - HMAC canonical payload, nonce replay 방지, environment eligibility
4. PR-001-SUB-004 — fail-closed 테스트와 exports
   - corrupt generation, concurrent child process, invalid transition, ambiguous scope, near-version 배제

검증:

```bash
pnpm exec vitest run --config vitest.config.ts tests/learning-contracts.test.ts tests/learning-store.test.ts tests/learning-resolver.test.ts
pnpm run lint
pnpm run build
pnpm test
```

모든 명령 exit code 0, 기존 `compareVersions` 테스트 불변, 저장소 사용자 변경 미접촉이 완료 조건이다.

PR-001 실행 프롬프트:

```text
TASK: PR-001 — learning-strategy security-first domain foundation
DELIVERABLE: exact identity, strict declarative DSL, atomic canonical store, immutable lifecycle, HMAC approval, deterministic resolver와 focused tests
SCOPE: 지정 package/version/tsconfig/tests만 변경; shared normalizer, operator, chrome, product-adapters 금지
VERIFY: focused vitest → lint → build → full test, 모두 exit 0
```

### PR-002 SUB

1. eligibility adapter가 `FactQueryResult`에서 exact+complete+eligible만 observed map으로 변환한다.
2. `researched` fixture는 resolve되어도 Spec `INDETERMINATE`를 만든다.
3. signed `lab_verified` fixture는 동일 fact를 Spec PASS 경계까지 전달한다.
4. partial/conflict/M07-only/unsigned-M08/near-version regression을 추가한다.

PR-003~012의 dispatch prompt는 각 PR 시작 직전에 위 표의 결과·선행 계약·Change Budget·검증 명령을 포함해 생성하며, 앞선 PR에서 확정된 실제 symbol과 파일 경로를 읽어 SUB/DETAIL을 결정한다.

### 자동 검증

- Unit:
  - identity C/E/build/hotfix, registry ambiguity, overlay, lifecycle, HMAC replay
  - 모든 M01~M08 fixture와 실패 경로
  - redaction·AES-GCM known vector·wrong key/tag
  - streaming parser 한도와 timeout
- Integration:
  - multi-process lock/CAS와 corrupt recovery
  - method chain·conflict·M08 adjudication
  - mirror idempotency·retry·DLQ
  - Fact→Spec PASS/INDETERMINATE 경계
- Browser E2E:
  - 외부 Chromium/CDP page count·URL·생존 불변
  - 0/2+ page, remote CDP, origin mismatch 거부
  - mock write endpoint 호출 수 0
  - M02 allowlisted POST만 1회, M03/M04/M06 금지행위 0
- MCP/CLI:
  - 현재 baseline `N`에 정확히 8개 신규 도구 등록
  - 현재 상태가 유지되면 77→85개
  - exact tool name·schema·annotation registration test를 별도로 추가
  - 모든 CLI exit code와 purge dry-run 테스트
- Full gate:

```bash
pnpm test
pnpm run lint
pnpm run build
pnpm run smoke:mcp
```

### MANUAL 실증

1. CC
   - fresh version을 다시 읽고 정확히 `3.0.98C`인지 확인
   - 기존 `3.0.98` spec/recipe를 exact evidence로 재사용하지 않음
   - 사람이 로그인·콘솔 조작하고 agent는 passive capture 및 승격 recipe read만 수행
   - 현재 CC keymap의 모든 fact를 pilot manifest로 고정
   - 성공 1회와 사람 HMAC 후 `field_verified`
2. IAG
   - `13.0.120`과 fingerprint 재확인
   - R03으로 실제 framework를 확인하며 ExtJS를 사전 가정하지 않음
   - 현재 IAG 13.0.120 spec의 모든 observed key를 pilot manifest로 고정
   - 성공 1회와 사람 HMAC 후 `field_verified`
3. FortiOS
   - 현재 7.2.0 mock과 부적합 8.0 seed를 실제 증적으로 사용하지 않음
   - official FortiOS 8.0 source와 실제 8.0 lab VM/appliance의 M01 결과 필요
   - 현재 FortiOS 8.0 baseline의 observed key를 pilot manifest로 고정
   - actual lab evidence와 사람 HMAC 후 `lab_verified`

VPN, 장비, CDP, key, 실제 PostgreSQL이 없으면 해당 단계는 `NOT_RUN/BLOCKED`로 기록한다. 이는 CI 실패나 PASS로 변환하지 않는다.

## 5. 위험, 조정 지점 및 완료 판정

### 주요 위험

| 위험 | 점수 | 예방 | 복구 |
|---|---:|---|---|
| secret/PII 캡처 | 4×5×4=80, R4 | allowlist 최소화, hard-deny, local encryption, canary leak test | bundle purge, key rotation, incident record |
| M02가 장비를 변경 | 3×5×4=60, R3 | promoted exact recipe, read-only facade, mutation detector | 즉시 중단·stale 처리, 자동 rollback 금지 |
| 잘못된 identity로 false PASS | 3×5×4=60, R3 | exact raw version/build/fingerprint, near noneligible | observation 폐기, 새 revision 작성 |
| approval replay/위조 | 2×5×4=40, R3 | domain-separated HMAC, durable nonce, expiry | secret rotation, event audit |
| concurrent store 손상 | 3×4×3=36, R3 | lock/CAS/fsync/content hash | fail-closed, immutable record 기반 repair |
| OCR/human 결과의 false PASS | 3×5×4=60, R3 | M07 단독 비적격, signed M08 | fact를 conflict/INDETERMINATE로 재평가 |
| 외부 browser 간섭 | 2×4×4=32, R2 | existing-page-only와 before/after invariant | detach, session invalidation |
| DB mirror divergence | 3×3×3=27, R2 | outbox, idempotent receipt, DLQ | explicit mirror-sync 및 audit |

### 알려진 조정 지점

- 구현 시작 시 최신 `main`의 tool 수와 baseline을 다시 측정하고 `N+8`로 검증한다.
- `@sangfor/spec`의 실제 package manifest 이름은 코드 import 명칭과 다를 수 있으므로 manifest를 읽고 실제 이름에 맞춘다.
- 기존 `packages/sangfor-store`에는 `package.json`이 없으므로 persistence package로 오인하지 않는다.
- CC 3.0.98C, IAG 13.0.120, FortiOS 8.0.0은 실증 직전에 장비에서 다시 확인한다.
- IAG framework는 현재 미확인이다. R03 결과로 adapter를 선택한다.
- Playwright의 설치 해석 버전과 Prisma migration timestamp는 implementation 시 실제 lockfile·CLI 결과를 사용한다.
- 실제 코드가 계획의 symbol·경로와 다르면 먼저 grep/read로 현재 구조를 확인해 호환 조정하고 결과 보고에 기록한다. 보안·범위가 달라지는 경우에만 중단한다.

### 완료 판정

다음 조건을 모두 만족해야 구축 완료다.

- 25개 MUST의 정상·실패 인수 테스트가 통과한다.
- 전체 test/lint/build/smoke가 통과하고 기존 skip 수가 늘지 않는다.
- 신규 MCP 도구가 정확히 8개이며 이름·schema·annotation이 계약과 일치한다.
- secret canary가 로그, 파일 DB, decrypted test bundle, DB mirror 어디에도 남지 않는다.
- browser E2E에서 page count·URL·browser 생존이 불변이고 mock device write 수가 0이다.
- local canonical store가 DB 장애와 concurrent writer 상황에서도 보존된다.
- CC/IAG는 `field_verified`, FortiOS는 actual-lab `lab_verified` evidence를 갖는다. 미실행이면 전체 결과를 “코드 구축 완료 / 실증 미완료”로 분리 보고한다.
- 사용자 소유 PPTX·기존 출력 변경이 그대로 보존된다.

### 검토 기록

- 적대적 검토 1차: CRITICAL 3 / HIGH 9
- 2차: CRITICAL 1 / HIGH 12
- 3차: CRITICAL 1 / HIGH 5
- 수정 내용: immutable lifecycle, exact registry/fingerprint, recipe-as-code 금지, read-only facade, 최소수집 후 암호화, HMAC·nonce, 환경별 eligibility, Spec gate, mirror outbox, MANUAL pilot 분리
- 최종 재검토: **CRITICAL 0 / HIGH 0 — APPROVE**
- 남은 MEDIUM 4건은 structural digest, bounded M05 parser, package-name 조정 지점, exact MCP registration test로 본 계획에 반영 완료
