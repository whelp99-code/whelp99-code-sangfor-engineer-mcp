# M4 — HCI/SCP OpenAPI 실장비 관통 스파이크 (실행 런북)

> 목적: mock-verified 상태인 HCI create-volume 슬라이스를 **실장비 계약 대조 → read-only smoke → 단일 가역 write 관통 → 승격**까지 수행한다.
> 전제: HCI(aCMP) 어플라이언스 **존재 확인됨**(사용자 WebUI 자격증명 보유, 2026-07-02). OpenAPI 활성화·인증은 AI가 처리(사용자 지시).
> 원칙: 전 과정 [[Global Constraints]] 준수 — read-back oracle 전용, fail-closed, 시크릿 미커밋, 승격은 evidence 링크와 함께만.

## STATUS 2026-07-02 (VPN 연결 후 실행됨)
- **접속 확정:** OpenAPI 호스트 = **SCP 10.80.1.104:4430** (HCI .105 아님). admin / Itac123!@#.
- **Step 1-3 완료:** 인증 계약 **VERIFIED**(Keystone v2 passwordCredentials, provider 계약 일치) → read-only smoke 통과(compute 28 VM, image 0). 코드 수정 반영(volumev2 타입 해석, inventory 관대). 증적: `outputs/diagnosis/HCI_SCP_real_device_smoke_2026-07-02.md`, 재현: `scripts/hci-real-smoke.ts`.
- **Step 4-5 차단:** volume 서비스 **503(cinder 미배포)** → create-volume 실장비 write 불가. + write 가능한 compute는 실 프로덕션 VM 대상이라 **write 미수행**. `volume_create`=tested_mock 유지(field_verified 아님). **volume 서비스가 배포된 SCP 확보 시 Step 4-5 재개.**

## 시작 전 사용자에게 필요한 것 (블로커)

1. **FortiClient VPN 연결** — 사용자가 직접 Connect(비번 입력). 연결 후 AI가 `utun` 인터페이스 + HCI IP 도달성으로 검증.
2. **HCI 콘솔 IP** (예: `10.80.1.x`) — EPP/CC/IAG(.106–.108)와 별개. 미확인.
3. **HCI WebUI 자격증명** — 사용자 보유. AI에 전달(또는 aside-browser 로그인 시 입력). EPP/CC/IAG용 `Itac123!@#` 계열과 다를 수 있음.

## Step 1 — WebUI 접속 + OpenAPI 활성 확인 (read-only, aside-browser)

- `aside-browser`로 `https://{hci_ip}` 로그인(자체서명 인증서 통과). HCI(aCMP)는 ExtJS/Vue 혼재 가능 — snapshot 우선.
- **OpenAPI(OpenStack 호환) 활성 여부 확인:** aCMP는 기본적으로 OpenAPI가 꺼져 있을 수 있음. 관리 콘솔에서 "OpenAPI / Open API / 3rd-party access / OpenStack" 류 메뉴를 찾아 **활성화 상태와 tenant(project) 계정 존재를 확인**. 없으면 사용자에게 "WebUI에서 OpenAPI 활성화 + tenant 계정 발급"을 요청(설정 변경은 사람 몫).
- Keystone 엔드포인트 확정: 문서 계약상 `https://{hci_ip}/openstack/identity/v2.0`. 실제 base가 다르면 기록.

## Step 2 — 인증 계약 대조 (read-only, 1회 호출)

- 실장비에 Keystone 토큰 요청을 1회 수행(read-only):
  `POST https://{hci_ip}/openstack/identity/v2.0/tokens` body `{auth:{tenantName, passwordCredentials:{username,password}}}`.
  - aside-browser의 cookie-bearing `fetch()` 또는 `scripts/`에 일회성 probe 스크립트(자격증명은 env로만, 커밋 금지).
- **응답을 `data/hci-api/catalog.json` + `KeystoneV2TokenProvider` 계약과 대조:**
  - `access.token.id` / `access.token.tenant.id` / `access.serviceCatalog[].{type,endpoints[0].publicURL}` 존재·형태 일치 여부.
  - 불일치 시 `packages/sangfor-hci-client/src/token-provider.ts`를 실측에 맞춰 수정(예: v3 인증, 헤더명, catalog 구조). **일치할 때까지 write 금지.**
- 성공 시 `HCI_AUTH_CONTRACT_STATUS`를 `verified_on_{hci_ip}_{YYYY-MM-DD}`로 승격(`token-provider.ts` 상수 + `data/hci-api/catalog.json` `source.contractStatus`). 코딩은 Sonnet 에이전트에 위임(정확 스펙 제공) 후 Fable 리뷰.

## Step 3 — read-only smoke (실장비)

- `SANGFOR_HCI_IDENTITY_URL=https://{hci_ip}/openstack/identity/v2.0`, `SANGFOR_HCI_TENANT/USER/PASSWORD`(env, 미커밋) 설정.
- `sangfor.hci_inventory` 실행 → serviceCatalog 해석 + `GET /volumes/detail` 안정 동작(토큰 자동갱신 포함) 확인.
- `sangfor.hci_health_report` 실행 → 실 인벤토리 기반 한국어 리포트 산출.

## Step 4 — 단일 가역 write 관통 (유지보수 윈도우, 사람 입회)

1. `data/safety/capability-safety.json`의 `HCI_SCP/volume_create`를 `auto_allowed`로 승격 — **evidence=이 스파이크 캡처 로그 경로**. `volume_delete`는 복원용이므로 승격하되 http-bridge 원격 삭제는 여전히 차단.
2. `SANGFOR_ALLOW_REAL_EXECUTION=true` (윈도우 동안만), `SANGFOR_OPERATOR_APPROVAL_SECRET` + `SANGFOR_CHANGE_LEDGER_SECRET` 설정.
3. `scripts/mint-hci-approval.ts`로 `--type hci.create-volume --target {hci_ip}:{name}` 승인 발급.
4. `sangfor.hci_apply_create_volume`(작은 테스트 볼륨, 고유 clientToken) → 상태기계 → **read-back PASS 시에만 SUCCEEDED**. quota/모호 시 FAILED_HALT 확인(false-pass 0).
5. `sangfor.hci_delete_volume`(대상 volumeId 바인딩 승인)로 **복원** → `getVolume` 404 확인.
6. `data/evidence/change-runs/{runId}.jsonl` keyed 체인 verify + 마스킹 확인.

## Step 5 — 승격 (evidence 필수)

- `data/competency/capability-maturity.json`의 `HCI_SCP/volume_create`를 `tested_mock` → **`field_verified`**로 승격, evidence=Step 4 원장 경로.
- `sangfor.field_engineer_coverage` 재실행 → 정직한 대체율 갱신(교집합 automatable AND field_verified).
- `docs/DEVICE_DIAGNOSIS_RUNBOOK.md`에 HCI 실장비 버전·엔드포인트 진실표 반영.

## Exit Criteria (제안서 §5 실장비판)

① 멱등(같은 clientToken 중복생성 0) ② 실장비 read-only smoke 안정 ③ fail-closed 실증(모호/쿼터 시 halt) ④ 사람 개입 0회 apply→read-back verify→복원 완주 ⑤ false-pass 0. 전부 충족 시에만 field_verified 승격.

## Janus(SCP) 주의

SCP는 `/janus/v2/public-key` + `/janus/v2/login` 별도 인증 — **이 스파이크 범위 아님**(catalog `scpJanus.status=capture_gated`). HCI(aCMP) OpenAPI 관통 성공 후 별도 캡처.

## 코딩 위임 규칙 (2026-07-02 확정)

opencode는 이 환경에서 고장(FSEvents 행업). 코드 변경은 **Sonnet general-purpose 에이전트에 정확 스펙 위임 → Fable 리뷰**. opencode 환경 수리 시 복귀. [[opencode-execution-m0-m2-2026-07]]
