# 펌웨어 정밀 학습전략 DB 및 범용 콘솔 관측 플랫폼 구축계획서

- **Status:** Active
- **작성일:** 2026-07-23
- **개정:** 기존 계획 체계 충돌 해소판
- **Owner:** Codex / Repository Maintainer
- **계획 경로:** `docs/superpowers/plans/2026-07-23-learning-strategy-observer.md`
- **구현 브랜치:** `feat/learning-strategy-observer-v1`
- **우선순위 정본:** `docs/superpowers/plans/2026-07-08-six-month-roadmap.md`
- **Related:** `docs/superpowers/plans/2026-07-02-final-goal-master-plan.md`, `docs/superpowers/plans/2026-07-08-m1-execution-tasks.md`, `docs/superpowers/plans/2026-07-08-plan-hardening-no-to-yes.md`, `ARCHITECTURE.md`, `docs/PROJECT_ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RELIABILITY.md`

## 0. R1~R12 변경 요약

| 개정 | 반영 위치 | 변경 요지 |
|---|---|---|
| R1 | `2. 로드맵 편입`·문서 메타데이터 | M2 병렬 트랙을 권고안으로 두고 M2/M5 중복 범위를 보강·비대체로 구분했으며 구현 브랜치를 `feat/learning-strategy-observer-v1`로 변경했다. |
| R2 | `3.2 제품 정체성 정본과 파생 뷰` | `@sangfor/product-adapters`의 `ADAPTERS`를 유일 정본으로 선언하고 alias 매핑·L1 파생 뷰·불일치 fail-closed를 정의했다. |
| R3 | `3.4 전략 lifecycle과 competency 원장` | 전략 상태를 `strategy_field_verified`로 분리하고 replacementRate 계상은 실파일 evidence를 가진 별도 competency 승격만 허용했다. |
| R4 | `3.3 버전 진실표 확장` | `FirmwareIdentity`를 `@sangfor/version` 진실표 record의 projection으로 재정의하고 CC `3.0.98`/`3.0.98C` 재실측 갱신 절차를 추가했다. |
| R5 | `3.5 승인 인프라 재사용`·`5.2 PR-001` | 승인 canonicalization·HMAC·constant-time verify·durable nonce를 `@sangfor/approval` 공통 primitive로 승격해 재사용하고 기존 execution gate의 외부 동작을 보존한다. |
| R6 | `3.7 LM-01~LM-08`·`5.4 PR-005`·`7. 사용자 결정` | LM-02 실장비 능동 replay를 사용자 결정으로 격상하고 승인 전에는 synthetic fixture만 구현하도록 게이트했다. |
| R7 | `3.12 기존 Spec 경계`·`REQ-20` | exact+eligible+complete 게이트가 신규 observer adapter에만 적용되며 기존 config-state→spec 및 MCP·자문 경로는 불변임을 명시했다. |
| R8 | `3.8 CDP 공존 규칙` | EPP/IAG/CC 9333~9335와 Glass 9222의 소유권, 야간 01:30~04:15 보호창, 정확히 1-page attach와 전후 불변 규칙을 정의했다. |
| R9 | `3.9 캡처 번들 통일` | 아직 미구현인 T-H2를 PR-004가 diagnosis reader와 observer writer까지 함께 구현하도록 소유권을 통합하고 `data/captures/*.enc`를 최종 번들 정본으로 고정했다. |
| R10 | 문서 전체 | 수집방법을 `LM-01~LM-08`, 연구방법을 `LR-01~LR-04`로 전면 개칭했다. |
| R11 | `7. 사용자 결정` | FortiOS 8.0 실랩 확보와 learning approval/capture key 생성·보관 절차를 신규 블로커로 등록했다. |
| R12 | `7. 사용자 결정` | 로드맵 §9의 기존 5건과 신규 결정·블로커를 단일 표로 통합하고 각 항목의 안전한 기본값과 차단 범위를 명시했다. |

## 1. 목표와 구축 범위

### 1.1 목표

제품·정확한 펌웨어·UI/API fingerprint별로 검증된 수집 전략을 선택하고, 이미 로그인된 콘솔 세션에서 read-only 사실을 수집하여 신규 observer adapter를 통해 기존 Spec 평가로 전달하는 플랫폼을 구축한다.

완료 결과는 다음과 같다.

- `LM-01~LM-08` 수집 방법과 `LR-01~LR-04` 연구 방법을 공통 플랫폼으로 제공한다.
- 제품 정체성은 기존 `ADAPTERS`, 펌웨어 정체성은 기존 버전 진실표를 확장하여 사용한다.
- 로컬 파일 DB를 정본으로 사용하고 PostgreSQL은 선택적 통계·검색 미러로 사용한다.
- MCP 도구 8개와 CLI 2개를 제공한다.
- CC와 IAG는 현장 전략 검증, FortiOS 8.0은 실제 랩 전략 검증을 목표로 하되 외부 접근이 없으면 정직하게 `BLOCKED`로 남긴다.
- exact match와 검증된 observation만 신규 adapter 경로에서 Spec에 전달하며 no-match·partial·conflict·unavailable 결과는 `INDETERMINATE`로 유지한다.
- 장비 설정 변경, 로그인 자동화, 자격증명 저장은 수행하지 않는다.

### 1.2 규모 및 현재 기준선

- 판정: **Tier XL**
- 근거: MUST 25개, 예상 변경 85~105개 파일, Prisma additive migration 1개, 원시 관측·실장비 세션을 다루는 R4 내재 위험
- 계획 작성 시 검증 기준선:
  - `pnpm test`: 432 passed, 2 skipped
  - `pnpm run lint`: PASS
  - `pnpm run build`: PASS
  - `pnpm run smoke:mcp`: PASS, 77 tools
- 구현 시작 시 최신 `main`에서 위 네 기준을 재측정하고 결과를 첫 PR 체크포인트에 기록한다.
- 구현은 최신 `main` 기반 별도 worktree와 `feat/learning-strategy-observer-v1` 브랜치에서 수행한다. 현재 문서 브랜치와 사용자 소유 PPTX·실장비 출력은 stash·삭제·복사하지 않는다.
- `tests/pptx-builder.test.ts`가 추적된 `outputs/Sangfor_설정가이드_MCP.pptx`를 재생성하므로 `pnpm test`·build·smoke 같은 전체 게이트는 반드시 clean task-owned implementation worktree에서만 실행한다. 현재 dirty 문서 checkout에서는 plan machine check와 Git diff 검사만 허용한다.

### 1.3 범위 밖

- 장비 설정 쓰기·자동 rollback·브라우저 클릭·로그인 자동화
- Operator Console 또는 Control Tower UI
- arbitrary web crawler와 MCP 내부 인터넷 검색
- cloud OCR/vision, 임의 JS·shell·`page.evaluate` recipe
- LM-05 Export 버튼 클릭 또는 다운로드 자동 실행
- 사용자 승인 전 LM-02 실장비 능동 replay
- 전체 제품과 ITAC 100개 항목의 현장 검증
- 자동 competency `field_verified` 승격
- 중앙 DB에 캡처 payload, 쿠키, 토큰, IP, serial, 고객 식별자 저장
- HCI/SCP create-volume 트랙 변경
- 기존 config-state→spec, MCP 도구, 자문 플로우의 동작 변경
- 별도 승인 없는 GitHub push·PR·merge·운영 배포

## 2. 로드맵 편입

### 2.1 제안 슬롯과 소유권

이 계획은 6개월 로드맵 **M2와 병렬인 `M2-LSO` 트랙**으로 편입하는 것을 권고한다. 이는 제안이며 최종 편입은 사용자 결정이다.

- M2가 버전 진실표의 내용 확정과 competency 원자 승격을 소유한다.
- M2-LSO는 버전 진실표의 schema·수집·fingerprint 확장과 read-only observer 기반을 제공한다.
- M2-LSO가 만든 verified version evidence는 M2 T2.2의 입력일 뿐, M2 수용 기준을 대신하지 않는다.
- M5는 벤더 확대와 PM workflow 결과를 소유한다. M2-LSO는 재사용 가능한 read-only 관측 기반만 제공한다.
- M3 create-volume write 트랙과는 병렬이며 장비 write gate·executor·read-back oracle을 수정하지 않는다.

### 2.2 M2/M5 중복 범위

| 기존 로드맵 항목 | 이 계획의 접점 | 관계 | 소유권·완료 경계 |
|---|---|---|---|
| M2 T2.1 competency 원자 승격 | 전략 검증 evidence 생성 | **보강, 비대체** | competency `field_verified` 승격과 replacementRate 갱신은 M2가 소유한다. |
| M2 T2.2 버전 진실표 | revision/buildId/hotfix/fingerprint schema와 관측 절차 | **보강** | `@sangfor/version`와 `data/version/requirements.json`이 정본이며 최종 값 확정은 M2가 소유한다. |
| M2 T2.3 spec 심화 | page/fact evidence 공급 | **보강, 비대체** | spec 항목 추가·출처 검증·coverage floor는 M2가 소유한다. |
| M2 T2.4 멀티벤더 실장비 | FortiOS/Cisco observer 기반 | **선행 기반** | 실장비가 있을 때의 field verification은 M2이며, 이 계획의 synthetic 결과로 대체하지 않는다. |
| M5 T5.1 벤더 확대 | 공통 resolver·method·capture contract | **보강** | 신규 vendor의 spec/client mapper/field evidence는 M5가 소유한다. |
| M5 T5.2 PM workflow e2e | read-only fact 공급 가능 | **비대체** | engagement→apply→verify PM 관통은 범위 밖이며 M5에 남는다. |
| M5 T5.3 playbook library | 전략 revision을 playbook 입력으로 사용 가능 | **비대체** | field-verified playbook 생성·승격은 M5가 소유한다. |

### 2.3 로드맵 편입 인수

- 이 문서에 M2-LSO 제안과 M2/M5 중복 표가 존재한다.
- 사용자 승인 전 로드맵 정본 파일의 일정·우선순위는 변경하지 않는다.
- 편입 승인 후 별도 문서 PR에서 M2-LSO를 로드맵에 링크하고 owner·기간·수용 기준을 동기화한다.

## 3. 목표 아키텍처와 고정 계약

### 3.1 계층 구조

1. L1 `@sangfor/learning-strategy`
   - strict method DSL, Fact 계약, 파일 DB, lifecycle, resolver를 소유한다.
   - `ProductRegistryView`와 버전 진실 record를 입력으로 받으며 L3 package를 import하지 않는다.
   - 학습 승인 검증은 같은 L1인 `@sangfor/approval`의 공통 primitive를 사용한다.
2. L1 기존 정본
   - `@sangfor/version` + `data/version/requirements.json`: 버전 진실과 exact identity schema.
   - `@sangfor/approval`: risk 분류와 domain-separated HMAC/nonce primitive.
   - `@sangfor/competency`: 유일한 replacementRate와 `field_verified` 원장.
3. L2 `@sangfor/observer`
   - Playwright existing-CDP 연결, read-only facade, passive capture, 암호화, LM driver를 구현한다.
   - 기존 operator session 또는 CAPTCHA OCR helper를 재사용하지 않는다.
4. L3 `@sangfor/product-adapters`
   - `ADAPTERS` 정본에서 immutable 파생 뷰를 생성해 L1에 주입한다.
   - observer 결과를 신규 Spec 입력 adapter로 변환한다.
5. Apps/MCP transport 조립 표면 — `ARCHITECTURE.md`에서 번호를 부여하지 않는 application surface
   - registry snapshot과 L1/L2 service를 조립한다.
6. Persistence Adapter
   - 로컬 outbox를 PostgreSQL에 at-least-once로 미러링한다.
   - DB 장애가 정본 로컬 transaction을 실패시키지 않는다.

L1이 L3를 import하는 역방향 의존은 금지한다. L3가 view를 만들고 번호 없는 app/MCP transport가 `ProductRegistryView`를 주입하는 구조로 `ARCHITECTURE.md`의 L0~L3 및 downward-only 규칙을 지킨다.

### 3.2 제품 정체성 정본과 파생 뷰

**제품 정체성의 유일 정본은 `@sangfor/product-adapters`의 `ADAPTERS` 레지스트리다.**

학습전략 package는 별도 registry를 소유하지 않는다. 다음 read-only 계약만 소유한다.

```ts
type AdapterProductCode = string & { readonly __brand: 'AdapterProductCode' };

interface SpecProductMapping {
  lookupCode: string;
  acceptedReturnedCodes: [string, ...string[]];
}

interface ProductRegistryView {
  schemaVersion: 1;
  registryDigest: string;
  entries: Array<{
    adapterProduct: AdapterProductCode;
    vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
    aliases: string[];
    observerOnlyAliases: string[];
    observerEligible: boolean;
    defaultSpecMapping: SpecProductMapping | null;
    specMappingByVariant: Record<string, SpecProductMapping>;
  }>;
}
```

L1의 `AdapterProductCode`는 product 이름을 열거한 별도 union이 아니라, 주입된 view에서 strict resolve에 성공했을 때만 생성되는 branded string이다. canonical code 추가·삭제는 ADAPTERS에서만 수행한다.

현재 L0 `@sangfor/shared`의 `PRODUCTS`/`ProductCode`는 기존 Sangfor planner·표시용 catalog다. observer identity의 정본이나 ADAPTERS의 상위 정본이 아니며, 신규 `FORTIOS`/`IOSXE`를 넣지 않는다.

PR-001A는 다음처럼 legacy 표면과 observer 확장을 분리한다.

```ts
export type AutomationProductCode =
  | 'HCI_SCP' | 'IAG' | 'ENDPOINT_SECURE' | 'NDR'; // 기존 public union 불변

type ObserverAdapterProductCode =
  | AutomationProductCode | 'FORTIOS' | 'IOSXE';

export interface ProductAdapter {
  product: AutomationProductCode;
  aliases: string[];
  strategy: AdapterStrategy;
  authMethods: string[];
  apiLikely: boolean;
  apiCatalogStatus: 'ready' | 'discovery_required' | 'document_required';
  menuRoutes: string[];
  capabilities: ProductCapability[];
}

interface AdapterIdentity<C extends ObserverAdapterProductCode> {
  adapterProduct: C;
  vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
  aliases: string[];
  observerOnlyAliases: string[];
  observerEligible: boolean;
  defaultSpecMapping: SpecProductMapping | null;
  specMappingByVariant: Record<string, SpecProductMapping>;
}

interface AdapterRegistryEntry<C extends ObserverAdapterProductCode> {
  identity: AdapterIdentity<C>;
  legacyAdapter: C extends AutomationProductCode ? ProductAdapter : null;
}

type AdapterRegistry = {
  [C in ObserverAdapterProductCode]: AdapterRegistryEntry<C>;
};

const LEGACY_AUTOMATION_PRODUCTS: readonly AutomationProductCode[] =
  ['HCI_SCP', 'IAG', 'ENDPOINT_SECURE', 'NDR'];

const ADAPTERS: AdapterRegistry = { /* 6 entries */ };
```

- 기존 `normalizeAutomationProduct()`, `getProductAdapter()`, `listProductAdapters()`는 `LEGACY_AUTOMATION_PRODUCTS` 4종의 `legacyAdapter`만 순회·반환한다. unknown과 `FortiOS`/`IOSXE` 입력을 포함해 기존 반환 object shape·값·목록 순서·개수는 semantic-equality로 유지한다.
- 기존 4개 `legacyAdapter`에는 vendor/spec metadata를 추가하지 않는다. 해당 metadata는 sibling `identity`에만 둔다.
- 신규 `resolveProductAdapterStrict()`와 `getProductRegistrySnapshot()`만 ADAPTERS 6종의 `identity`를 본다. `FORTIOS`와 `IOSXE` entry의 `legacyAdapter`는 null이다.
- 기존 4개 entry는 정규화된 `legacyAdapter.aliases`가 `identity.aliases`의 부분집합인지 registry invariant test로 고정한다. `identity.observerOnlyAliases`는 두 집합의 정확한 차집합이어야 하며 strict resolver만 소비한다. `legacyAdapter=null`인 신규 product는 `observerOnlyAliases`가 전체 `identity.aliases`와 같아야 한다.
- legacy 함수는 `identity.aliases`나 `observerOnlyAliases`를 절대 순회하지 않는다. 현재 호환 결과인 `normalizeAutomationProduct('CC')`, `normalizeAutomationProduct('Athena XDR')`, `normalizeAutomationProduct('A-Sec')`가 모두 `HCI_SCP`인 상태를 explicit regression으로 고정한다.
- ADAPTERS는 여전히 6종 전체 product identity의 유일 정본이며 `LEGACY_AUTOMATION_PRODUCTS`는 기존 API 호환을 위한 정본의 필터 view다.

`ADAPTERS`는 외부 mutation이 불가능한 snapshot 함수로 `identity`만 deep-copy/freeze해 위 `ProductRegistryView`를 만든다. entry는 `adapterProduct`, aliases는 `trim→lowercase→space/hyphen을 _로 변환`한 값, Spec mapping은 variant key로 정렬한 canonical JSON의 SHA-256 digest를 함께 반환한다. digest에는 vendor·aliases·observerOnlyAliases·observer eligibility·Spec mapping이 모두 포함된다. 전략 revision은 작성 당시 `registryDigest`를 기록한다. app bootstrap의 현재 digest, 전략의 digest, 선택된 adapter product가 하나라도 다르면 `REGISTRY_DRIFT`로 resolve·collect·promote를 모두 fail-closed 거부한다.

별칭·Spec join 매핑:

| 관측·사용자 표기 | ADAPTERS canonical code | observer-only 추가 alias | variant | Spec mapping (`lookupCode` → `acceptedReturnedCodes`) |
|---|---|---|---|---|
| `EPP`, `Endpoint Secure`, `A-Sec` | `ENDPOINT_SECURE` | `A-Sec` | null | `ENDPOINT_SECURE` → [`ENDPOINT_SECURE`] (`EPP` directory fallback은 loader 내부) |
| `IAG`, `IAM`, `Internet Access Gateway` | `IAG` | 없음 | null | `IAG` → [`IAG`] |
| `CC`, `Cyber Command` | `NDR` | `CC` | `CYBER_COMMAND` | `CYBER_COMMAND` → [`CYBER_COMMAND`] (`CC` directory fallback은 loader 내부) |
| `Athena NDR`, `Athena XDR` | `NDR` | `Athena XDR` | `ATHENA_XDR` | `XDR` → [`XDR`] |
| generic `NDR` | `NDR` | 없음 | 미확정 | null; fingerprint로 variant를 확정할 때까지 `SPEC_IDENTITY_MISMATCH` |
| `HCI`, `SCP`, `aCloud` | `HCI_SCP` | 없음 | null | `HCI_SCP` → [`HCI_SCP`, `HCI`] |
| `FortiOS`, `FortiGate` | `FORTIOS` | 전체 alias, identity-only product | null | `FORTIOS` → [`FORTIOS`] |
| `IOS XE`, `Cisco IOSXE` | `IOSXE` | 전체 alias, identity-only product | null | `CISCO_IOSXE` → [`CISCO_IOSXE`] |

`CC`·`Cyber Command` alias는 vendor/product fingerprint가 Cyber Command임을 증명할 때만 variant로 확정한다. 단어 alias만으로 `NDR`을 `CYBER_COMMAND` spec에 join하지 않는다.

`productVariant`는 alias resolver가 새로 추론하지 않고 verified `FirmwareTruthRecord`에서만 읽는다. strict resolver는 그 variant가 ADAPTERS identity의 `specMappingByVariant`에 존재하고 현재 UI/API fingerprint와 같은 evidence에서 확정됐는지 검증한다.

기존 `normalizeAutomationProduct()`의 unknown→`HCI_SCP` 호환 동작은 기존 호출자를 위해 변경하지 않는다. 신규 observer 경로는 새 `resolveProductAdapterStrict()`만 사용하며 unknown, 빈 값, 다중 alias, snapshot mismatch를 각각 `UNSUPPORTED_PRODUCT`, `AMBIGUOUS_PRODUCT`, `REGISTRY_DRIFT`로 거부한다.

### 3.3 버전 진실표 확장

버전 정본은 기존 `@sangfor/version`과 `data/version/requirements.json`이며 M2 T2.2가 값의 최종 확정을 소유한다. 독립된 펌웨어 identity DB를 만들지 않는다.

`data/version/requirements.json`은 기존 minimum/recommended requirement를 보존하면서 schema version을 additive하게 올리고 `firmwareTruth` collection을 추가한다.

```ts
interface FirmwareTruthRecord {
  id: string;
  vendor: 'SANGFOR' | 'FORTINET' | 'CISCO';
  adapterProduct: string;
  productVariant: string | null;
  versionRaw: string;
  versionFamily: string;
  revision: string | null;
  buildId: string | null;
  hotfix: string | null;
  uiFingerprint: string | null;
  apiFingerprint: string | null;
  status: 'candidate' | 'conflict' | 'verified' | 'superseded';
  observedAt: string | null;
  evidenceFile: string | null;
  specVersion: string | null;
  specApplicability: 'unreviewed' | 'verified';
  source: string;
}

type FirmwareIdentity = Pick<
  FirmwareTruthRecord,
  | 'id' | 'vendor' | 'adapterProduct' | 'versionRaw' | 'versionFamily'
  | 'productVariant' | 'revision' | 'buildId' | 'hotfix'
  | 'uiFingerprint' | 'apiFingerprint' | 'specVersion' | 'specApplicability'
>;
```

`FirmwareIdentity`는 위 진실표 record의 검증된 projection이지 별도 모델·저장소가 아니다. resolver는 `status='verified'`이고 실제 `evidenceFile`이 존재하는 record만 모든 환경의 eligible Spec 입력에 사용한다. `candidate`·`conflict`는 research/canary 설명만 반환하고 항상 noneligible이다. 기존 숫자 기반 `compareVersions`는 upgrade advisory용으로 유지하고 exact resolver에는 사용하지 않는다.

`FirmwareTruthRecord`와 `FirmwareIdentity`는 `@sangfor/version`에서만 export한다. version package의 `adapterProduct`는 L1→L3 의존과 learning↔version cycle을 피하려고 non-empty string으로 저장한다. learning resolver가 주입된 `ProductRegistryView`로 값을 검증한 순간에만 이를 branded `AdapterProductCode`로 좁힌다. `@sangfor/learning-strategy`의 `contracts.ts`는 version type을 import/re-export할 수 있지만 구조가 같은 로컬 interface를 다시 선언하지 않는다.

- `versionRaw`는 장비에서 읽은 exact 값이고 `versionFamily`는 검색·표시용 family다.
- Spec lookup은 `versionRaw`나 `versionFamily`를 추측해 사용하지 않고 M2가 검증한 `specVersion`만 사용한다.
- `specApplicability='verified'`, non-null `specVersion`, verified product/variant→`SpecProductMapping`이 모두 있어야 `ObserverSpecAdapter`가 `loadSpec(mapping.lookupCode, specVersion)`을 호출한다.
- 예를 들어 CC `versionRaw='3.0.98C'`가 확정되어도 `specVersion='3.0.98'` 적용성 review가 끝나기 전에는 Spec 입력이 금지된다.
- mapping 누락·variant 미확정은 `SPEC_IDENTITY_MISMATCH`, spec version 미검증은 `SPEC_VERSION_UNVERIFIED`, 실제 spec 부재는 `SPEC_NOT_FOUND`로 fail-closed 처리한다.

CC 진실표 갱신 절차:

1. 로드맵은 `CC 3.0.98`로 기록했지만 기존 `outputs/diagnosis/CC_3.0.98_configstate.json`의 `observed.systemVersion.value`는 `3.0.98C`다. initial migration에서 두 값을 모두 `conflict`로 기록하고 `verified` production seed를 만들지 않는다.
2. 두 conflict record는 production뿐 아니라 lab/poc/customer observer eligibility에서도 제외한다. resolver는 설명용 `VERSION_CONFLICT`만 반환한다.
3. 사람이 연 System/About의 LM-04 DOM 값과 화면 로딩 중 passive capture된 동일 의미 response처럼 서로 독립된 두 표면에서 `versionRaw`, revision/build/hotfix를 다시 읽는다. U-02 승인 전에는 endpoint를 능동 replay하지 않는다.
4. 화면/endpoint·수집 시각·sanitized evidence 실파일을 함께 기록하고 두 독립 read가 같은 raw 값을 반환하는지 확인한다.
5. 같으면 M2 reviewer가 정확한 raw 값 하나를 `verified`로 새로 승격하고 다른 record는 `superseded`로 남긴다. 다르면 양쪽을 `conflict`로 유지하고 `VERSION_CONFLICT`로 중단한다.
6. `3.0.98C`가 확정되면 기존 `3.0.98` spec을 자동 재사용하지 않고 적용성 검토를 수행한다. `3.0.98`이 확정되면 초안의 `3.0.98C` 가정을 폐기한다.
7. M2 reviewer가 `3.0.98` spec의 `3.0.98C` 적용성을 승인한 경우에만 `specVersion='3.0.98'`, `specApplicability='verified'`를 기록한다.
8. truth 갱신 PR은 evidence file 존재, product registry digest, exact raw parsing, Spec mapping과 conflict 회귀 테스트를 통과해야 한다.

fingerprint는 canonical JSON으로 정규화한 안정적 descriptor만 SHA-256 처리한다.

- 포함: raw build ID, asset manifest ID, framework/version, 정규화 route signature, API schema signature
- 제외: hostname, IP, origin, serial, license, 사용자·고객값, DOM text/value, 시간, counter, token

### 3.4 전략 lifecycle과 competency 원장

`StrategyRevision` payload는 생성 후 불변이고 상태는 append-only `LifecycleEvent`를 fold해 계산한다.

| 현재 | 다음 | 필수 증적 |
|---|---|---|
| `draft` | `researched` | LR-01~LR-04 중 유효 evidence와 사람 HMAC |
| `researched` | `lab_verified` | 실제 랩 target의 exact 검증, 실파일 evidence, 사람 HMAC |
| `lab_verified` | `device_verified` | exact 물리/가상 장비 1대 검증, 실파일 evidence, 사람 HMAC |
| `device_verified` | `strategy_field_verified` | 현장 성공 1회, 필수 fact 완전성, 실파일 evidence, 사람 HMAC |
| 활성 상태 | `stale` | 사람 HMAC 또는 검증된 integrity/mutation safety event |
| 모든 비종료 상태 | `deprecated` | 사람 HMAC |
| `stale` | `deprecated` | 사람 HMAC |

- `stale` revision은 복구하지 않고 `derivedFromRevisionId`를 가진 새 `draft`를 만든다.
- `deprecated`는 종료 상태다.
- fingerprint mismatch, no-match, incomplete는 자동 stale이 아니라 `stale_candidate` evidence만 남긴다.
- exact safety invariant 위반이나 mutation signal은 즉시 noneligible 처리하고 event store가 정상일 때만 system stale event를 기록한다.

환경별 사용 조건:

| 전략 상태 | 사용 가능 범위 |
|---|---|
| `draft` | 사용 불가 |
| `researched` | canary·설명만, Spec 입력 불가 |
| `lab_verified` | exact `lab`만 |
| `device_verified` | 검증된 opaque UUIDv7 `deviceScope`의 `lab/poc/customer`, production 제외 |
| `strategy_field_verified` | exact `lab/poc/customer/production` |
| `stale/deprecated` | 사용 불가 |

#### competency와 replacementRate 관계

- 저장소의 유일 성공지표는 `@sangfor/competency`의 `replacementRate`다.
- `strategy_field_verified`는 전략의 재현성 상태이며 competency `field_verified`가 아니다. 전략 승격만으로 replacementRate에 자동 계상하지 않는다.
- 전략 lifecycle evidence는 `evidenceFile`과 `evidenceDigest`를 함께 가진다. digest는 무결성 확인용일 뿐 evidence를 대신하지 않는다.
- 기본 `evidenceFile`은 `data/runtime/learning-strategies/evidence/<runId>.json`의 sanitized evidence report다. 이 report는 firmware truth ID, fact ID, method, source endpoint reference, observed typed value, 수집 시각, reviewer와 bundle digest를 포함하고 secret·고객 식별자는 포함하지 않는다.
- encrypted bundle 경로·bundle digest·run ID만으로는 전략 승격이나 competency 계상 evidence가 되지 않는다.
- replacementRate에 계상하려면 별도 `WorkAtom`이 `field_verified`로 승격되어야 하며 `coveredBy`가 실제 등록 도구를 가리키고 `evidence`가 evidence root 내부의 **존재하는 일반 파일 경로**여야 한다.
- directory, absolute path, traversal, 존재하지 않는 파일, digest 문자열, run ID만 있는 값은 계상하지 않는다.
- M2 T2.1이 전략 evidence를 검토해 해당 WorkAtom을 별도로 승격하며, 이 계획은 자동 원장 쓰기를 수행하지 않는다.

### 3.5 승인 인프라 재사용

`SANGFOR_LEARNING_APPROVAL_SECRET`의 시크릿과 `learning-strategy-v1` HMAC domain은 execution approval과 분리한다. 다만 canonical serialization, HMAC-SHA256, `timingSafeEqual`, expiry 검증, durable single-use nonce 구현은 중복 작성하지 않고 `@sangfor/approval`로 승격해 양쪽에서 재사용한다.

| 현재 symbol·위치 | PR-001 공통화 결과 | 호환 계약 |
|---|---|---|
| `approvalCanonicalString` (`@sangfor/operator`) | `canonicalizeApprovalPayload` (`@sangfor/approval`) | 기존 줄바꿈 순서와 action binding 회귀 테스트를 고정한다. |
| `signApprovalToken` (`@sangfor/operator`) | `signDomainApproval` (`@sangfor/approval`) | operator의 기존 export는 wrapper로 유지한다. |
| `verifyExecutionApproval` 내부 `timingSafeEqual` | `verifyDomainApprovalSignature` (`@sangfor/approval`) | 오류 사유·expiry·constant-time 비교 동작을 보존한다. |
| `FileNonceStore` (`@sangfor/operator`) | `FileSingleUseNonceStore` (`@sangfor/approval`) | corrupt store fail-closed와 atomic rename 동작을 보존한다. |
| `consumeApprovalNonce`, `defaultNonceStorePath` | shared store를 호출하는 operator wrapper | 기존 `SANGFOR_NONCE_STORE_PATH`와 파일 schema를 보존한다. |

공통 primitive의 고정 시그니처:

```ts
canonicalizeApprovalPayload(fields: readonly string[]): string;
signDomainApproval(secret: string | Uint8Array, canonicalPayload: string): Uint8Array;
verifyDomainApprovalSignature(
  secret: string | Uint8Array,
  canonicalPayload: string,
  signatureBytes: Uint8Array,
): { ok: boolean; reason?: string };
new FileSingleUseNonceStore(filePath: string).consume(
  nonce: string,
  expiresAt: string,
  now?: Date,
): NonceConsumeResult;
```

`canonicalizeApprovalPayload`는 받은 field를 UTF-8로 인코딩하고 순서를 보존해 단일 `\n`으로 결합하며 마지막 newline은 붙이지 않는다.

- operator wrapper의 정확한 순서: `approvedBy`, `changeTicketId`, `rollbackPlanId`, `nonce`, `expiresAt`, `action.type`, `action.target ?? ''`
- learning adapter의 정확한 순서: `learning-strategy-v1`, `entityType`, `entityId`, `revisionId`, `contentHash`, `fromState`, `toState`, `evidenceFile`, `evidenceDigest`, `nonce`, `expiresAt`
- operator wrapper는 현재의 7개 field와 raw string secret을 그대로 전달하고 반환 bytes를 lowercase hex로 encode하므로 기존 canonical bytes와 HMAC hex가 바뀌지 않는다.
- learning adapter는 모든 string field를 non-empty로 검사하고 CR/LF를 거부한 뒤 base64 secret을 strict decode해 정확히 32-byte `Uint8Array`로 만든다.
- 공통 HMAC 함수 자체는 secret 형식을 강제하지 않는다. 이 분리로 learning key policy가 operator 호환성에 전파되지 않는다.
- operator wrapper는 현재처럼 `Buffer.from(token, 'hex')`로 decode하고 공통 verifier의 32-byte length check·`timingSafeEqual`을 사용하므로 기존 uppercase/malformed 처리 의미를 바꾸지 않는다.
- learning adapter만 signature가 정확히 64개 lowercase hex인지 먼저 검증한다. 길이·문자 검증 실패는 `INVALID_SIGNATURE_ENCODING`, 32-byte decode 후 공통 verifier 불일치는 `SIGNATURE_MISMATCH`다.
- 공통 verifier는 signature만 검사하고 expiry·nonce·상태전이는 domain adapter가 검사한다. learning 오류 계약은 `SECRET_NOT_CONFIGURED`, `INVALID_SECRET_ENCODING`, `INVALID_PAYLOAD`, `APPROVAL_EXPIRED`, `INVALID_SIGNATURE_ENCODING`, `SIGNATURE_MISMATCH`, `NONCE_REPLAY`, `NONCE_STORE_UNAVAILABLE`, `EVENT_APPEND_FAILED`로 고정한다.

learning 전용 계약:

- secret: `SANGFOR_LEARNING_APPROVAL_SECRET`
- nonce path: `SANGFOR_LEARNING_NONCE_STORE_PATH`, 기본 `data/runtime/learning-approval-nonces.json`
- payload: domain, entity type/id, revision ID, content hash, from/to, `evidenceFile`, evidence digest, nonce, expiry
- key 형식: base64 32-byte, 누락·길이 오류·decode 오류는 fail-closed
- 서명 생성: MANUAL CLI만 제공하고 MCP는 검증만 수행

learning promotion 순서는 다음으로 고정한다.

1. strict payload·현재 lifecycle state·content/evidence 실파일 hash를 검증한다.
2. secret decode, expiry, canonical payload, HMAC를 검증한다.
3. durable nonce store에서 nonce를 단일 소비한다.
4. nonce 소비 성공 후에만 append-only lifecycle event를 기록한다.
5. event append가 실패하면 상태는 불변이고 nonce는 소비된 채 유지한다. 같은 approval을 재사용하지 않고 새 nonce·새 expiry로 사람이 다시 서명해야 한다.

nonce를 event append 뒤에 소비하거나, append 실패 시 nonce를 되살리거나, store 오류를 무시하는 구현은 금지한다.

`FileSingleUseNonceStore`의 cross-process 계약:

- `${filePath}.lock` directory를 mode `0700`의 atomic `mkdir`로 획득하고 최대 2초 bounded retry 후 `NONCE_STORE_LOCK_TIMEOUT`으로 fail-closed한다.
- lock을 획득한 프로세스만 read→expired GC→duplicate check→append를 수행한다.
- temp는 `${filePath}.${pid}.${randomUUID()}.tmp`처럼 process/run별 unique name과 mode `0600`을 사용한다.
- temp file fsync → atomic rename → parent directory fsync 후에만 consume 성공을 반환한다.
- lock은 `finally`에서 제거한다. stale/corrupt lock을 자동 삭제하지 않으며 runbook의 MANUAL process 확인·audit 뒤에만 제거한다.
- 기존 `SANGFOR_NONCE_STORE_PATH`, JSON `{ consumed: [...] }` schema, `approval nonce already used`/`nonce store unavailable` public 오류 의미는 보존한다.
- operator wrapper는 내부 `NONCE_STORE_LOCK_TIMEOUT`을 기존 `nonce store unavailable (fail-closed): ...` 형식으로 mapping하고 learning adapter만 typed error code를 노출한다.
- 두 child process가 같은 nonce를 동시에 consume하는 focused test에서 성공은 정확히 1개여야 하고 다른 결과는 replay 또는 lock fail-closed여야 한다.

`@sangfor/operator`는 L1 `@sangfor/approval`을 import해 기존 public symbol을 wrapper/re-export한다. `verifyExecutionApproval`, `assertRealExecutionAllowed`, `SANGFOR_OPERATOR_APPROVAL_SECRET`, execution nonce path, action payload, 오류 문자열과 gate 순서는 변경하지 않는다.

### 3.6 Resolver와 method chain

- 합성 순서는 `product/firmware default → capability override → fact override`다.
- overlay 규칙:
  - omitted: 상위 값 상속
  - array: 전체 교체
  - `null`: nullable로 선언된 필드만 허용
  - overlay 후 전체 strict schema 재검증
- 같은 scope에 active revision이 둘 이상이면 tie-break하지 않고 `AMBIGUOUS_STRATEGY`로 거부한다.
- registry digest 또는 version truth record가 다르면 near candidate도 실행하지 않는다.
- near-version은 설명용 candidate만 반환하고 observation·Spec 평가에는 넣지 않는다.
- fact별 ordered method chain:
  - `not_applicable`, `not_observed`: 다음 method 진행
  - `complete`: 종료
  - `partial`: 해당 fact를 partial로 종료
  - `blocked`, `integrity_error`, `mutation_signal`: 전체 run 중단
- 둘 이상의 complete 값이 다르면 precedence로 덮지 않고 `conflict`로 반환한다. 각 후보의 method/revision/keyed value digest/evidence/수집 시각을 `conflictCandidates[]`에 보존하며 signed LM-08 확인 전까지 Spec 입력을 금지한다.
- `complete`는 required path·cardinality 충족, truncation 없음, parse warning 없음으로 정의한다.

### 3.7 LM-01~LM-08와 LR-01~LR-04

Recipe에는 임의 코드, 함수명, regex, shell, URL host, header value를 넣을 수 없다. 중앙 interpreter만 좁은 `ReadOnlyFacade`를 받고 raw Playwright `Page`/`Context`는 driver에 노출하지 않는다.

| 코드 | v1 동작과 금지 |
|---|---|
| LM-01 | 공식 citation이 있는 same-origin GET/HEAD와 제한된 JSON key path만 허용한다. |
| LM-02 | exact+promoted recipe의 GET/HEAD와 명시적 read-only POST template을 1회 replay하는 후보 방식이다. **사용자 승인 전에는 synthetic fixture adapter에서만 동작하고 실장비 facade는 `ACTIVE_REPLAY_NOT_APPROVED`로 거부한다.** |
| LM-03 | 이미 로드된 ExtJS store의 allowlisted `storeId`·field만 읽고 load/sync/call은 금지한다. |
| LM-04 | allowlisted DOM/ARIA selector·attribute만 읽고 click/focus/scroll/value mutation은 금지한다. |
| LM-05 | 사람이 미리 저장한 JSON/CSV만 allowlisted import root에서 streaming parse하며 symlink/path traversal을 금지한다. |
| LM-06 | 이미 존재하는 WS/SSE의 inbound frame listener만 사용하고 send/new WebSocket/new EventSource를 금지한다. |
| LM-07 | local-only OCR provider, recipe ROI와 고정 type parser만 사용하고 pixel·원문 OCR text 저장과 단독 자동 PASS를 금지한다. |
| LM-08 | typed observation digest에 대한 reviewer·identity·nonce·expiry 서명만 허용하고 forged boolean과 free-form secret을 금지한다. |

LM-05 한도는 파일 50MiB, 100,000 rows, 256 fields/row, 문자열 64KiB, parse timeout 30초다.

연구 방법:

| 코드 | 산출물 | 승격 제한 |
|---|---|---|
| LR-01 | 공식 매뉴얼 citation과 page-verified 후보 | 공식 출처의 제품·버전 적용성이 확인되지 않으면 draft 유지 |
| LR-02 | passive capture 구조 benchmark와 allowlist 후보 | raw secret·payload를 저장하지 않음 |
| LR-03 | UI framework·route·store/DOM capability probe | ExtJS/Vue 등 framework를 사전 추정하지 않음 |
| LR-04 | 기존 전략 대비 latency·coverage·conflict benchmark | 실제 evidence file 없는 우수성 주장은 승격에 사용하지 않음 |

### 3.8 CDP 공존과 브라우저 불변

| 포트 | 현재 소유자 | observer 규칙 |
|---:|---|---|
| 9222 | Glass/Cursor KB 세션, `learn:kb:full` launchd 03:00 | device observer 사용 금지. 입력으로 들어오면 `RESERVED_CDP_PORT`로 거부한다. |
| 9333 | EPP 제품 콘솔 | `ENDPOINT_SECURE` profile만 사용 가능 |
| 9334 | IAG 제품 콘솔 | `IAG` profile만 사용 가능 |
| 9335 | CC 제품 콘솔 | Cyber Command evidence가 있는 `NDR` profile만 사용 가능 |

공존 규칙:

- `learn:all` 02:00과 Glass KB 학습 03:00의 지연 실행을 고려해 매일 **01:30~04:15 Asia/Seoul**을 observer 보호창으로 둔다. 이 시간에는 실장비 attach·capture·collect를 fail-closed 거부하고 synthetic test만 허용한다.
- observer는 `product + expectedOrigin + cdpPort + firmwareTruthId`가 모두 일치하는 profile만 받는다.
- 해당 origin과 일치하는 열린 page가 정확히 1개일 때만 그 page에 attach한다. 0개 또는 2개 이상이면 거부한다.
- `newPage`, `newContext`, `goto`, login, page close를 금지한다.
- attach 전후 전체 page count, 각 page URL, browser process PID/생존이 동일해야 한다.
- storage invariant는 선택 origin에 대해 CDP `DOMStorage.domStorageItemAdded`, `domStorageItemUpdated`, `domStorageItemRemoved`, `domStorageItemsCleared` event를 attach 직후부터 detach 직전까지 **개수만** 세어 0임을 확인한다. storage key/value·token·digest는 저장하지 않는다.
- mock console은 모든 mutation endpoint 호출 수를 별도 counter로 제공하고 observer run 전후 증가량이 0이어야 한다.
- detach 후 불변 검사가 실패하면 run 전체를 `mutation_signal` 또는 `integrity_error`로 만들고 evidence를 Spec에 전달하지 않는다.
- 보호창과 포트 소유권은 constructor로 주입한 test-only clock·profile fixture로 unit test하고 외부 Chromium E2E에서 실제 before/after snapshot을 검증한다. MCP/CLI schema나 production env에는 clock override를 노출하지 않는다.

### 3.9 캡처 번들 통일

T-H2는 계획 카드만 있고 현재 저장소에는 `capture-bundle.v1`, AES-GCM bundle module, diagnosis reader, observer writer가 모두 **미구현**이다. 이 계획은 기존 구현을 재사용한다고 가정하지 않고, PR-004가 T-H2 전체 구현 소유권을 흡수해 diagnosis reader와 observer writer를 같은 shared module 위에 동시에 만든다. 별도 T-H2 구현 트랙을 병렬 실행하지 않으며 PR-004 완료 후 기존 T-H2 카드에 대체 구현 링크와 검증 결과를 동기화한다.

T-H2의 `data/captures/<device>-<ts>.enc` 의도를 계승하되 `<device>` 자리에는 실제 hostname/IP/serial이 아니라 opaque `deviceScopeDigest`만 사용한다. `data/captures/`는 **최종 오프라인 캡처 번들의 유일 저장 위치와 포맷 정본**이며 신규 observer는 별도 포맷을 만들지 않는다.

- canonical envelope: `capture-bundle.v1`
- 최종 파일: `data/captures/<deviceScopeDigest>-<ts>-<captureId>.enc`
- `deviceScopeDigest`는 caller가 제공한 non-PII UUIDv7 `deviceScope`의 lowercase SHA-256 64-hex다. hostname, IP, serial, 고객명, 제품명이 파일명에 들어가면 capture를 생성하지 않는다.
- transient staging: `data/runtime/learning-captures/<captureId>/`
- staging은 encrypted chunks·manifest 조립에만 사용하고 성공 시 canonical bundle로 atomic promote한다.
- promote 완료 후 staging을 제거한다. 실패 staging은 24시간 후 purge 대상이며 전략 evidence로 사용할 수 없다.
- PR-004는 `packages/sangfor-collector/src/capture-bundle.ts`를 새로 만들고 `packages/sangfor-collector/src/index.ts`에서 export한다. `scripts/device-collect.ts` writer, `scripts/epp-diagnose.ts`, `scripts/cc-diagnose.ts`, `scripts/iag-diagnose.ts` reader, 신규 observer writer가 모두 이 단일 envelope schema·redactor·encrypt/decrypt contract를 사용한다.
- 전략 record는 canonical bundle path와 digest를 참조한다. PostgreSQL mirror에는 path·payload를 저장하지 않는다.
- PR-004에서 `.gitignore`에 `data/captures/**`를 추가해 전체 directory를 local-only로 고정한다.
- `git check-ignore -q data/captures/probe.enc`가 exit code 0인지 regression으로 검증한다.
- 사용자에게 별도 capture artifact 커밋 승인을 받기 전 `git add -f data/captures/...`와 ignore 예외 추가를 금지한다. U-08의 `outputs/diagnosis` 결정만으로 capture commit이 허용되지는 않는다.

산출물 명칭은 `sanitized encrypted capture bundle`로 고정한다.

- recipe allowlist에 포함된 response path·column·frame 값만 저장한다.
- unknown payload는 값이나 raw hash가 아니라 secret hard-deny 후 sanitized structural skeleton만 keyed digest 처리한다.
- Authorization, Cookie, Set-Cookie, token, password, secret 계열은 recipe가 요청해도 폐기한다.
- 최초 연구 캡처는 구조만 저장하고 draft allowlist 작성 후 재캡처해야 값이 저장된다.
- 구조적 최소화 후 AES-256-GCM 암호화를 수행하며 plaintext 임시 파일은 만들지 않는다.
- keyring:
  - `SANGFOR_CAPTURE_BUNDLE_KEYS='{"key-id":"<base64-32-byte>"}'`
  - `SANGFOR_CAPTURE_BUNDLE_ACTIVE_KEY_ID='<key-id>'`
- metadata에는 key ID, 96-bit nonce, tag, AAD digest, schema version, 생성·만료일, ciphertext digest만 둔다.
- 기본 보존 기간 30일, bundle 상한 100MiB, item 상한 2MiB, event 상한 10,000개다.
- runtime directory는 `0700`, 파일은 `0600`으로 생성한다.
- `observe purge`는 dry-run이 기본이며 `--execute --before <ISO>`와 검증된 exact root가 모두 있어야 한다. MCP 삭제 도구는 제공하지 않는다.

### 3.10 파일 DB와 PostgreSQL 미러

로컬 정본:

- seed/catalog: `data/learning-strategies/`
- mutable DB: `data/runtime/learning-strategies/`
- transient capture staging: `data/runtime/learning-captures/`
- final encrypted capture: `data/captures/*.enc`
- immutable revision, lifecycle event, evidence, run, mirror outbox와 generation manifest
- cross-process exclusive lock, schema version, generation CAS, content hash 검증
- temp fsync → rename → directory fsync
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

루트 `prisma/schema.prisma`에 additive migration 1개만 추가한다. DB에는 sanitized metadata, coverage, latency, status, method code, content/evidence digest만 저장한다. `deviceScope`는 caller가 제공한 non-PII UUIDv7의 digest만 저장하고 bundle path·payload는 저장하지 않는다.

로컬 transaction과 outbox 생성은 같은 lock/generation commit에서 수행한다. mirror는 event ID unique upsert, 최대 10회 exponential retry, 이후 DLQ로 이동한다. DB 장애 시 일반 로컬 명령은 `mirrorStatus: pending`으로 성공하며 명시적 `mirror-sync`만 실패 exit code를 반환한다.

### 3.11 Fact API

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
  allowCanary?: boolean;
}

type LearningMethodCode = `LM-0${1|2|3|4|5|6|7|8}`;

interface FactObservationBase {
  factId: string;
  eligibility: 'eligible' | 'human_review_required' | 'ineligible';
  collectedAt: string;
  evidenceFiles: string[];
  evidenceDigests: string[];
  validation: string[];
}

interface ConflictCandidate {
  methodCode: LearningMethodCode;
  recipeRevisionId: string;
  valueDigest: string;
  evidenceFiles: string[];
  collectedAt: string;
}

type FactObservation =
  | (FactObservationBase & {
      status: 'complete' | 'partial' | 'unavailable';
      value?: unknown;
      methodCode: LearningMethodCode;
      recipeRevisionId: string;
      conflictCandidates?: never;
    })
  | (FactObservationBase & {
      status: 'conflict';
      eligibility: 'ineligible';
      value?: never;
      methodCode?: never;
      recipeRevisionId?: never;
      conflictCandidates: [ConflictCandidate, ConflictCandidate, ...ConflictCandidate[]];
    });

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
  evidenceFiles: string[];
  bundleRef?: string;
}
```

`allowCanary` 기본값은 false이며 true여도 canary 결과는 noneligible이다. username/password/token/cookie/authorization 입력 필드는 schema와 handler 양쪽에서 거부한다. `credentialRef`는 process-local lookup key이며 contract·로그·파일에 실제 credential을 포함하지 않는다.

`conflict` 응답은 원문 후보값을 노출하지 않고 후보별 keyed `valueDigest`, method, recipe revision, evidence file, 수집 시각을 최소 2개 보존한다. LM-08 adjudicator는 해당 evidence files를 로컬에서 검토하고 새 signed observation을 만들며 기존 conflict record를 덮어쓰지 않는다.

### 3.12 기존 Spec·MCP·자문 경계

신규 `ObserverSpecAdapter`는 exact registry, verified version truth, eligible strategy lifecycle, complete status, provenance, method eligibility를 모두 만족한 observation만 기존 observed map으로 변환한다. LM-07 단독, unsigned LM-08, partial/conflict/unavailable는 key 자체를 생략해 evaluator가 `INDETERMINATE`를 반환하게 한다.

Spec join 순서는 다음으로 고정한다.

1. `registryDigest`가 일치하는 ADAPTERS identity에서 adapter product와 verified variant를 찾는다.
2. `productVariant`가 non-null이면 exact `specMappingByVariant[productVariant]`만 사용하고 default로 fallback하지 않는다. variant가 null일 때만 `defaultSpecMapping`을 사용한다. 선택값이 없으면 `SPEC_IDENTITY_MISMATCH`다.
3. verified `FirmwareTruthRecord`의 `specApplicability='verified'`와 `specVersion`을 확인한다.
4. `loadSpec(mapping.lookupCode, specVersion)`을 1회 호출한다. null이면 `SPEC_NOT_FOUND`이며 다른 product/version directory를 추측하지 않는다.
5. 반환된 `spec.product`가 `mapping.acceptedReturnedCodes`에 정확히 포함되는지 검증한 뒤에만 observed map을 평가한다. HCI lookup의 `HCI` 반환은 허용하지만 allowlist 밖의 product는 `SPEC_IDENTITY_MISMATCH`로 거부한다.

이 게이트는 **신규 observer→spec adapter 호출에만 적용**한다.

- 기존 `@sangfor/config-state`→spec 호출과 그 테스트는 변경하지 않는다.
- 기존 MCP 도구의 schema·결과·tool count 의미와 자문 플로우는 변경하지 않는다.
- resolver miss에서 정적 `api-first/webui-first/hybrid`를 `unverified_hint`로 표시하는 것은 신규 learning API 응답 metadata에만 해당한다.
- 기존 Product Adapter의 strategy 선택, `normalizeAutomationProduct()`, `getProductAdapter()`, `listProductAdapters()`, `discoverProductConsole()`, `collectProductConfig()`, advisor 출력에는 해당 downgrade를 적용하지 않는다.
- 기존 경로와 신규 경로의 회귀 테스트를 분리하고 기존 fixture snapshot이 byte-for-byte 또는 semantic-equality로 유지되는지 검증한다.

### 3.13 MCP 8개와 CLI 2개

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

list/resolve를 제외한 6개를 `WRITE_TOOLS`에 등록한다. 8개 모두 `destructiveHint:false`이며 device-write tool로 분류하지 않는다. WRITE_TOOLS 등록은 로컬 파일·세션 상태 변경을 승인 표면에 드러내기 위한 것이다.

CLI:

- 루트 script `strategy`는 `list`, `resolve`, `research`, `validate`, `approval-payload`, `approval-sign`, `promote`, `audit`, `mirror-sync` subcommand를 받는다.
- 루트 script `observe`는 `capture`, `collect`, `purge` subcommand를 받는다.
- smoke 예시는 `pnpm strategy -- list`와 `pnpm observe -- capture --fixture <path>`다.

`approval-sign`은 secret을 argv·stdout·로그에 노출하지 않고 secure input 또는 env에서 읽어 mode `0600` approval 파일만 만든다. Exit code는 `0 성공`, `2 입력 오류`, `3 precondition/resolution`, `4 보안·승인`, `5 store/mirror`, `6 capture/transport`, `7 partial/conflict/unavailable`로 고정한다.

PR-011은 위 명령을 사용하기 전에 `scripts/strategy-cli.ts`, `scripts/observe-cli.ts`를 만들고 루트 `package.json`에 `strategy`, `observe` script를 추가하며 각 script가 실제 CLI entrypoint를 가리키는 registration test를 함께 추가한다.

## 4. MUST 요구사항과 인수 기준

| REQ | P | 정상 인수 | 실패 인수 |
|---|---:|---|---|
| REQ-01 Product registry | P0 | ADAPTERS identity snapshot과 strict alias/variant/Spec mapping이 canonical code를 결정 | unknown·모호 alias·mapping/digest mismatch는 HCI fallback 없이 거부 |
| REQ-02 Version truth | P0 | verified truth record의 raw version·build·fingerprint·reviewed specVersion이 모두 일치 | candidate는 noneligible, conflict는 `VERSION_CONFLICT`; `3.0.98C/E` drift·missing·unreviewed spec은 Spec 입력 금지 |
| REQ-03 Catalog/DSL | P0 | LM-01~LM-08, LR-01~LR-04 recipe가 strict parse | 코드·shell·host·unknown key는 거부 |
| REQ-04 Local store | P0 | concurrent writer 후 generation과 모든 record 보존 | lock/CAS/corrupt 오류 시 write·resolve 중단 |
| REQ-05 Revision/lifecycle | P0 | immutable revision과 event fold가 허용 상태 산출 | 역전·skip·reactivation은 거부 |
| REQ-06 Approval reuse | P0 | shared primitive와 separate domain/secret으로 event 1회 생성 | execution gate regression, wrong domain·expired·replay는 상태 불변 |
| REQ-07 Resolver | P0 | default→capability→fact overlay가 deterministic | same-scope 중복과 invalid merged DSL은 ambiguous |
| REQ-08 Existing session/CDP | P0 | 소유 포트·시간창·열린 exact page 1개를 지키고 detach 후 browser 불변 | 9222·보호창·remote CDP·0/2+ page·credential field 거부 |
| REQ-09 Passive capture | P0 | XHR/fetch, DOM/ARIA, iframe/shadow, inbound stream 구조 수집 | unknown value, oversized item, unsafe action은 미저장 |
| REQ-10 Unified bundle | P0 | 최소화된 `capture-bundle.v1`만 opaque digest 파일명으로 `data/captures/*.enc`에 atomic promote되고 Git에서 ignore | missing key·bad tag·redaction failure·식별자 파일명·non-ignored path이면 final 파일 미생성 |
| REQ-11 LM-01 | P1 | 공식 same-origin GET/HEAD가 eligible fact 생성 | citation/endpoint/credential 부재 시 unavailable |
| REQ-12 LM-02 | P0 | 사용자 승인 전 synthetic fixture만 1회 replay | 실장비 facade의 모든 active replay를 거부 |
| REQ-13 LM-03 | P1 | loaded ExtJS store의 allowlisted field만 추출 | store 없음·load/sync 시도는 unavailable/blocked |
| REQ-14 LM-04 | P1 | unique selector의 허용 DOM/ARIA 값만 추출 | duplicate/hidden credential/mutation action 차단 |
| REQ-15 LM-05 | P1 | root 내 bounded JSON/CSV를 streaming parse | symlink·traversal·확장자·크기·timeout 위반 거부 |
| REQ-16 LM-06 | P1 | 기존 inbound WS/SSE frame의 허용 field만 추출 | send/create 시도 또는 malformed frame은 중단 |
| REQ-17 LM-07 | P1 | local ROI OCR가 typed, review-required 결과 생성 | provider 없음 또는 OCR-only 결과는 Spec 비적격 |
| REQ-18 LM-08 | P0 | signed typed human confirmation이 observation 확정 | unsigned·replayed·expired confirmation은 비적격 |
| REQ-19 Fact API | P0 | 모든 요청 fact가 네 상태 중 하나로 반환 | method stop condition과 원인이 안전한 오류로 반환 |
| REQ-20 Observer-only Spec gate | P0 | 신규 observer 경로에서 exact product variant→Spec code와 reviewed specVersion join 후 eligible+complete만 evaluator에 전달하고 기존 config-state→spec 회귀가 불변 | identity/version mapping miss와 no-match·partial·conflict·unavailable key는 생략해 `INDETERMINATE`; 기존 MCP·자문 결과 변화는 실패 |
| REQ-21 Research | P1 | LR-01~LR-04가 draft·benchmark·evidence gap 생성 | 공식 source 없는 후보는 승격 불가 |
| REQ-22 DB mirror | P1 | local event가 idempotent하게 PostgreSQL에 반영 | DB 장애 시 local 성공·outbox pending·explicit sync 실패 |
| REQ-23 MCP surface | P1 | 정확히 8개 신규 이름·schema·annotation 등록 | extra property와 secret field는 handler에서 거부 |
| REQ-24 CLI surface | P1 | 두 CLI의 명령·exit code·dry-run 계약 준수 | secret argv, implicit purge, ambiguous exit 금지 |
| REQ-25 Pilot state honesty | P0 | CC/IAG/FortiOS pilot manifest가 각각 `PASS`, `NOT_RUN`, `BLOCKED` 중 근거 있는 상태를 기록하고 외부 의존 부재를 자동 판별 | 접근·증적 부재를 PASS로 기록하거나 빈 상태·무근거 PASS를 허용하면 실패 |

## 5. 구현 순서와 검증

### 5.1 PR 그래프

모든 PR은 기본적으로 순차 실행한다. 공통 Change Budget은 직접 수정 ≤12파일, 신규 ≤8파일, production 논리 ≤500줄, Prisma migration ≤1개다. 초과 시 구현 전에 sub-PR로 분할한다.

| PR | 수직 결과 | 분해 상태 |
|---|---|---|
| PR-001 | ADAPTERS 파생 뷰, version truth 확장, shared approval primitive, exact identity·DSL·store·lifecycle·resolver | DETAIL 확정, 3개 sub-PR |
| PR-002 | draft→signed researched→exact resolve→fixture observation→신규 Spec adapter의 INDETERMINATE/PASS 경계 | SUB 확정 |
| PR-003 | LM-01 FortiOS synthetic fixture와 direct read-only facade | `DECOMPOSITION: PENDING — PR-002 실제 계약명 확인 후` |
| PR-004 | existing-CDP session, passive structural capture, T-H2 통합 encrypted bundle, `test:observer:e2e` | `DECOMPOSITION: PENDING — PR-003 facade 확정 후` |
| PR-005 | LM-02 synthetic fixture와 CC version-conflict fixture | `DECOMPOSITION: PENDING — capture 계약 및 사용자 결정 확인 후` |
| PR-006 | LM-03/LM-04와 IAG 13.0.120 fixtures | `DECOMPOSITION: PENDING — LR-03 framework probe 계약 확인 후` |
| PR-007 | LM-05 JSON/CSV와 LM-06 inbound stream | `DECOMPOSITION: PENDING — common method harness 확정 후` |
| PR-008 | LM-07 local ROI와 LM-08 signed confirmation | `DECOMPOSITION: PENDING — evidence eligibility 계약 확정 후` |
| PR-009 | LR-01~LR-04 research, benchmark, stale-candidate workflow | `DECOMPOSITION: PENDING — 8개 method 결과 모델 고정 후` |
| PR-010 | Prisma additive migration과 local outbox mirror | `DECOMPOSITION: PENDING — canonical schema 고정 후` |
| PR-011 | MCP 8개, CLI 2개, Product Adapter 조립과 기존 경로 회귀 격리 | `DECOMPOSITION: PENDING — 모든 domain service 완료 후` |
| PR-012 | mock/e2e/security hardening, runbook, autonomous acceptance | `DECOMPOSITION: PENDING — 최종 surface 고정 후` |

PR-004의 method 세부 분해는 PR-003 후 확정하지만 다음 보안 대상은 변경할 수 없다.

- MODIFY: `.gitignore` — `data/captures/**` local-only
- MODIFY: `package.json` — `test:observer:e2e` script
- CREATE: `packages/sangfor-collector/src/capture-bundle.ts`
- MODIFY: `packages/sangfor-collector/src/index.ts`
- MODIFY: `scripts/device-collect.ts`, `scripts/epp-diagnose.ts`, `scripts/cc-diagnose.ts`, `scripts/iag-diagnose.ts`
- CREATE: `packages/sangfor-observer/package.json`과 session/capture entrypoint
- CREATE: `scripts/test-observer-e2e.ts`
- CREATE: `tests/capture-bundle.test.ts`, `tests/capture-gitignore.test.ts`, observer CDP focused tests
- VERIFY: device-collect writer→EPP/CC/IAG diagnosis reader와 observer writer→동일 reader의 `capture-bundle.v1` round-trip, `git check-ignore -q data/captures/probe.enc`, E2E가 모두 exit code 0
- SYNC: PR-004가 PASS한 뒤 기존 T-H2 카드에 구현 커밋·검증 경로를 링크하며, 그 전에는 T-H2를 완료로 표시하지 않는다.

### 5.2 PR-001 상세

#### PR-001A — registry와 version truth

대상:

- MODIFY: `packages/sangfor-product-adapters/src/index.ts`
- MODIFY: `packages/sangfor-product-adapters/package.json`
- MODIFY: `packages/sangfor-version/src/index.ts`
- MODIFY: `data/version/requirements.json`
- CREATE: `packages/sangfor-learning-strategy/package.json`
- CREATE: `packages/sangfor-learning-strategy/src/contracts.ts`
- CREATE: `packages/sangfor-learning-strategy/src/index.ts`
- MODIFY: `tsconfig.json`
- CREATE: `tests/learning-registry-version.test.ts`

구현:

- `FORTIOS`, `IOSXE` read-only adapter entry와 `resolveProductAdapterStrict`
- ADAPTERS entry를 `{ identity, legacyAdapter }`로 감싸 vendor/spec metadata와 기존 public object shape를 분리
- identity의 legacy-alias superset, explicit `observerOnlyAliases`, product variant→Spec code mapping과 registry digest 포함
- `getProductRegistrySnapshot(): ProductRegistryView`
- legacy 4종 filter를 통한 `normalizeAutomationProduct`/`getProductAdapter`/`listProductAdapters` 결과 불변 회귀와 `CC`/`Athena XDR`/`A-Sec`의 기존 `HCI_SCP` 결과 고정
- L0 `@sangfor/shared.PRODUCTS`가 observer 정본으로 사용되지 않는 dependency test
- `FirmwareTruthRecord`, parser, candidate/conflict/verified/superseded transition
- learning contracts의 version type은 `@sangfor/version` import/re-export만 허용
- production seed의 CC `3.0.98`/`3.0.98C` conflict와 noneligible resolver
- verified happy-path는 production seed가 아니라 test temp root에 생성한 실파일 evidence fixture만 사용
- `parseFirmwareTruthRecord`, `sameFirmwareIdentity`, `canonicalizeFingerprintDescriptors`

#### PR-001B — shared approval primitive

대상:

- MODIFY: `packages/sangfor-approval/src/index.ts`
- MODIFY: `packages/sangfor-operator/src/approval.ts`
- MODIFY: `packages/sangfor-operator/src/nonce-store.ts`
- CREATE: `packages/sangfor-learning-strategy/src/approval.ts`
- CREATE: `tests/approval-primitives.test.ts`
- MODIFY: `tests/operator-approval.test.ts`
- MODIFY: `tests/operator-nonce-store.test.ts`
- MODIFY: `tests/operator-execution-gate.test.ts`
- VERIFY-ONLY: `tests/control-tower-approval-mint.test.ts`, `tests/http-bridge-approval-guard.test.ts`, `tests/control-tower-e2e.test.ts`

구현:

- `canonicalizeApprovalPayload`
- `signDomainApproval`
- `verifyDomainApprovalSignature`
- `FileSingleUseNonceStore`
- operator compatibility wrapper와 exact regression
- learning domain/secret/nonce path 분리
- HMAC success → nonce consume → event append 순서와 append-crash 시 nonce 재사용 거부
- cross-process lock·unique temp·fsync/rename과 동일 nonce child-process race에서 정확히 1회 성공

**FORBIDDEN:** execution approval gate의 public contract·env·payload·gate 순서·오류 의미 변경, `assertRealExecutionAllowed` 완화, operator nonce store 자동 초기화, secret fallback 추가. 단, `@sangfor/approval`의 위 공통 utility import·내부 위임과 single-use 보장을 위한 lock/fsync hardening은 허용한다.

#### PR-001C — DSL/store/lifecycle/resolver

대상:

- CREATE: `packages/sangfor-learning-strategy/src/methods.ts`
- CREATE: `packages/sangfor-learning-strategy/src/store.ts`
- CREATE: `packages/sangfor-learning-strategy/src/lifecycle.ts`
- CREATE: `packages/sangfor-learning-strategy/src/resolver.ts`
- MODIFY: `packages/sangfor-learning-strategy/src/index.ts`
- CREATE: `tests/learning-contracts.test.ts`
- CREATE: `tests/learning-store.test.ts`
- CREATE: `tests/learning-resolver.test.ts`

구현:

- strict LM/LR schema와 unknown-key 거부
- atomic commit, lock/CAS/fsync, immutable revision, lifecycle fold
- `strategy_field_verified`와 competency 비계상 경계
- registry digest와 version truth exact resolver
- corrupt generation, concurrent child process, invalid transition, ambiguous scope, near-version 배제

PR-001 검증:

```bash
pnpm exec vitest run --config vitest.config.ts \
  tests/learning-registry-version.test.ts \
  tests/approval-primitives.test.ts \
  tests/operator-approval.test.ts \
  tests/operator-nonce-store.test.ts \
  tests/operator-execution-gate.test.ts \
  tests/control-tower-approval-mint.test.ts \
  tests/http-bridge-approval-guard.test.ts \
  tests/control-tower-e2e.test.ts \
  tests/learning-contracts.test.ts \
  tests/learning-store.test.ts \
  tests/learning-resolver.test.ts
pnpm run lint
pnpm run build
pnpm test
```

모든 명령 exit code 0, 기존 version·Product Adapter·operator approval/nonce tests 불변, 사용자 변경 미접촉이 완료 조건이다.

### 5.3 PR-002 vertical slice

대상:

- CREATE: `packages/sangfor-learning-strategy/src/fact-service.ts`
- MODIFY: `packages/sangfor-learning-strategy/src/index.ts`
- CREATE: `packages/sangfor-product-adapters/src/observer-spec-adapter.ts`
- MODIFY: `packages/sangfor-product-adapters/src/index.ts`
- MODIFY: `packages/sangfor-product-adapters/package.json`
- CREATE: `tests/fixtures/learning-strategies/researched.json`
- CREATE: `tests/fixtures/learning-strategies/lab-verified.json`
- CREATE: `tests/learning-spec-adapter.test.ts`

1. L3가 ADAPTERS identity snapshot을 L1 resolver에 주입한다.
2. `ObserverSpecAdapter`가 exact product variant→Spec product code와 verified `specVersion`을 resolve한 뒤 `FactQueryResult`의 complete+eligible만 observed map으로 변환한다.
3. `researched` fixture는 resolve되어도 신규 adapter 경로에서 Spec `INDETERMINATE`를 만든다.
4. signed `lab_verified` fixture는 동일 fact를 신규 adapter 경로에서 Spec PASS 경계까지 전달한다.
5. partial/conflict/LM-07-only/unsigned-LM-08/near-version regression을 추가한다.
6. `IOSXE→CISCO_IOSXE`, Cyber Command `NDR→CYBER_COMMAND`, `HCI_SCP` lookup→`HCI` accepted return, `ENDPOINT_SECURE→ENDPOINT_SECURE` join과 allowlist 밖 반환·mapping/version miss fail-closed를 테스트한다.
7. 기존 config-state→spec와 기존 advisor snapshot은 변경 전과 동일해야 한다.

### 5.4 PR-005 LM-02 사용자 승인 게이트

PR-005의 기본 산출물은 synthetic mock server와 fixture interpreter뿐이다.

- real-device `ReadOnlyFacade`에는 LM-02 transport method를 구현하지 않는다.
- recipe가 LM-02를 포함해도 synthetic adapter가 아니면 `ACTIVE_REPLAY_NOT_APPROVED`를 반환한다.
- Browser E2E는 synthetic mock에서 GET/HEAD와 allowlisted read-only POST가 정확히 1회이고 PUT/PATCH/DELETE·retry가 0임을 검증한다.
- 사용자 결정표 U-02가 명시 승인으로 바뀌기 전 실장비 endpoint·body·header capture를 recipe로 승격하지 않는다.
- 승인 후에도 공식 API 또는 사용권한이 확인된 endpoint만 별도 후속 PR에서 구현한다. 비공식 XHR API discovery는 계속 drop 상태다.
- 승인 후 후속 PR에는 per-run human HMAC, exact endpoint template, mutation detector, before/after invariant, vendor citation이 모두 필요하다.

### 5.5 자동 검증

- Unit:
  - ADAPTERS snapshot/alias/drift, version C/E/build/hotfix/conflict
  - overlay, lifecycle, approval domain/replay, evidence file eligibility
  - 모든 LM-01~LM-08 synthetic fixture와 실패 경로
  - redaction·AES-GCM known vector·wrong key/tag
  - streaming parser 한도와 timeout
- Integration:
  - multi-process lock/CAS와 corrupt recovery
  - method chain·conflict·LM-08 adjudication
  - T-H2 reader와 observer writer의 `capture-bundle.v1` round-trip
  - opaque deviceScopeDigest filename과 `data/captures/**` Git ignore
  - mirror idempotency·retry·DLQ
  - 신규 Fact→Spec PASS/INDETERMINATE 경계와 기존 config-state→spec 불변
- Browser E2E:
  - 외부 Chromium/CDP page count·URL·PID·생존 불변
  - 선택 origin의 CDP DOMStorage mutation event 0과 mock mutation endpoint 0회
  - 9222, 보호창, 0/2+ page, remote CDP, origin mismatch 거부
  - mock write endpoint 호출 수 0
  - LM-02는 synthetic allowlisted request만 1회, LM-03/04/06 금지행위 0
  - PR-004가 `scripts/test-observer-e2e.ts`와 루트 `package.json`의 `test:observer:e2e` script를 먼저 추가하며, `pnpm run test:observer:e2e` exit code 0이 필수
- MCP/CLI:
  - 구현 직전 baseline `N`을 재측정하고 정확히 `N+8`
  - 기준선이 유지되면 77→85개
  - exact tool name·schema·annotation registration test
  - WRITE_TOOLS 6개와 `destructiveHint:false` 회귀
  - 모든 CLI exit code와 purge dry-run
- Full gate:

```bash
pnpm test
pnpm run lint
pnpm run build
pnpm run test:observer:e2e
pnpm run smoke:mcp
```

다섯 명령은 모두 exit code 0이어야 하며 E2E summary는 forbidden CDP attach 0, DOMStorage mutation event 0, mock mutation endpoint 증가 0을 출력해야 한다.

### 5.6 MANUAL 실증

1. CC
   - M2 버전 진실표 절차로 `3.0.98`과 `3.0.98C` 중 exact raw 값을 다시 확정한다.
   - 사람이 로그인·콘솔 조작하고 agent는 passive capture와 승인된 recipe read만 수행한다.
   - LM-02 사용자 승인이 없으면 passive/LM-03/LM-04/LM-06/LM-08 범위만 사용한다.
   - 현재 CC keymap의 모든 fact를 pilot manifest로 고정한다.
   - 성공 1회, 실파일 evidence, 사람 HMAC 후 `strategy_field_verified`로 승격한다.
   - competency 계상은 M2가 해당 WorkAtom을 별도로 `field_verified` 승격한 뒤에만 발생한다.
2. IAG
   - `13.0.120`과 fingerprint를 진실표 절차로 재확인한다.
   - LR-03으로 실제 framework를 확인하며 ExtJS를 사전 가정하지 않는다.
   - 현재 IAG 13.0.120 spec의 observed key를 pilot manifest로 고정한다.
   - 성공 1회, 실파일 evidence, 사람 HMAC 후 `strategy_field_verified`로 승격한다.
3. FortiOS
   - 현재 7.2.0 mock과 8.0 seed를 실제 증적으로 사용하지 않는다.
   - 공식 FortiOS 8.0 source와 실제 8.0 lab VM/appliance의 LM-01 결과가 필요하다.
   - actual lab evidence와 사람 HMAC 후에만 `lab_verified`로 승격한다.

VPN, 장비, CDP, key, 실제 PostgreSQL이 없으면 해당 단계는 `NOT_RUN/BLOCKED`로 기록한다. 이는 CI 실패나 PASS로 변환하지 않는다.

### 5.7 REQ 추적표

REQ 표의 각 정상 인수는 `Given: 해당 정본·선행 상태`, `When: 명시된 operation 실행`, `Then: 정상 인수 결과`로, 실패 인수는 같은 operation에 표의 위반 입력을 넣었을 때의 fail-closed `Then`으로 테스트한다.

| REQ | 구현 PR/SUB | 자동 검증 |
|---|---|---|
| REQ-01 | PR-001A registry snapshot/strict resolver | `learning-registry-version.test.ts`: legacy shape·alias/variant·Spec mapping·unknown·ambiguous·digest drift |
| REQ-02 | PR-001A version truth | `learning-registry-version.test.ts`: candidate/conflict/verified/superseded·C/E/build·specVersion applicability |
| REQ-03 | PR-001C method contracts | `learning-contracts.test.ts`: LM/LR parse·unknown key·code injection 거부 |
| REQ-04 | PR-001C store | `learning-store.test.ts`: process lock·CAS·corrupt file |
| REQ-05 | PR-001C lifecycle | `learning-store.test.ts`: 허용 전이·skip·reactivation |
| REQ-06 | PR-001B approval primitives | `approval-primitives.test.ts` + 기존 operator approval/nonce tests |
| REQ-07 | PR-001C resolver | `learning-resolver.test.ts`: overlay·중복 scope·near-version |
| REQ-08 | PR-004 CDP session | observer unit + external Chromium E2E: port/window/page/invariant |
| REQ-09 | PR-004 passive capture | observer capture integration: allowlist·oversize·unsafe action |
| REQ-10 | PR-004 unified bundle | collector round-trip·redaction canary·wrong key/tag·opaque filename·atomic promote·`git check-ignore` |
| REQ-11 | PR-003 LM-01 | official GET/HEAD synthetic integration |
| REQ-12 | PR-005 LM-02 | synthetic 1회 요청 + real facade `ACTIVE_REPLAY_NOT_APPROVED` |
| REQ-13~14 | PR-006 LM-03/LM-04 | ExtJS loaded-store와 DOM/ARIA fixture, mutation trap |
| REQ-15~16 | PR-007 LM-05/LM-06 | bounded streaming import와 inbound-only stream fixture |
| REQ-17~18 | PR-008 LM-07/LM-08 | OCR review-required와 signed confirmation replay |
| REQ-19 | PR-002 Fact API slice | 모든 requested fact의 complete/partial/conflict/unavailable coverage |
| REQ-20 | PR-002 ObserverSpecAdapter | product variant→Spec code/specVersion join, mapping miss와 신규 PASS/INDETERMINATE + 기존 config-state/advisor 회귀 |
| REQ-21 | PR-009 LR workflow | official citation·benchmark·evidence-gap·stale-candidate |
| REQ-22 | PR-010 mirror | outbox idempotency·retry·DLQ·DB-down local success |
| REQ-23~24 | PR-011 MCP/CLI | exact registration·WRITE_TOOLS·schema·exit code·purge dry-run |
| REQ-25 | PR-012 acceptance | pilot manifest schema·evidence 검증·외부 의존 probe와 PASS/NOT_RUN/BLOCKED 분리 |

### 5.8 파일 소유권과 복구

PR은 순차 수행하며 다음 ownership을 지킨다.

| 파일군 | 쓰기 owner | 후속 수정 |
|---|---|---|
| `packages/sangfor-product-adapters/src/index.ts` | PR-001A | PR-002는 `ObserverSpecAdapter` export/composition만, PR-011은 MCP/App 조립 export만 추가하며 strict resolver semantics와 legacy API를 변경하지 않는다. |
| `packages/sangfor-product-adapters/package.json` | PR-001A | PR-001A는 learning type dependency, PR-002는 Spec adapter dependency만 추가하고 PR-011은 변경하지 않는다. |
| `packages/sangfor-version/**`, `data/version/requirements.json` | PR-001A | 후속 PR은 read-only 소비만 한다. 값 승격은 M2 truth PR로 분리한다. |
| `tsconfig.json`의 `@sangfor/learning-strategy` alias | PR-001A | 후속 PR은 새 package alias를 변경하지 않는다. |
| `packages/sangfor-approval/**`, operator approval/nonce files | PR-001B | 후속 PR은 public primitive import만 한다. |
| `packages/sangfor-learning-strategy/**` | PR-001A/B/C | PR-002~009는 각 기능별 새 module을 추가하고 선행 contract 변경 시 먼저 compatibility test를 갱신한다. |
| `packages/sangfor-observer/**` | PR-004 | PR-005~008은 method driver만 추가한다. |
| `packages/sangfor-collector/src/capture-bundle.ts`, collector export | PR-004 | T-H2와 observer가 공유하는 유일 bundle 계약이며 다른 PR은 별도 envelope를 만들지 않는다. |
| `scripts/device-collect.ts`, `scripts/{epp,cc,iag}-diagnose.ts` bundle I/O | PR-004 | PR-004가 writer와 diagnosis reader를 함께 구현하며 후속 PR은 read-only 소비만 한다. |
| `.gitignore`의 `data/captures/**` rule | PR-004 | 후속 PR은 ignore 예외·강제 add를 만들지 않는다. |
| `prisma/schema.prisma`, migration 1개 | PR-010 | 다른 PR은 Prisma schema를 수정하지 않는다. |
| 루트 `package.json`의 `test:observer:e2e` | PR-004 | PR-012는 script 의미를 변경하지 않고 최종 gate에서 호출한다. |
| MCP registration, 루트 `package.json`의 `strategy`/`observe` scripts | PR-011 | PR-012는 registration test/runbook만 수정한다. |

복구 원칙:

- additive API·JSON schema는 기존 reader 호환을 유지한다. regression 발생 시 신규 observer composition을 disable하고 기존 config-state/advisor 경로를 유지한다.
- version truth schema reader는 기존 version 1 requirement를 계속 읽는다. 새 `firmwareTruth`가 없으면 observer만 `VERSION_TRUTH_UNAVAILABLE`로 거부한다.
- approval 공통화는 operator 외부 contract와 nonce file schema를 바꾸지 않는다. regression이면 wrapper 내부를 기존 구현으로 되돌릴 수 있으며 learning promotion은 계속 fail-closed다.
- Prisma migration은 additive·nullable table/column만 허용한다. DB 문제 시 mirror worker를 중지하고 로컬 정본과 outbox를 보존하며 destructive down migration이나 자동 rollback을 실행하지 않는다.
- `capture-bundle.v1` writer 문제 시 신규 capture를 중지하고 기존 encrypted bundle은 보존한다. 검증되지 않은 bundle 삭제·복호화 재저장은 하지 않는다.

### 5.9 알려진 조정 지점

| 관측 지점 | 현재 근거 | 질문 없이 적용할 조정 | 중단 조건 |
|---|---|---|---|
| Spec package 이름 | tsconfig import는 `@sangfor/spec`, manifest는 `@sangfor-engineer/sangfor-spec` | 기존 import alias와 workspace dependency 관례를 실제 consumer별로 유지 | dependency 방향이 L1→L3로 역전되는 경우 |
| `packages/sangfor-store` | source는 있으나 package manifest가 없음 | 새 persistence package로 오인하지 않고 learning store는 자체 L1 module로 둠 | 별도 package 신설이 필요해 Change Budget을 넘는 경우 |
| Product Adapter legacy fallback | unknown이 현재 HCI_SCP로 귀결 | 기존 function은 불변, 신규 strict resolver만 observer에 사용 | 기존 caller 결과가 바뀌는 경우 |
| IAG UI framework | 현재 미확인 | PR-006 전에 LR-03 fixture/probe로 ExtJS/DOM adapter를 선택 | probe가 mutation을 요구하는 경우 |
| CC raw version | roadmap `3.0.98`과 기존 diagnosis 내부 관측 `3.0.98C` 상충 | 둘 다 noneligible conflict로 이관하고 3.3 절의 두 독립 read·M2 review 후 하나만 verified 승격 | 값 불일치·evidence file 부재 |
| FortiOS lab | 8.0 spec은 있으나 actual lab 미확보 | synthetic/official-source까지만 구현 | U-03 없이 `lab_verified` 요구 |
| Playwright/Prisma version | lockfile·CLI 결과가 구현 시점 정본 | PR 시작 시 lockfile과 generated migration을 읽어 지원 API를 선택 | dependency 추가·major upgrade 필요 |
| MCP baseline | 계획 작성 시 77 tools | PR-011 시작 시 `smoke:mcp`로 N 재측정 후 N+8 검증 | 기존 tool 감소·schema regression |
| diagnosis evidence commit | U-08 미결 | local 실파일로만 검증하고 stage하지 않음 | remote 공유·커밋이 필요한 경우 |

### 5.10 PR-001A 실행 카드

```text
TASK: PR-001A — ADAPTERS-derived product identity and version-truth extension
GOAL: ADAPTERS를 유일 product 정본으로 유지하면서 strict observer snapshot을 만들고,
      기존 @sangfor/version + data/version/requirements.json에 exact firmware truth를 additive하게 확장한다.
CREATE: packages/sangfor-learning-strategy/package.json
        packages/sangfor-learning-strategy/src/contracts.ts
        packages/sangfor-learning-strategy/src/index.ts
        tests/learning-registry-version.test.ts
MODIFY: packages/sangfor-product-adapters/src/index.ts
        packages/sangfor-product-adapters/package.json
        packages/sangfor-version/src/index.ts
        data/version/requirements.json
        tsconfig.json
FORBIDDEN: legacy normalizeAutomationProduct/getProductAdapter/listProductAdapters 결과·순서·개수 변경,
           @sangfor/shared.PRODUCTS를 observer identity 정본으로 사용, L1→L3 import,
           CC 3.0.98/3.0.98C production verified seed 생성, 기존 advisor compareVersions 의미 변경
ACCEPT: ADAPTERS snapshot digest/alias mapping과 version truth state가 strict parse되고,
        strict resolver의 unknown·ambiguous·registry drift와 CC conflict가 fail-closed이며,
        legacy 4종 API와 기존 advisor 회귀가 모두 통과한다.
VERIFY: focused vitest → pnpm run lint → pnpm run build → pnpm test, 모두 exit 0.
STOP: package layering 역전, 사용자 파일 충돌, Change Budget 초과, 기존 Product Adapter/advisor regression이면 중단하고 증거를 보고한다.
```

## 6. 위험과 복구

| 위험 | 점수 | 예방 | 복구 |
|---|---:|---|---|
| secret/PII 캡처 | 4×5×4=80, R4 | allowlist 최소화, hard-deny, local encryption, canary leak test | bundle purge, key rotation, incident record |
| LM-02가 장비를 변경 | 3×5×4=60, R3 | 사용자 승인 전 synthetic-only, 후속 PR의 exact recipe·HMAC·mutation detector | 즉시 중단·stale 처리, 자동 rollback 금지 |
| 잘못된 identity로 false PASS | 3×5×4=60, R3 | ADAPTERS digest와 verified version truth exact match | observation 폐기, truth conflict 해소, 새 revision 작성 |
| approval replay/위조 | 2×5×4=40, R3 | shared constant-time HMAC, separate domain/secret, durable nonce | secret rotation, event audit |
| concurrent store 손상 | 3×4×3=36, R3 | lock/CAS/fsync/content hash | fail-closed, immutable record 기반 repair |
| OCR/human 결과 false PASS | 3×5×4=60, R3 | LM-07 단독 비적격, signed LM-08 | fact를 conflict/INDETERMINATE로 재평가 |
| 외부 browser/야간 자동화 간섭 | 2×4×4=32, R2 | 포트 소유권, 보호창, exact page와 before/after invariant | detach, session invalidation, run 폐기 |
| capture 포맷 분기 | 3×4×3=36, R3 | `capture-bundle.v1` 단일 schema와 cross-reader test | staging 폐기, canonical writer로 재캡처 |
| DB mirror divergence | 3×3×3=27, R2 | outbox, idempotent receipt, DLQ | explicit mirror-sync와 audit |

## 7. 미해결 사용자 결정과 외부 블로커

안전한 기본값은 사용자 결정 전 자동으로 적용되는 제한이다.

| ID | 출처 | 결정·블로커 | 권고·선택지 | 결정 전 안전한 기본값 | 차단 범위 |
|---|---|---|---|---|---|
| U-01 | 신규/R1 | 로드맵 슬롯 확정 | **M2 병렬 M2-LSO 권고** 또는 M5 선행 트랙 | 로드맵 정본 미수정, 계획만 Active | 일정·owner 링크만 차단, 설계 검증은 가능 |
| U-02 | 신규/R6 | LM-02 실장비 GET/HEAD/read-only POST 능동 replay 허용 여부 | 공식·허가 endpoint에 한정한 별도 승인 또는 계속 금지 | synthetic fixture만 구현, 실장비 facade fail-closed | LM-02 live transport와 pilot |
| U-03 | 신규/R11 | FortiOS 8.0 실랩 VM/appliance 확보 | 격리된 lab target과 접근창 제공 | synthetic·공식문서 연구까지만, `lab_verified` 금지 | FortiOS actual-lab 수용 기준 |
| U-04 | 신규/R11 | `SANGFOR_LEARNING_APPROVAL_SECRET`·`SANGFOR_CAPTURE_BUNDLE_KEYS` 생성·보관·rotation 절차 | macOS Keychain/조직 secret manager에서 생성·주입, repo/.env/로그 금지 | 테스트 ephemeral key만, live capture·promotion fail-closed | 실장비 bundle 생성과 lifecycle promotion |
| U-05 | 기존 roadmap #1 | cinder-enabled SCP 확보 | volumev2가 있는 별도 lab/SCP | 현 503 대상에 write 금지 | M3 create-volume만 차단, 본 계획과 무관 |
| U-06 | 기존 roadmap #2 | git history의 랩 비밀번호 rewrite | BFG/filter-repo 시행 여부 별도 승인 | history rewrite·force push 금지 | 과거 secret 정리만 차단 |
| U-07 | 기존 roadmap #3 | tech-debt-tracker 정책 | `docs/TECH-DEBT.md` 승격 또는 링크 제거 | 현재 파일·링크 유지 | tech-debt 문서 정합성만 차단 |
| U-08 | 기존 roadmap #4 | `outputs/diagnosis` 커밋 정책 | sanitized evidence만 선별 커밋 또는 전부 local-only | 신규 실장비 output을 stage/commit하지 않음 | evidence 배포·공유 정책만 차단, 로컬 실파일 검증은 가능 |
| U-09 | 기존 roadmap #5 | 실장비 write 시점별 사람 승인 | M3 create-volume 등 각 write run마다 action-bound 서명 승인 | 실장비 write 전면 금지 | M3 write 트랙만 차단하며 read-only인 본 계획 구현에는 영향 없음 |

U-02, U-03, U-04, U-09가 미해결이어도 PR-001~004의 synthetic·local 기반 구현은 진행할 수 있다. 다만 실장비 replay, FortiOS lab 승격, live encrypted capture/promotion은 각각의 결정 없이 PASS로 보고하지 않으며 U-09 결정 없이 M3 등 외부 write를 실행하지 않는다.

## 8. 완료 판정

다음 조건을 모두 만족해야 **코드 구축 완료**다.

- REQ-01~REQ-24의 정상·실패 인수와 REQ-25의 pilot manifest PASS/NOT_RUN/BLOCKED 정직성 자동 테스트가 통과한다. 실제 pilot maturity 달성은 아래 실증 완료 조건으로 분리한다.
- 전체 test/lint/build/smoke가 통과하고 기존 skip 수가 늘지 않는다.
- 신규 MCP 도구가 정확히 8개이며 이름·schema·annotation·WRITE_TOOLS 등록이 계약과 일치한다.
- ADAPTERS 정본과 L1 파생 뷰 불일치가 fail-closed로 검증된다.
- `FirmwareIdentity`가 verified version truth record에서만 유도되고 별도 identity 저장소가 없다.
- 기존 operator approval gate의 public behavior와 기존 config-state→spec·MCP·자문 회귀가 불변이다.
- `strategy_field_verified`가 competency `field_verified`로 자동 계상되지 않는다.
- competency 승격 테스트는 digest가 아니라 존재하는 evidence 실파일을 요구한다.
- secret canary가 로그, 파일 DB, decrypted test bundle, DB mirror 어디에도 남지 않는다.
- browser E2E에서 포트·시간창·page count·URL·browser 생존이 불변이고 mock device write 수가 0이다.
- PR-004가 새로 구현한 T-H2 device-collect writer·EPP/CC/IAG diagnosis reader와 observer writer가 같은 `capture-bundle.v1`을 round-trip한다.
- final capture filename에 장비 식별자가 없고 `data/captures/**`가 Git에서 ignore된다.
- local canonical store가 DB 장애와 concurrent writer 상황에서도 보존된다.
- 사용자 소유 PPTX·기존 출력 변경이 그대로 보존된다.

다음은 **실증 완료**의 별도 조건이다.

- CC/IAG는 `strategy_field_verified`, FortiOS는 actual-lab `lab_verified` evidence를 갖는다.
- M2가 선택한 competency WorkAtom만 실파일 evidence와 함께 별도 `field_verified`로 승격한다.
- 외부 접근이나 사용자 결정이 없어 미실행이면 전체 결과를 `코드 구축 완료 / 실증 BLOCKED`로 분리 보고한다.
- approval 없는 push·merge·배포는 수행하지 않는다.

## 9. 실행 체크포인트

### CHECKPOINT — 2026-07-23 계획 충돌 동기화

- **Baseline:** `ec2a882` (`docs(plan): add firmware learning strategy observer build plan`)
- **Current:** working tree의 본 개정판
- **REQ 상태:** REQ-01~REQ-25 모두 구현 전 `PENDING`; 이번 변경은 계획 문서만 개정한다.
- **Drift 판정:** 기존 계획의 독립 product registry, 독립 firmware model, 전략 `field_verified`, 중복 approval stack, live LM-02, CDP·capture 경계 누락을 현재 로드맵·코드 계약에 맞게 해소했다.
- **다음 작업:** 사용자 편입 결정을 기록한 뒤 PR-001A registry/version truth부터 시작한다.
- **다음 검증:** PR-001A focused tests → lint → build → full test 순서로 실행한다.

### CHECKPOINT — 2026-07-23 독립 Claude 검증 보정

- **Baseline:** `0fe0336` (`docs(plan): reconcile learning observer with roadmap`)
- **Current:** 독립 Claude 검증 findings를 반영한 working tree 개정판
- **REQ 상태:** REQ-01~REQ-25 모두 구현 전 `PENDING`; 문서 계약만 재동기화한다.
- **Drift 판정:** strict observer alias와 legacy alias 동결의 숨은 충돌, 미구현 T-H2의 reader 소유권, 로드맵 §9 결정 5번, 비정본 L4 명칭을 보정했다.
- **검증 안전성:** 현재 dirty checkout의 `pnpm test`가 사용자 PPTX를 재생성한 사고를 기록하고, 전체 실행 게이트를 clean implementation worktree로 한정했다.
- **다음 작업:** plan machine check와 diff 검사 후 계획서만 커밋하고 같은 Claude 세션에 재검토를 요청한다.

### CHECKPOINT — 2026-07-24 PR-001A 완료

- **Baseline:** `3d09d02` (`docs(plan): record independent approval`)
- **Current:** `b844937` (`fix(learning): close route and nested registry access gaps`)
- **REQ 상태:** REQ-01과 REQ-02의 synthetic/local 코드 계약을 `PASS`로 전환한다. M2 실장비 재실측과 production verified seed 승격은 계속 `PENDING`이다.
- **구현 결과:** ADAPTERS 파생 identity snapshot·strict resolver·digest, legacy API 불변 계약, version truth 확장, evidence confinement, domain-separated firmware fingerprint, CC conflict seed를 구현했다.
- **변경 예산:** 10개 카드 모두 변경 파일 12개 이하, 신규 파일 8개 이하, production 추가 500줄 이하를 충족한다. 승인된 코드 트리를 유지하면서 최초 대형 커밋을 `06b8e9e`와 `88cb89c`로 분리했다.
- **검증:** focused Vitest 5 files/29 tests, lint, build, full Vitest 74 files passed·1 skipped/451 tests passed·2 skipped, `smoke:mcp` 77 tools, `git diff --check`가 통과했다.
- **독립 검토:** Ultra 적대적 코드·예산 재검토 결과 **CRITICAL 0 / HIGH 0 / MEDIUM 0 — APPROVE**다.
- **격리 안전성:** 전체 테스트가 task-owned clean worktree에서 재생성한 PPTX만 targeted restore했으며, 원본 checkout의 사용자 PPTX와 live output은 수정하지 않았다. 별도 개발 worktree의 전체 회귀에서 `127.0.0.1:3001` 일시 점유로 1회 실패했으나 즉시 포트가 해제된 뒤 동일 명령이 451 tests로 통과했고, 최종 통합 worktree 검증은 첫 실행에 통과했다.
- **다음 작업:** PR-001B shared approval primitive를 실행하되 execution approval public contract·환경변수·payload·gate 순서·오류 의미를 동결한다.

### CHECKPOINT — 2026-07-25 PR-001B 완료

- **Baseline:** `1126ec2` (`docs(plan): checkpoint PR-001A implementation`)
- **Current:** `17e1570` (`feat(approval): add shared domain approval primitives`)
- **REQ 상태:** REQ-06 approval primitives `PASS`. Operator execution gate public contract·환경변수·payload·gate 순서·오류 의미 동결 확인.
- **구현 결과:** 공통 `canonicalizeApprovalPayload`, `signDomainApproval`, `verifyDomainApprovalSignature`, `FileSingleUseNonceStore` in `@sangfor/approval`. Operator 호환 wrapper byte-for-byte 보존. Learning adapter `learning-strategy-v1` domain, strict base64 32-byte secret, lowercase 64-hex signature, typed error codes, isolated env/nonce path. Cross-process nonce race 테스트 (동일 nonce 2개 child process → 정확히 1개 성공), distinct nonce 동시 소비, fsync/rename 실패 fail-closed, malformed JSON record fail-closed, canonical newline collision 거부, event append 실패 시 state 불변·nonce 소비 유지.
- **검증:** focused 7 files/60 tests, lint, build, full 75 files/472 tests, smoke:mcp 77 tools 모두 통과.
- **다음 작업:** PR-001A H1-H5 보정 (vendor/variant truth binding, specVersion traversal, deep accessor TOCTOU) 및 spec-loader 경로 보안 커밋.

### CHECKPOINT — 2026-07-25 PR-001C 완료

- **Baseline:** `16f6991` (`docs(plan): checkpoint PR-001B implementation`)
- **Current:** `14537fa` (`feat(learning): add DSL/store/lifecycle/resolver`)
- **REQ 상태:** PR-001C DSL/store/lifecycle/resolver `PASS`.
- **구현 결과:** strict LM-01~LM-08/LR-01~LR-04 method schemas with unknown-key rejection, atomic commit with lock/CAS/fsync, immutable revision history, lifecycle fold with `strategy_field_verified` vs competency non-counting boundary, registry digest and version truth exact resolver (no near-version fallback).
- **검증:** focused 3 files/53 tests, lint, build, full 78 files/525 tests, smoke:mcp 77 tools 모두 통과.
- **다음 작업:** PR-002 vertical slice (Fact service, ObserverSpecAdapter, fixtures).

## 10. 검토 기록

- 원안 적대적 검토: 최종 CRITICAL 0 / HIGH 0
- 기존 계획 체계 충돌 검토: Claude R1~R12 지적 수용
- 개정판 검토 기준: `plan-review` machine check, security/correctness/architecture/operability/verification/dependency 전 항목, 독립 적대적 재검토
- 개정판 적대적 검토 1차: **CRITICAL 0 / HIGH 5 / MEDIUM 3 — NOT APPROVED**

| Finding | 조치 |
|---|---|
| H-01 legacy normalizer와 observer ADAPTERS 확장 충돌 | legacy 4종 union/filter/API를 고정하고 6종 strict snapshot만 별도 소비하며 `@sangfor/shared.PRODUCTS`를 observer 비정본으로 명시했다. |
| H-02 CC version premature verified | 기존 diagnosis의 `3.0.98C` 관측을 반영해 `3.0.98`/`3.0.98C`를 모두 conflict·noneligible로 이관하고 M2 재실측 전 production verified seed를 금지했다. |
| H-03 approval primitive 계약·순서 누락 | canonical byte/field 순서, key policy 분리, signature/error 계약, HMAC→nonce consume→event append와 crash fail-closed를 고정했다. |
| H-04 코드 완료와 실증 완료 모순 | REQ-25를 pilot 상태 정직성 자동 게이트로 바꾸고 실제 maturity는 별도 실증 완료 조건으로 분리했다. |
| H-05 Browser E2E 실행 게이트 누락 | CDP DOMStorage event·mock mutation counter를 정의하고 PR-004의 `test:observer:e2e` script와 full gate 호출을 의무화했다. |
| M-01 실제 Product Adapter symbol 불일치 | `collectProductConfig()`와 legacy normalize/get/list/discover symbol로 회귀 대상을 교정했다. |
| M-02 보호창 시간 불일치 | 변경 요약과 본문을 모두 01:30~04:15 Asia/Seoul로 통일했다. |
| M-03 conflict provenance 부족 | discriminated `FactObservation`과 최소 2개 `conflictCandidates`의 method/revision/value digest/evidence/time 계약을 추가했다. |

- 개정판 적대적 검토 2차: **CRITICAL 0 / HIGH 4 / MEDIUM 3 — NOT APPROVED**

| Finding | 조치 |
|---|---|
| H2-01 identity metadata가 legacy 반환 shape를 변경 | ADAPTERS entry를 `{ identity, legacyAdapter }`로 분리하고 legacy 함수는 현행 shape의 4개 `legacyAdapter`만 반환하도록 고정했다. |
| H2-02 adapter code→Spec code/version join 누락 | identity digest에 default/variant Spec mapping을 추가하고 `IOSXE→CISCO_IOSXE`, Cyber Command `NDR→CYBER_COMMAND`, HCI/EPP fallback과 reviewed `specVersion` join을 fail-closed로 정의했다. |
| H2-03 version/learning product type cycle | version record는 non-empty string을 저장하고 learning resolver가 주입된 ADAPTERS view 검증 후에만 branded code로 좁히도록 명시했다. |
| H2-04 nonce store cross-process race | atomic lock directory, unique temp, file/directory fsync와 동일 nonce child-process 경쟁 테스트를 공통 store 필수 계약으로 추가했다. |
| M2-01 operator uppercase hex 호환 | 공통 verifier는 bytes를 받고 operator가 legacy hex decode를 유지하며 learning adapter만 lowercase 64-hex를 강제하도록 분리했다. |
| M2-02 Product Adapter 파일 ownership 누락 | PR-002 observer adapter export와 PR-011 app registration의 허용 후속 수정을 ownership 표에 추가했다. |
| M2-03 REQ-02 conflict 누락 | candidate는 noneligible, conflict는 `VERSION_CONFLICT`이며 둘 다 Spec 입력 금지로 실패 인수를 명문화했다. |

- 개정판 적대적 검토 3차: **CRITICAL 0 / HIGH 1 / MEDIUM 2 — NOT APPROVED**

| Finding | 조치 |
|---|---|
| H3-01 encrypted capture의 Git 오포함 위험 | 최종 filename을 비식별 `deviceScopeDigest`로 고정하고 `.gitignore`의 `data/captures/**`, force-add 금지, `git check-ignore` 회귀를 PR-004와 완료 조건에 추가했다. |
| M3-01 Spec 반환 product 검증 allowlist 누락 | `SpecProductMapping`에 `lookupCode`와 `acceptedReturnedCodes`를 분리하고 HCI lookup이 `HCI`를 반환하는 현행을 포함한 정확한 allowlist 및 범위 밖 반환 거부 테스트를 추가했다. |
| M3-02 operator approval 회귀 테스트 경로 불명확 | PR-001B의 MODIFY/VERIFY-ONLY 테스트 경로를 명시하고 PR-001 focused gate에 기존 operator·control-tower·http-bridge 테스트 6개를 직접 포함했다. |

- 개정판 적대적 검토 4차: **CRITICAL 0 / HIGH 0 / MEDIUM 0 — APPROVE**

- 독립 Claude 검토 5차: **CRITICAL 0 / HIGH 1 / MEDIUM 3 — NOT APPROVED**

| Finding | 조치 |
|---|---|
| H5-01 strict observer alias와 legacy alias 동결 모순 | legacy alias를 identity alias의 부분집합으로 바꾸고 `observerOnlyAliases` 차집합을 명시했으며 `CC`·`Athena XDR`·`A-Sec`의 legacy `HCI_SCP` 결과 회귀를 고정했다. |
| M5-01 미구현 T-H2 reader 소유권 누락 | 현재 bundle 구현이 없음을 명시하고 PR-004가 collector module, device writer, EPP/CC/IAG diagnosis reader, observer writer와 T-H2 상태 동기화를 모두 소유하도록 지정했다. |
| M5-02 로드맵 §9 결정 5번 누락 | 실장비 write 시점별 사람 승인을 U-09로 추가하고 본 read-only 계획에는 영향이 없지만 M3 write를 계속 차단하도록 했다. |
| M5-03 비정본 L4 계층 명칭 | `L4`를 제거하고 ARCHITECTURE.md의 L0~L3 밖에 있는 번호 없는 Apps/MCP transport 조립 표면으로 교정했다. |
| INCIDENT-01 dirty checkout 검증 부작용 | Claude의 `pnpm test`가 기존 사용자 PPTX를 재생성했음을 기록하고 전체 test/build/smoke를 clean task-owned implementation worktree에서만 실행하도록 고정했다. |

- 독립 Claude 재검토 6차 (`task_c8358297ae4b`, 기준 커밋 `11c59e9`): **CRITICAL 0 / HIGH 0 / MEDIUM 0 — APPROVE**

| 검증 항목 | 판정 |
|---|---|
| H5-01 alias 계약과 legacy 동결 | `observerOnlyAliases` 차집합·legacy 부분집합·`CC`/`Athena XDR`/`A-Sec` 회귀 계약이 현재 코드 동작과 일치해 CLOSED |
| M5-01 T-H2 구현 ownership | PR-004의 collector·device writer·진단 reader·observer writer·round-trip·카드 동기화 책임이 완결되어 CLOSED |
| M5-02 로드맵 결정 5번 | U-09 fail-closed 기본값과 M3 write 차단 범위가 로드맵과 일치해 CLOSED |
| M5-03 계층 명칭 | canonical L0~L3 밖의 번호 없는 Apps/MCP surface로 교정되어 CLOSED |
| 검증 안전성 | test/build/smoke 없이 read-only machine check만 실행했고 사용자 PPTX와 live output이 검증 전후 보존됨 |
| 신규 적대적 탐색 | 새 CRITICAL/HIGH/MEDIUM 없음; 구현 시 PR-004 Change Budget의 sub-PR 분할 규칙을 준수할 것 |
